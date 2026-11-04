import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { contentSha256 } from "../scripts/lib/canonical.mjs";
import { discover } from "../scripts/lib/discover.mjs";
import { cliApiScenario, FIXTURE_REPOS, makeTempDir, runSdp, SKILL_ROOT, writeJson } from "./helpers.mjs";

const MOVED = { capture: "sdp run", browser: "sdp run", narrate: "sdp produce", tts: "sdp produce", captions: "sdp produce", mux: "sdp produce" };

test("help, usage errors and unknown commands", async () => {
	const help = await runSdp(["--help"]);
	assert.equal(help.code, 0);
	assert.match(help.json.usage, /not implemented \(exit 3\)/);
	assert.equal((await runSdp([])).code, 2);
	const unknown = await runSdp(["deploy"]);
	assert.equal(unknown.code, 2);
	assert.equal(unknown.json.error.code, "usage");
	assert.equal((await runSdp(["discover"])).code, 2, "missing --root");
	assert.equal((await runSdp(["discover", "--root", ".", "--bogus", "1"])).code, 2);
	assert.equal((await runSdp(["discover", "--root", ".", "--max-files", "-1"])).code, 2);
	assert.equal((await runSdp(["discover", "--root"])).code, 2);
});

test("the package has no voice, network-namespace or review commands; former media stubs point to the command that does the work", async () => {
	for (const command of ["voice", "review", "netns-check", "review-loopback-check"]) {
		const result = await runSdp([command]);
		assert.equal(result.code, 2, command);
		assert.match(result.json.error.message, /unknown command/, command);
	}
	assert.equal((await runSdp(["calibrate", "--scope", "route"])).code, 2, "no audio-route calibration");
	for (const [command, replacement] of Object.entries(MOVED)) {
		const result = await runSdp([command]);
		assert.equal(result.code, 2, command);
		assert.ok(result.json.error.message.includes(replacement), command);
	}
});

test("produce checks its inputs before touching any tool", async (t) => {
	assert.equal((await runSdp(["produce", "--calibration", "c.json"])).code, 2, "missing --run");
	assert.equal((await runSdp(["export", "--run", "r"])).code, 2, "export is an alias and needs --calibration");
	const temp = makeTempDir();
	t.after(temp.cleanup);
	const missing = await runSdp(["produce", "--run", temp.dir, "--calibration", path.join(temp.dir, "c.json")]);
	assert.equal(missing.code, 1, "a directory without a recorded storyboard is not a run");
	assert.equal(missing.json.error.code, "read-failed");
});

test("discover, validate and hash", async (t) => {
	const temp = makeTempDir();
	t.after(temp.cleanup);
	const out = path.join(temp.dir, "catalog.json");
	const root = path.join(FIXTURE_REPOS, "static-web");
	const discovered = await runSdp(["discover", "--root", root, "--label", "static-web", "--out", out]);
	assert.equal(discovered.code, 0);
	assert.deepEqual(JSON.parse(fs.readFileSync(out, "utf8")), discovered.json);
	assert.equal(discovered.stdout.includes(root), false, "catalogs never contain the target's absolute path");
	assert.equal(discovered.stdout.includes("sentinel-example-value"), false, "config example values are never read into the catalog");

	const again = await runSdp(["discover", "--root", root, "--out", out]);
	assert.equal(again.code, 1);
	assert.equal(again.json.error.code, "write-failed");

	const valid = await runSdp(["validate", out]);
	assert.equal(valid.code, 0);
	assert.equal(valid.json.contract, "capability-catalog");
	const hashed = await runSdp(["hash", out]);
	assert.equal(hashed.json.sha256, contentSha256(discovered.json));
	assert.equal(valid.json.sha256, hashed.json.sha256);

	const broken = writeJson(path.join(temp.dir, "broken.json"), { ...discovered.json, evidence: "nope" });
	const invalid = await runSdp(["validate", broken]);
	assert.equal(invalid.code, 1);
	assert.equal(invalid.json.valid, false);
	const unknown = writeJson(path.join(temp.dir, "unknown.json"), { schema: "other.v9" });
	assert.equal((await runSdp(["validate", unknown])).code, 1);
	assert.equal((await runSdp(["validate", path.join(temp.dir, "missing.json")])).code, 1);
});

test("preflight and run exit codes", async (t) => {
	const temp = makeTempDir();
	t.after(temp.cleanup);
	const scenario = cliApiScenario({ dir: temp.dir, discover });
	const files = {
		catalog: writeJson(path.join(temp.dir, "catalog.json"), scenario.catalog),
		storyboard: writeJson(path.join(temp.dir, "storyboard.json"), scenario.storyboard),
		authorization: writeJson(path.join(temp.dir, "authorization.json"), scenario.authorization),
	};
	const triple = ["--catalog", files.catalog, "--storyboard", files.storyboard, "--authorization", files.authorization];
	const ready = await runSdp(["preflight", ...triple]);
	assert.equal(ready.code, 0);
	assert.equal(ready.json.verdict, "ready");

	assert.equal((await runSdp(["run", ...triple])).code, 2, "confirmation is required");
	const mismatch = await runSdp(["run", ...triple, "--confirm-authorization-sha256", "f".repeat(64)]);
	assert.equal(mismatch.code, 1);
	assert.equal(mismatch.json.error.code, "confirmation-mismatch");
	assert.deepEqual(fs.readdirSync(scenario.runDir), []);

	const blockedAuthorization = { ...scenario.authorization, bindings: { ...scenario.authorization.bindings, runDir: path.join(temp.dir, "absent") } };
	writeJson(files.authorization, blockedAuthorization);
	const blocked = await runSdp(["preflight", ...triple]);
	assert.equal(blocked.code, 3);
	const blockedRun = await runSdp(["run", ...triple, "--confirm-authorization-sha256", contentSha256(blockedAuthorization)]);
	assert.equal(blockedRun.code, 3);
	assert.equal(blockedRun.json.error.code, "preflight-blocked");

	writeJson(files.authorization, { ...scenario.authorization, storyboardSha256: "0".repeat(64) });
	assert.equal((await runSdp(["preflight", ...triple])).code, 1, "invalid contract");
});

test("the CLI runs when the skill folder path contains a space", async (t) => {
	const temp = makeTempDir();
	t.after(temp.cleanup);
	const copy = path.join(temp.dir, "portable skill");
	for (const part of ["scripts", "schemas"]) {
		fs.cpSync(path.join(SKILL_ROOT, part), path.join(copy, part), { recursive: true });
	}
	const run = (args) => spawnSync(process.execPath, [path.join(copy, "scripts", "sdp.mjs"), ...args], { encoding: "utf8", env: {}, stdio: ["ignore", "pipe", "pipe"] });
	const help = run(["--help"]);
	assert.equal(help.status, 0);
	assert.match(JSON.parse(help.stdout).usage, /discover/);
	const voice = run(["voice"]);
	assert.equal(voice.status, 2);
	assert.equal(JSON.parse(voice.stdout).ok, false);
});
