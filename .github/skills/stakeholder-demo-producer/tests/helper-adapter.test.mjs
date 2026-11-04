// Run-local interaction helper plumbing, exercised with a SYNTHETIC helper
// (tests/helpers.mjs SYNTHETIC_HELPER). These tests prove protocol, limits,
// media checks, provenance and cleanup only; no real app, voice or device.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { HELPER_LIMITS, runHelper } from "../scripts/lib/helper-adapter.mjs";
import { ProcRegistry } from "../scripts/lib/proc-registry.mjs";
import { makeTempDir, SYNTHETIC_HELPER, SYNTHETIC_PAGE_SCRIPT, syntheticInteraction } from "./helpers.mjs";

/* global AbortController */

/** A stand-in for the recorded page: records what it was asked to evaluate. */
function fakePage({ hang = false } = {}) {
	const calls = [];
	return {
		calls,
		evaluate(expression) {
			calls.push(expression);
			return hang ? new Promise(() => {}) : Promise.resolve({ added: "Helper line: hello" });
		},
	};
}

function setup(t) {
	const temp = makeTempDir();
	t.after(temp.cleanup);
	const helper = path.join(temp.dir, "synthetic-helper.mjs");
	fs.writeFileSync(helper, SYNTHETIC_HELPER);
	const registry = new ProcRegistry();
	t.after(() => registry.stopAll(500));
	let attempt = 0;
	const run = async (mode, { interaction = syntheticInteraction(mode), page = fakePage(), timeoutMs = 10000, signal, env = { PATH: "/usr/bin:/bin" }, maxOutputBytes = 65536, now = () => performance.now() } = {}) => {
		attempt += 1;
		const outDir = path.join(temp.dir, `out-${attempt}`, "helper");
		fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
		const id = `helper-${attempt}`;
		const result = await runHelper({
			registry,
			id,
			executable: process.execPath,
			argv: [helper, mode],
			cwd: temp.dir,
			env,
			outDir,
			interaction,
			pageScripts: new Map([["say", SYNTHETIC_PAGE_SCRIPT]]),
			page,
			action: { id: "act.helper", value: "hello" },
			timeoutMs,
			killGraceMs: 500,
			maxOutputBytes,
			signal,
			now,
		});
		return { result, outDir, id, page };
	};
	return { temp, registry, run };
}

test("a helper that keeps the protocol gets its page script evaluated and its media checked and labelled from the approval", async (t) => {
	const { run, registry } = setup(t);
	const { result, page } = await run("ok");
	assert.equal(result.outcome, "done", JSON.stringify(result.error));
	assert.equal(result.claimed, "done");
	assert.equal(result.pageCalls, 1);
	assert.equal(page.calls.length, 1);
	assert.ok(page.calls[0].includes("Helper line: ") && page.calls[0].endsWith('("hello")'), "the approved script source runs with the JSON argument");
	assert.equal(result.media.length, 1);
	const [media] = result.media;
	assert.equal(media.role, "simulated-user");
	// The label and provenance come from the authorization, never from the helper.
	assert.equal(media.label, "Simulated user (synthetic test tone)");
	assert.equal(media.provenance, "generated");
	assert.ok(media.durationMs >= 590 && media.durationMs <= 610, String(media.durationMs));
	assert.equal(media.caption, "Hello there (synthetic test tone)");
	assert.deepEqual(result.transcript.map((line) => [line.dir, line.message?.type]), [["to-helper", "start"], ["from-helper", "page"], ["to-helper", "page-result"], ["from-helper", "result"]]);
	assert.deepEqual(registry.survivors(), []);
});

test("a helper gets exactly the explicit environment plus SDP_OUT_DIR, never the parent's", async (t) => {
	const { run } = setup(t);
	process.env.SDP_TEST_AMBIENT_SECRET = "must-not-leak";
	t.after(() => delete process.env.SDP_TEST_AMBIENT_SECRET);
	const { result } = await run("env", { env: { PATH: "/usr/bin:/bin", DEMO_MODE: "synthetic" } });
	assert.equal(result.outcome, "done");
	assert.deepEqual(result.detail.split(",").filter((name) => !["PWD", "SHLVL", "_"].includes(name)), ["DEMO_MODE", "PATH", "SDP_OUT_DIR"]);
});

test("a helper's own status is mapped, never upgraded: failed, blocked and unknown are not done", async (t) => {
	const { run } = setup(t);
	for (const [mode, outcome] of [["failed", "helper-failed"], ["blocked", "helper-blocked"], ["unknown", "helper-unknown"]]) {
		const { result } = await run(mode);
		assert.equal(result.outcome, outcome, mode);
		assert.equal(result.claimed, mode);
		assert.match(result.error.message, new RegExp(`reported ${mode}: synthetic ${mode}`));
		assert.deepEqual(result.media, []);
	}
});

test("protocol breaks fail the action: done with a nonzero exit, no result, non-JSON stdout, two results", async (t) => {
	const { run } = setup(t);
	const cases = [
		["done-exit-1", "helper-failed", /reported done but exited/],
		["no-result", "protocol-error", /without a result line/],
		["not-json", "protocol-error", /not JSON; stdout is reserved/],
		["two-results", "protocol-error", /more than one result/],
	];
	for (const [mode, outcome, message] of cases) {
		const { result } = await run(mode);
		assert.equal(result.outcome, outcome, mode);
		assert.match(result.error.message, message, mode);
	}
});

test("page access is limited to declared scripts and to helpers granted browser-page", async (t) => {
	const { run } = setup(t);
	const unknown = await run("unknown-script");
	assert.equal(unknown.result.outcome, "helper-failed");
	assert.match(unknown.result.detail, /unknown page script/);
	assert.deepEqual(unknown.page.calls, [], "an undeclared script is never evaluated");

	const ungranted = await run("page-only", { interaction: syntheticInteraction("page-only", { needs: [], pageScripts: [] }) });
	assert.equal(ungranted.result.outcome, "helper-failed");
	assert.match(ungranted.result.detail, /not granted browser-page/);
	assert.deepEqual(ungranted.page.calls, []);
});

test("unsafe or invalid media are rejected: parent paths, absolute paths, links, non-WAV, oversize, undeclared roles, outside the window, bad captions", async (t) => {
	const { run, temp } = setup(t);
	const cases = [
		["path-parent", /relative path inside SDP_OUT_DIR/],
		["path-absolute", /relative path inside SDP_OUT_DIR/],
		["symlink", /regular file inside SDP_OUT_DIR, not a link/],
		["not-wav", /not a 16-bit PCM WAV/],
		["oversize", new RegExp(`larger than ${HELPER_LIMITS.maxMediaBytes} bytes`)],
		["undeclared-role", /"app-reply" is not a media role declared/],
		["outside-window", /does not fit in the \d+ ms action window/],
		["bad-caption", /caption must be a string .* without control characters/],
	];
	for (const [mode, message] of cases) {
		const { result } = await run(mode);
		assert.equal(result.outcome, "media-invalid", mode);
		assert.match(result.error.message, message, mode);
		assert.deepEqual(result.media, [], mode);
	}
	assert.ok(fs.readdirSync(temp.dir).length > 0);
});

test("time limit, cancellation and output limit stop the helper and its whole process group", async (t) => {
	const { run, registry } = setup(t);
	let started = Date.now();
	const timeout = await run("hang", { timeoutMs: 800 });
	assert.equal(timeout.result.outcome, "timeout");
	assert.ok(Date.now() - started < 5000);
	assert.match(timeout.result.stops[0].result, /terminated|killed/);

	const controller = new AbortController();
	setTimeout(() => controller.abort(), 300);
	started = Date.now();
	const cancelled = await run("hang", { signal: controller.signal });
	assert.equal(cancelled.result.outcome, "cancelled");
	assert.ok(Date.now() - started < 5000);

	const hangingPage = await run("ok", { page: fakePage({ hang: true }), timeoutMs: 800 });
	assert.equal(hangingPage.result.outcome, "timeout", "a page script that never returns is bounded by the action time limit");

	// One deadline: a page call that reaches it is the action's time limit,
	// never a page error the helper reports as failed. The clock jumps past the
	// deadline as the page call starts, so its limit is reached first.
	let skew = 0;
	const lateClock = { calls: [], evaluate(expression) { this.calls.push(expression); skew = 60000; return new Promise(() => {}); } };
	started = Date.now();
	const pageDeadline = await run("ok", { page: lateClock, timeoutMs: 30000, now: () => performance.now() + skew });
	assert.equal(pageDeadline.result.outcome, "timeout", JSON.stringify(pageDeadline.result.error));
	// Ended by the one deadline's clock, not by a separate 30 s wall timer.
	assert.ok(Date.now() - started < 5000, `the deadline took ${Date.now() - started} ms of wall time`);
	assert.match(pageDeadline.result.error.message, /page script was still running/);

	// The helper exits while its page call is still pending; a cancellation
	// must not wait for that evaluation or the action time limit.
	const exitedController = new AbortController();
	setTimeout(() => exitedController.abort(), 500);
	started = Date.now();
	const exitedPending = await run("page-then-exit", { page: fakePage({ hang: true }), timeoutMs: 60000, signal: exitedController.signal });
	assert.equal(exitedPending.page.calls.length, 1, "the page call was started before the helper exited");
	assert.equal(exitedPending.result.outcome, "cancelled");
	assert.ok(Date.now() - started < 5000, `cancellation waited ${Date.now() - started} ms for a pending page call`);

	const flood = await run("flood", { maxOutputBytes: 4096 });
	assert.equal(flood.result.outcome, "output-limit");
	assert.ok(flood.result.stderr.length <= 4096);
	assert.deepEqual(registry.survivors(), []);
});

test("a process the helper detaches from its group is tracked by pid and stopped", async (t) => {
	const { run, registry } = setup(t);
	const { result } = await run("escape");
	assert.equal(result.outcome, "helper-escaped");
	assert.ok(result.escaped.length >= 1);
	for (const pid of result.escaped) {
		const stop = result.stops.find((item) => item.id.endsWith(`-escaped-${pid}`));
		assert.ok(stop, JSON.stringify(result.stops));
		assert.match(stop.result, /terminated|killed|exited/);
		assert.ok(!fs.existsSync(`/proc/${pid}`) || /^\S+ \(.*\) [ZX] /.test(fs.readFileSync(`/proc/${pid}/stat`, "utf8")), `pid ${pid} still running`);
	}
	assert.deepEqual(registry.survivors(), []);
});
