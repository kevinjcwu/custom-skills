/* global AbortController */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { buildEnv, runProcess } from "../scripts/lib/process-adapter.mjs";
import { BEHAVE, makeTempDir } from "./helpers.mjs";

const base = {
	executable: process.execPath,
	cwd: process.cwd(),
	env: {},
	timeoutMs: 10000,
	maxOutputBytes: 65536,
	killGraceMs: 200,
};

function behave(...args) {
	return { ...base, argv: [BEHAVE, ...args] };
}

test("argv stays literal: shell metacharacters are not interpreted", async () => {
	const result = await runProcess(behave("echo", "$(whoami)", ";", "rm", "-rf", "/", "|", "`id`", "&&", "*"));
	assert.equal(result.outcome, "exited");
	assert.equal(result.exitCode, 0);
	assert.equal(result.stdout.toString(), "$(whoami) ; rm -rf / | `id` && *\n");
});

test("environment contains only approved literals and pass-through names", async () => {
	const parent = { SDP_PARENT_SECRET: "parent-secret-value", SDP_SHARED: "shared", PATH: "/usr/bin" };
	const env = buildEnv({ env: [{ name: "LITERAL", value: "lit" }], envPassthrough: ["SDP_SHARED", "SDP_MISSING"] }, parent);
	assert.deepEqual({ ...env }, { SDP_SHARED: "shared", LITERAL: "lit" });
	const result = await runProcess({ ...behave("env", "LITERAL", "SDP_SHARED", "SDP_PARENT_SECRET", "PATH"), env });
	assert.equal(result.stdout.toString(), "LITERAL=lit\nSDP_SHARED=shared\nSDP_PARENT_SECRET=<unset>\nPATH=<unset>\n");
	assert.ok(!result.stdout.toString().includes("parent-secret-value"));
});

test("stdin is closed and cwd is the approved directory", async (t) => {
	const { dir, cleanup } = makeTempDir();
	t.after(cleanup);
	const stdin = await runProcess(behave("stdin"));
	assert.equal(stdin.stdout.toString(), "stdin 0\n");
	const cwd = await runProcess({ ...behave("cwd"), cwd: dir });
	assert.equal(cwd.stdout.toString().trim(), dir);
});

test("non-zero exit is reported, not thrown", async () => {
	const result = await runProcess(behave("exit", "7"));
	assert.equal(result.outcome, "exited");
	assert.equal(result.exitCode, 7);
});

test("timeout terminates the process", async () => {
	const result = await runProcess({ ...behave("sleep", "5000"), timeoutMs: 100 });
	assert.equal(result.outcome, "timeout");
	assert.deepEqual(result.termination.slice(0, 1), ["SIGTERM"]);
	assert.ok(result.durationMs < 4000);
	assert.equal(result.stdout.toString(), "");
});

test("SIGTERM is escalated to SIGKILL after the grace period", async () => {
	const result = await runProcess({ ...behave("ignore-term", "10000"), timeoutMs: 1500, killGraceMs: 100 });
	assert.equal(result.outcome, "timeout");
	assert.ok(result.termination.includes("SIGTERM"));
	assert.ok(result.termination.includes("SIGKILL"));
	assert.equal(result.exitSignal, "SIGKILL");
});

test("output over the cap is truncated and terminates the process", async () => {
	const result = await runProcess({ ...behave("flood", "200000"), maxOutputBytes: 1000 });
	assert.equal(result.outcome, "output-limit");
	assert.equal(result.outputExceeded, "stdout");
	assert.equal(result.stdout.length, 1000);
	assert.ok(result.lateOutputBytes > 0);
});

test("cancellation stops the process and late output is ignored but counted", async () => {
	const controller = new AbortController();
	const pending = runProcess({ ...behave("late", "4000"), signal: controller.signal, killGraceMs: 1000 });
	// Leave ample time for "early" even when test files run in parallel.
	await delay(1500);
	controller.abort();
	const result = await pending;
	assert.equal(result.outcome, "cancelled");
	assert.equal(result.stdout.toString(), "early\n");
	const preAborted = new AbortController();
	preAborted.abort();
	assert.equal((await runProcess({ ...behave("echo", "x"), signal: preAborted.signal })).outcome, "cancelled");
});

test("a missing executable is a spawn error, not a crash", async (t) => {
	const { dir, cleanup } = makeTempDir();
	t.after(cleanup);
	const result = await runProcess({ ...base, executable: path.join(dir, "missing-binary"), argv: [] });
	assert.equal(result.outcome, "spawn-error");
	assert.equal(result.error.code, "enoent");
	assert.ok(!JSON.stringify(result.error).includes(dir));
});

test("flaky fixture fails first and recovers second (retry input)", async (t) => {
	const { dir, cleanup } = makeTempDir();
	t.after(cleanup);
	const marker = path.join(dir, "seen");
	const first = await runProcess(behave("flaky", marker));
	const second = await runProcess(behave("flaky", marker));
	assert.equal(first.exitCode, 1);
	assert.equal(second.exitCode, 0);
	assert.ok(fs.existsSync(marker));
});
