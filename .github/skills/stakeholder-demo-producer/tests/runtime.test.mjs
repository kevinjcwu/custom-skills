import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { execCapture, groupAlive, groupMembers, ProcRegistry, procStartTime } from "../scripts/lib/proc-registry.mjs";
import { checkToolchain, download, gitBlobSha1, hostPrerequisites, installToolchain, requireTools } from "../scripts/lib/toolchain.mjs";
import { makeTempDir, runSdp, SKILL_ROOT } from "./helpers.mjs";

const ENV = { PATH: "/usr/bin:/bin" };

function alive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

test("registry stops an owned process group including grandchildren", async () => {
	const registry = new ProcRegistry();
	// Parent prints its grandchild's pid, then both idle.
	const script = 'const c=require("child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});console.log(c.pid);setInterval(()=>{},1000)';
	const entry = registry.spawn("tree", process.execPath, ["-e", script], { env: ENV });
	const grandchild = Number(await new Promise((resolve) => entry.child.stdout.once("data", resolve)));
	assert.ok(registry.isOwnedAlive("tree"));
	assert.ok(alive(grandchild));
	assert.equal(procStartTime(entry.pid), entry.startTime);

	const result = await registry.stop("tree", 2000);
	assert.equal(result.result, "terminated");
	assert.equal(alive(grandchild), false);
	assert.deepEqual(registry.survivors(), []);
	assert.deepEqual(registry.records.map((record) => record.event), ["spawn", "stop"]);
});

test("a group whose last zombie is reaped between the probe and the /proc scan is gone, not alive", () => {
	// The probe still sees the zombie, then its reaper removes it before /proc is read.
	const probes = [true, false];
	const probe = () => probes.shift();
	assert.equal(groupAlive(4242, { probe, members: () => [] }), false);
	// An empty scan with a group that still answers (another pid namespace) stays alive.
	assert.equal(groupAlive(4242, { probe: () => true, members: () => [] }), true);
	assert.equal(groupAlive(4242, { probe: () => false, members: () => [] }), false);
	assert.equal(groupAlive(4242, { probe: () => true, members: () => [{ pid: 1, state: "Z" }] }), false);
	assert.equal(groupAlive(4242, { probe: () => true, members: () => [{ pid: 1, state: "S" }] }), true);
});

test("an unreaped zombie member does not keep a stopped group alive", async () => {
	const registry = new ProcRegistry();
	// The leader execs into sleep and never reaps its backgrounded child.
	const entry = registry.spawn("zombie", "/bin/sh", ["-c", "/bin/true & exec /bin/sleep 30"], { env: ENV });
	let members = [];
	for (let i = 0; i < 100 && !members.some((m) => m.state === "Z"); i++) {
		await new Promise((resolve) => setTimeout(resolve, 20));
		members = groupMembers(entry.pid);
	}
	assert.ok(members.some((m) => m.state === "Z" && m.pid !== entry.pid));
	assert.ok(members.some((m) => m.state !== "Z" && m.pid === entry.pid));

	const result = await registry.stop("zombie", 2000);
	assert.equal(result.result, "terminated");
	assert.deepEqual(registry.survivors(), []);
});

test("a tracked descendant that led its own group is stopped with its group even after the leader exited", async () => {
	const registry = new ProcRegistry();
	// A detached worker (its own group leader) starts a grandchild in its group, then exits when its stdin closes.
	const script = 'const c=require("child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});console.log(c.pid);process.stdin.on("end",()=>process.exit(0));process.stdin.resume()';
	const leader = spawn(process.execPath, ["-e", script], { env: ENV, stdio: ["pipe", "pipe", "ignore"], detached: true });
	const grandchild = Number(await new Promise((resolve) => leader.stdout.once("data", resolve)));
	try {
		registry.trackDescendant("late", leader.pid);
		const exited = new Promise((resolve) => leader.once("exit", resolve));
		leader.stdin.end();
		await exited;
		assert.ok(alive(grandchild));
		assert.deepEqual(registry.survivors(), ["late"], "the group outlives its leader and is reported");

		const result = await registry.stop("late", 2000);
		assert.equal(result.result, "terminated", JSON.stringify(result));
		assert.equal(alive(grandchild), false);
		assert.deepEqual(registry.survivors(), []);
	} finally {
		try {
			process.kill(grandchild, "SIGKILL");
		} catch {
			// already stopped
		}
	}
});

test("registry escalates to SIGKILL when SIGTERM is ignored", async () => {
	const registry = new ProcRegistry();
	const entry = registry.spawn("stubborn", process.execPath, ["-e", 'process.on("SIGTERM",()=>{});console.log("ready");setInterval(()=>{},1000)'], { env: ENV });
	await new Promise((resolve) => entry.child.stdout.once("data", resolve));
	const result = await registry.stop("stubborn", 300);
	assert.equal(result.result, "killed");
	assert.deepEqual(registry.survivors(), []);
	assert.equal((await registry.stop("never-started")).result, "not-owned");
});

test("execCapture enforces its timeout and kills the child", async () => {
	const result = await execCapture(process.execPath, ["-e", "setInterval(()=>{},1000)"], { env: ENV, timeoutMs: 200 });
	assert.equal(result.timedOut, true);
	assert.notEqual(result.code, 0);
	const ok = await execCapture(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"], { env: ENV, input: "echo" });
	assert.equal(ok.code, 0);
	assert.equal(ok.stdout, "echo");
});

test("gitBlobSha1 matches git's blob identity", () => {
	assert.equal(gitBlobSha1(Buffer.from("hello\n")), "ce013625030ba8dba906f756967f9e9ca394464a");
});

test("downloads are accepted only with the pinned size and sha256", async (t) => {
	const body = Buffer.from("pinned payload\n");
	const server = http.createServer((request, response) => response.end(body));
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => server.close());
	const url = `http://127.0.0.1:${server.address().port}/item`;
	const { dir, cleanup } = makeTempDir();
	t.after(cleanup);
	const sha256 = createHash("sha256").update(body).digest("hex");

	const part = await download(url, path.join(dir, "ok"), { size: body.length, sha256 });
	assert.equal(fs.readFileSync(part, "utf8"), "pinned payload\n");
	await assert.rejects(download(url, path.join(dir, "bad"), { size: body.length, sha256: "0".repeat(64) }), /pinned identity mismatch/);
	await assert.rejects(download(url, path.join(dir, "big"), { size: 3, sha256 }), /larger than the pinned size/);
	assert.equal(fs.existsSync(path.join(dir, "bad.part")), false);
});

test("an empty runtime directory is reported missing, never ready", (t) => {
	const { dir, cleanup } = makeTempDir();
	t.after(cleanup);
	const result = checkToolchain(dir, ENV);
	assert.equal(result.ready, false);
	assert.ok(result.items.length > 10);
	assert.ok(result.items.every((item) => item.status === "missing"));
	assert.equal(requireTools(["ffmpeg"], dir).ok, false);
});

test("setup readiness needs only narration, browser and export tools: no audio daemon, network-namespace tool or host audio clients", async (t) => {
	const { dir, cleanup } = makeTempDir();
	t.after(cleanup);
	// A PATH with no host commands at all.
	const bare = { PATH: dir };
	assert.deepEqual(hostPrerequisites(bare).map((item) => item.need), ["install", "install"], "host commands are needed only to install");
	const lock = JSON.parse(fs.readFileSync(path.join(SKILL_ROOT, "runtime", "tool-lock.json"), "utf8"));
	const withHost = checkToolchain(undefined, ENV);
	const withoutHost = checkToolchain(undefined, bare);
	for (const result of [withHost, withoutHost]) {
		assert.deepEqual(result.items.filter((item) => /pulse|slirp|pactl|pacat|parec/i.test(item.id)), [], JSON.stringify(result.items.map((item) => item.id)));
		assert.equal(result.voice, undefined);
	}
	assert.doesNotMatch(JSON.stringify(lock), /pulseaudio|slirp4netns|libpulse/i, "the tool lock pins no voice-route or strict-network packages");
	assert.equal(withoutHost.ready, withHost.ready, "host commands do not change readiness");
	if (requireTools(["ffmpeg"]).ok) {
		assert.equal(withoutHost.ready, true, "an installed toolchain is ready without any host commands");
	}

	const refused = await installToolchain({ root: path.join(dir, "runtime"), env: bare });
	assert.equal(refused.installed, false);
	assert.match(refused.blocked, /missing host commands: dpkg-deb, uv$/, "only install-time commands can refuse the install");
	assert.equal(fs.existsSync(path.join(dir, "runtime")), false, "nothing was installed");
});

test("sdp setup: usage errors exit 2 and an unprovisioned runtime is blocked (exit 3)", async (t) => {
	assert.equal((await runSdp(["setup"])).code, 2);
	assert.equal((await runSdp(["setup", "check", "extra"])).code, 2);
	const { dir, cleanup } = makeTempDir();
	t.after(cleanup);
	const result = await runSdp(["setup", "check"], { env: { ...ENV, SDP_RUNTIME_DIR: path.join(dir, "runtime with space") } });
	assert.equal(result.code, 3);
	assert.equal(result.json.ready, false);
});

test("the inventory-recon fixture's own tests pass under this runtime", () => {
	const root = path.join(SKILL_ROOT, "fixtures", "inventory-recon");
	const result = spawnSync(process.execPath, ["--test", "test/*.test.mjs"], { cwd: root, encoding: "utf8", env: ENV, timeout: 120000 });
	assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
	assert.match(result.stdout, /^ℹ fail 0$/m);
});
