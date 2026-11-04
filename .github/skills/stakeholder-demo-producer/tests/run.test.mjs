import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { contentSha256, sha256Hex } from "../scripts/lib/canonical.mjs";
import { validateContract, validateEventStream } from "../scripts/lib/contracts.mjs";
import { discover } from "../scripts/lib/discover.mjs";
import { readEvents } from "../scripts/lib/events.mjs";
import { verifyManifestFiles } from "../scripts/lib/manifest.mjs";
import { runDemo } from "../scripts/lib/run.mjs";
import { startService } from "../scripts/lib/browser-adapter.mjs";
import { ProcRegistry } from "../scripts/lib/proc-registry.mjs";
import { BEHAVE, cliApiScenario, makeTempDir, rechain, SKILL_ROOT, startFixtureServer } from "./helpers.mjs";

/* global AbortController */

function confirm(scenario) {
	return contentSha256(scenario.authorization);
}

function setup(t, options = {}) {
	const temp = makeTempDir();
	t.after(temp.cleanup);
	return { temp, scenario: cliApiScenario({ dir: temp.dir, discover, ...options }) };
}

/**
 * Replaces the scenes with one process scene of behave.mjs actions.
 * @param {Array<{id: string, argv: string[], expect?: object[], env?: object[], envPassthrough?: string[]}>} steps
 */
function behaveScenario(t, steps, limits = {}) {
	const { temp, scenario } = setup(t);
	fs.mkdirSync(path.join(scenario.targetRoot, "tools"));
	fs.copyFileSync(BEHAVE, path.join(scenario.targetRoot, "tools", "behave.mjs"));
	scenario.catalog = discover(scenario.targetRoot, { label: "cli-api fixture" });
	scenario.storyboard.claims = [
		{ id: "claim.readme", text: "The project documents its commands", class: "documented", evidence: ["ev.readme.md"], demonstratedBy: [] },
	];
	scenario.storyboard.scenes = [
		{
			id: "scene.behave",
			title: "Process behaviour",
			adapter: "process",
			capabilities: [],
			dataProvenance: ["data.synthetic"],
			actions: steps.map((step) => ({ id: step.id, op: "run", ref: `cmd.${step.id}` })),
			expect: steps.flatMap((step) => (step.expect ?? []).map((item, index) => ({ id: `exp.${step.id}.${index}`, action: step.id, ...item }))),
			narration: ["business", "engineering"].map((audience) => ({
				id: `nar.${audience}`,
				audience,
				text: "The readme documents the commands.",
				claims: ["claim.readme"],
				caption: { source: "narration-text", provenance: "agent-drafted" },
			})),
		},
	];
	scenario.authorization.commands = steps.map((step) => ({
		id: `cmd.${step.id}`,
		executable: "node",
		argv: ["tools/behave.mjs", ...step.argv],
		cwd: ".",
		env: step.env ?? [],
		envPassthrough: step.envPassthrough ?? [],
	}));
	Object.assign(scenario.authorization.limits, limits);
	rechain(scenario);
	return { temp, scenario };
}

const read = (runPath, rel) => fs.readFileSync(path.join(runPath, ...rel.split("/")), "utf8");

function allRunText(runPath) {
	return fs
		.readdirSync(runPath, { recursive: true })
		.map(String)
		.filter((rel) => fs.statSync(path.join(runPath, rel)).isFile())
		.map((rel) => fs.readFileSync(path.join(runPath, rel), "utf8"))
		.join("\n");
}

test("a run needs an explicit, well-formed, matching confirmation", async (t) => {
	const { scenario } = setup(t);
	await assert.rejects(runDemo({ ...scenario }), (error) => error.code === "usage" && error.exitCode === 2);
	await assert.rejects(runDemo({ ...scenario, confirmAuthorizationSha256: "ABC" }), (error) => error.code === "usage");
	await assert.rejects(
		runDemo({ ...scenario, confirmAuthorizationSha256: "0".repeat(64) }),
		(error) => error.code === "confirmation-mismatch" && error.exitCode === 1,
	);
	// An approval record is informational: it never stands in for the confirmation.
	scenario.authorization.approvalRecord = { approvedBy: "someone", approvedAt: "2025-01-01T00:00:00Z" };
	await assert.rejects(runDemo({ ...scenario }), (error) => error.code === "usage");
	assert.deepEqual(fs.readdirSync(scenario.runDir), []);
});

test("edited contracts break the hash chain before anything runs", async (t) => {
	const { scenario } = setup(t);
	const approved = confirm(scenario);
	scenario.storyboard.goal = "edited after approval";
	await assert.rejects(runDemo({ ...scenario, confirmAuthorizationSha256: approved }), (error) => error.code === "invalid-contract");
	assert.deepEqual(fs.readdirSync(scenario.runDir), []);
});

test("process and loopback HTTP scenes run with events, hashes and no binding leaks", async (t) => {
	const { origin } = await startFixtureServer(t);
	const { scenario } = setup(t, { origin });
	const result = await runDemo({ ...scenario, confirmAuthorizationSha256: confirm(scenario), runId: "happy" });
	assert.equal(result.status, "completed", JSON.stringify(result.manifest.failures));
	assert.deepEqual(validateContract("artifact-manifest", result.manifest), []);
	assert.equal(result.manifestSha256, contentSha256(JSON.parse(read(result.runPath, "manifest.json"))));
	assert.ok(verifyManifestFiles(result.runPath, result.manifest).every((check) => check.status === "pass"));

	const events = readEvents(path.join(result.runPath, "events.jsonl"));
	assert.deepEqual(validateEventStream(events, "happy"), []);
	assert.equal(events[0].type, "run.start");
	assert.equal(events.at(-1).type, "run.end");
	const verified = events.filter((event) => event.type === "evidence.verified").map((event) => event.data.contract);
	assert.deepEqual(verified, ["capability-catalog", "storyboard", "run-authorization", "target-content", "catalog-evidence", "catalog-evidence"]);
	assert.deepEqual(
		events.filter((event) => event.type === "action.end").map((event) => [event.actionId, event.disposition]),
		[["act.tally", "ok"], ["act.items", "ok"]],
	);

	assert.equal(read(result.runPath, "scenes/scene.tally/act.tally.attempt-1.stdout"), "2 items: alpha, beta\n");
	assert.match(read(result.runPath, "scenes/scene.items/act.items.attempt-1.body"), /alpha/);
	for (const artifact of result.manifest.artifacts) {
		assert.equal(sha256Hex(fs.readFileSync(path.join(result.runPath, ...artifact.path.split("/")))), artifact.sha256);
	}
	const text = allRunText(result.runPath);
	for (const value of [scenario.targetRoot, scenario.runDir, result.runPath, process.execPath]) {
		assert.equal(text.includes(value), false, "run outputs must not contain approved binding values");
	}
	assert.equal(fs.existsSync(path.join(scenario.targetRoot, "EXECUTED-MARKER")), false, "only authorized commands run");

	await assert.rejects(
		runDemo({ ...scenario, confirmAuthorizationSha256: confirm(scenario), runId: "happy" }),
		(error) => error.code === "run-exists",
	);
});

test("binding values printed by a process are redacted and recorded", async (t) => {
	const { scenario } = behaveScenario(t, [{ id: "act.cwd", argv: ["cwd"], expect: [{ check: "exitCode", value: 0 }] }]);
	const result = await runDemo({ ...scenario, confirmAuthorizationSha256: confirm(scenario), runId: "redact" });
	assert.equal(result.status, "completed");
	assert.equal(read(result.runPath, "scenes/scene.behave/act.cwd.attempt-1.stdout"), "<binding:targetRoot>\n");
	assert.deepEqual(
		result.manifest.transformations.map((item) => [item.artifact, item.kind]),
		[
			["contracts/authorization.json", "redact-bindings"],
			["scenes/scene.behave/act.cwd.attempt-1.stdout", "redact-bindings"],
		],
	);
	assert.ok(!read(result.runPath, "contracts/authorization.json").includes(scenario.authorization.bindings.targetRoot));
});

test("only literal and passthrough environment values reach the process", async (t) => {
	const { scenario } = behaveScenario(t, [
		{
			id: "act.env",
			argv: ["env", "VISIBLE", "PASSED", "PARENT_SECRET"],
			env: [{ name: "VISIBLE", value: "shown" }],
			envPassthrough: ["PASSED"],
			expect: [
				{ check: "stdoutIncludes", value: "VISIBLE=shown" },
				{ check: "stdoutIncludes", value: "PASSED=from-parent" },
				{ check: "stdoutIncludes", value: "PARENT_SECRET=<unset>" },
			],
		},
	]);
	const parentEnv = { PASSED: "from-parent", PARENT_SECRET: "parent-secret-sentinel-0001" };
	const result = await runDemo({ ...scenario, confirmAuthorizationSha256: confirm(scenario), runId: "env", parentEnv });
	assert.equal(result.status, "completed", JSON.stringify(result.manifest.failures));
	assert.equal(allRunText(result.runPath).includes("parent-secret-sentinel-0001"), false);
});

test("the first failure stops the run and later actions are skipped", async (t) => {
	const { scenario } = behaveScenario(t, [
		{ id: "act.fail", argv: ["exit", "3"], expect: [{ check: "exitCode", value: 0 }] },
		{ id: "act.after", argv: ["echo", "never"], expect: [{ check: "exitCode", value: 0 }] },
	]);
	const result = await runDemo({ ...scenario, confirmAuthorizationSha256: confirm(scenario), runId: "first-failure" });
	assert.equal(result.status, "failed");
	assert.deepEqual(result.manifest.failures.map((item) => [item.code, item.actionId]), [["action-failed", "act.fail"]]);
	const events = readEvents(path.join(result.runPath, "events.jsonl"));
	assert.ok(events.some((event) => event.type === "action.skipped" && event.actionId === "act.after"));
	assert.equal(fs.existsSync(path.join(result.runPath, "scenes/scene.behave/act.after.attempt-1.stdout")), false);
	assert.equal(events.at(-1).data.stopCondition, "first-failure");
});

test("bounded retries recover a flaky action; failed expectations use every attempt", async (t) => {
	const { scenario } = behaveScenario(t, [{ id: "act.flaky", argv: ["flaky", "../flaky-state"], expect: [{ check: "exitCode", value: 0 }] }], { retries: 1 });
	const result = await runDemo({ ...scenario, confirmAuthorizationSha256: confirm(scenario), runId: "flaky" });
	assert.equal(result.status, "completed");
	const attempts = readEvents(path.join(result.runPath, "events.jsonl")).filter((event) => event.type === "action.attempt");
	assert.deepEqual(attempts.map((event) => event.disposition), ["failed", "ok"]);

	const { scenario: always } = behaveScenario(t, [{ id: "act.bad", argv: ["exit", "1"], expect: [{ check: "exitCode", value: 0 }] }], { retries: 2 });
	const failed = await runDemo({ ...always, confirmAuthorizationSha256: confirm(always), runId: "always" });
	assert.equal(failed.status, "failed");
	assert.equal(readEvents(path.join(failed.runPath, "events.jsonl")).filter((event) => event.type === "action.attempt").length, 3);
});

test("timeouts and output limits stop the run without retrying", async (t) => {
	const { scenario } = behaveScenario(t, [{ id: "act.slow", argv: ["sleep", "20000"] }], { timeoutMs: 300, retries: 2 });
	const result = await runDemo({ ...scenario, confirmAuthorizationSha256: confirm(scenario), runId: "timeout" });
	assert.equal(result.status, "failed");
	assert.deepEqual(result.manifest.failures.map((item) => item.code), ["limit-exceeded"]);
	const events = readEvents(path.join(result.runPath, "events.jsonl"));
	assert.deepEqual(events.filter((event) => event.type === "action.attempt").map((event) => event.disposition), ["timeout"]);
	assert.ok(result.manifest.cleanup.some((item) => item.result === "terminated"));

	const { scenario: flood } = behaveScenario(t, [{ id: "act.flood", argv: ["flood", "200000"] }], { maxOutputBytes: 1024 });
	const limited = await runDemo({ ...flood, confirmAuthorizationSha256: confirm(flood), runId: "flood" });
	assert.deepEqual(limited.manifest.failures.map((item) => item.code), ["limit-exceeded"]);
	assert.ok(fs.statSync(path.join(limited.runPath, "scenes/scene.behave/act.flood.attempt-1.stdout")).size <= 1024);
});

test("cancellation stops the running process and records a cancelled run", async (t) => {
	const { scenario } = behaveScenario(t, [
		{ id: "act.wait", argv: ["sleep", "20000"] },
		{ id: "act.next", argv: ["echo", "never"] },
	]);
	const controller = new AbortController();
	const pending = runDemo({ ...scenario, confirmAuthorizationSha256: confirm(scenario), runId: "cancel", signal: controller.signal });
	await delay(300);
	controller.abort();
	const result = await pending;
	assert.equal(result.status, "cancelled");
	assert.deepEqual(result.manifest.failures.map((item) => item.code), ["cancelled"]);
	const events = readEvents(path.join(result.runPath, "events.jsonl"));
	assert.equal(events.at(-1).disposition, "cancelled");
	assert.ok(events.some((event) => event.type === "action.skipped" && event.actionId === "act.next"));
});

test("an HTTP redirect is blocked, not followed", async (t) => {
	const { origin } = await startFixtureServer(t);
	const { scenario } = setup(t, { origin });
	scenario.authorization.http.requests[0].path = "/redirect";
	scenario.authorization.limits.retries = 2;
	rechain(scenario);
	const result = await runDemo({ ...scenario, confirmAuthorizationSha256: confirm(scenario), runId: "redirect" });
	assert.equal(result.status, "failed");
	const attempts = readEvents(path.join(result.runPath, "events.jsonl")).filter((event) => event.actionId === "act.items" && event.type === "action.attempt");
	assert.deepEqual(attempts.map((event) => [event.disposition, event.data.outcome, event.data.status]), [["blocked", "redirect-blocked", 302]]);
});

test("a process that exits nonzero fails even when the storyboard states no expectations", async (t) => {
	const { scenario } = setup(t);
	scenario.storyboard.scenes[0].expect = [];
	scenario.authorization.commands[0].argv = ["bin/tally.mjs", "not-a-command"];
	rechain(scenario);
	const result = await runDemo({ ...scenario, confirmAuthorizationSha256: confirm(scenario), runId: "nonzero" });
	assert.equal(result.status, "failed");
	assert.equal(result.manifest.failures[0].actionId, "act.tally");
	const events = readEvents(path.join(result.runPath, "events.jsonl"));
	assert.equal(events.find((event) => event.type === "action.attempt").disposition, "failed");
	const implicit = events.find((event) => event.type === "expect.result");
	assert.equal(implicit.data.expect, "implicit.exit-zero");
	assert.equal(implicit.disposition, "failed");
});

test("an adapter exception is recorded as a failure and the manifest is still written", async (t) => {
	const { scenario } = setup(t);
	scenario.authorization.commands[0].envPassthrough = ["SDP_TEST_VAR"];
	rechain(scenario);
	// A parent environment that throws when read makes the process adapter
	// throw mid-run; the run must still finalize its records.
	const throwing = new Proxy(
		{},
		{
			getOwnPropertyDescriptor() {
				throw new Error("boom");
			},
		},
	);
	const result = await runDemo({ ...scenario, confirmAuthorizationSha256: confirm(scenario), runId: "throws", parentEnv: throwing });
	assert.equal(result.status, "failed");
	assert.ok(fs.existsSync(path.join(result.runPath, "manifest.json")));
	const events = readEvents(path.join(result.runPath, "events.jsonl"));
	assert.equal(events.at(-1).type, "run.end");
	const attempt = events.find((event) => event.type === "action.attempt");
	assert.equal(attempt.data.outcome, "adapter-error");
	assert.ok(result.manifest.cleanup.some((item) => item.result === "failed"));
});

test("a wrapper helper may start the real server as its child: readiness and socket ownership follow the service's process tree", async (t) => {
	const temp = makeTempDir();
	t.after(temp.cleanup);
	const server = path.join(SKILL_ROOT, "scripts", "helpers", "static-server.mjs");
	fs.writeFileSync(path.join(temp.dir, "index.html"), "<p>wrapped</p>");
	// Starts the server as a child and relays its ready line, rewritten by mode.
	const wrapper = path.join(temp.dir, "wrapper.mjs");
	fs.writeFileSync(
		wrapper,
		`import { spawn } from "node:child_process";
const mode = process.argv[2];
const child = spawn(process.execPath, [${JSON.stringify(server)}, ${JSON.stringify(temp.dir)}], { stdio: ["ignore", "pipe", "inherit"], detached: mode === "escape" });
let text = "";
child.stdout.on("data", (chunk) => {
	text += chunk;
	if (!text.includes("\\n")) return;
	const doc = JSON.parse(text.split("\\n")[0]);
	if (mode === "no-pid") delete doc.pid;
	if (mode === "stranger") doc.pid = process.ppid;
	process.stdout.write(JSON.stringify(doc) + "\\n");
	child.stdout.removeAllListeners("data");
	child.stdout.resume();
});
// A detached side process that is not the listener.
if (mode === "sidecar") spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", detached: true }).unref();
// No cooperative cleanup: stopping the wrapper alone must not be relied on.
setInterval(() => {}, 1000);
`,
	);
	const start = async (mode) => {
		const registry = new ProcRegistry();
		t.after(() => registry.stopAll(500));
		const result = await startService({ registry, id: `svc-${mode}`, executable: process.execPath, argv: [wrapper, mode], cwd: temp.dir, env: { PATH: "/usr/bin:/bin" }, readyTimeoutMs: 10000, maxOutputBytes: 65536 });
		return { result, registry };
	};

	for (const mode of ["child-pid", "no-pid"]) {
		const { result, registry } = await start(mode);
		assert.equal(result.ok, true, `${mode}: ${result.error}`);
		assert.notEqual(result.listenerPid, result.pid, "the socket belongs to the wrapper's child");
		const page = await fetch(`${result.origin}/index.html`);
		assert.match(await page.text(), /wrapped/);
		await registry.stop(`svc-${mode}`, 1000);
		await assert.rejects(fetch(`${result.origin}/index.html`), "stopping the service's process group also stops the child server");
	}

	const stranger = (await start("stranger")).result;
	assert.equal(stranger.ok, false);
	assert.match(stranger.error, /neither the started service nor one of its child processes/);

	for (const [mode, error] of [["escape", /listening process left the service's process group/], ["sidecar", /a process the service started left its process group/]]) {
		const { result, registry } = await start(mode);
		assert.equal(result.ok, false, mode);
		assert.match(result.error, error);
		// The detached process was found, registered and stopped, not left running.
		const escaped = result.stopped.filter((item) => item.id.startsWith(`svc-${mode}-escaped-`));
		assert.ok(escaped.length >= 1, JSON.stringify(result.stopped));
		for (const item of escaped) {
			assert.match(item.result, /terminated|killed|exited/, JSON.stringify(item));
			const pid = Number(item.id.split("-").at(-1));
			assert.ok(!fs.existsSync(`/proc/${pid}`) || /^\S+ \(.*\) [ZX] /.test(fs.readFileSync(`/proc/${pid}/stat`, "utf8")), `pid ${pid} still running`);
		}
		assert.deepEqual(registry.survivors(), []);
	}
});
