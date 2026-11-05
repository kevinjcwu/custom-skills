import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { holdMediaLock, makeTempDir, SKILL_ROOT } from "./helpers.mjs";

test("a disposable package starts its actual CLI against an unrelated repository from space-containing paths", {
	timeout: 240000,
}, async (t) => {
	if (process.env.SDP_RUNTIME_DIR) await holdMediaLock(t);
	const temp = makeTempDir();
	t.after(temp.cleanup);
	const copy = path.join(temp.dir, "independent copied skill");
	fs.mkdirSync(copy);
	for (const entry of fs.readdirSync(SKILL_ROOT)) {
		if ([".runs", ".runtime", ".test-runs", "node_modules"].includes(entry)) continue;
		fs.cpSync(path.join(SKILL_ROOT, entry), path.join(copy, entry), { recursive: true });
	}
	const repo = path.join(temp.dir, "unrelated synthetic repository");
	fs.mkdirSync(repo);
	fs.writeFileSync(path.join(repo, "README.md"), "# Synthetic inventory CLI\nAn unrelated offline fixture.\n");
	fs.writeFileSync(path.join(repo, "inventory.mjs"), "console.log(process.argv.slice(2));\n");
	for (const name of ["home", "tmp", "cache"]) fs.mkdirSync(path.join(temp.dir, name));
	const env = {
		PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
		HOME: path.join(temp.dir, "home"),
		TMPDIR: path.join(temp.dir, "tmp"),
		XDG_CACHE_HOME: path.join(temp.dir, "cache"),
		PYTHONDONTWRITEBYTECODE: "1",
		PYTHONNOUSERSITE: "1",
		LANG: "C.UTF-8",
		...(process.env.SDP_RUNTIME_DIR ? { SDP_RUNTIME_DIR: process.env.SDP_RUNTIME_DIR } : {}),
	};
	const run = (args, timeout = 20000) => {
		const result = spawnSync(process.execPath, args, { cwd: repo, env, encoding: "utf8", timeout, maxBuffer: 8 * 1024 * 1024 });
		assert.equal(result.error, undefined);
		assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
		return result.stdout;
	};
	const cli = path.join(copy, "scripts", "sdp.mjs");
	assert.ok(JSON.parse(run([cli, "--help"])).usage);
	const out = path.join(temp.dir, "catalog.json");
	const catalog = JSON.parse(run([cli, "discover", "--root", repo, "--out", out]));
	assert.equal(catalog.schema, "capability-catalog.v1");
	assert.ok(catalog.inventory.signals.some((entry) => entry.signal === "process-argv"));
	assert.equal(JSON.parse(run([cli, "validate", out])).valid, true);
	// Import order and actual CLI entry are both exercised; direct-import-only tests missed a cycle.
	run(["--input-type=module", "-e", `await import(${JSON.stringify(pathToFileURL(path.join(copy, "scripts/lib/review-export.mjs")).href)}); await import(${JSON.stringify(pathToFileURL(path.join(copy, "scripts/lib/playback-evidence.mjs")).href)});`]);
	if (process.env.SDP_RUNTIME_DIR) {
		const output = run(["--test", path.join(copy, "tests/review-export.test.mjs"), path.join(copy, "tests/voice-capture.test.mjs")], 180000);
		assert.match(output, /(?:#|\u2139) fail 0/);
		assert.match(output, /(?:#|\u2139) skipped 0/);
		t.diagnostic("Copied package: pinned exporter/browser regressions passed with zero skips.");
	}
});
