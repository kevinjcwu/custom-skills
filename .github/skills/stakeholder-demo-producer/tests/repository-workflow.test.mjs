import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { holdMediaLock, makeTempDir } from "./helpers.mjs";
import { sha256File } from "../scripts/lib/toolchain.mjs";
import { decodeMono } from "../scripts/lib/export-check.mjs";
import { runFixtureDemo } from "./fixtures/repository-demo/driver.mjs";

const RUNTIME = process.env.SDP_RUNTIME_DIR;
const FIXTURE = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"fixtures",
	"repository-demo",
);
const TOOL_PATHS = {
	root: RUNTIME,
	nodeModules: path.join(RUNTIME ?? "", "node", "node_modules"),
	playwrightCore: path.join(
		RUNTIME ?? "",
		"node",
		"node_modules",
		"playwright-core",
		"index.mjs",
	),
	browsersPath: path.join(RUNTIME ?? "", "ms-playwright"),
	ffmpeg: path.join(
		RUNTIME ?? "",
		"node",
		"node_modules",
		"ffmpeg-static",
		"ffmpeg",
	),
	ffprobe: path.join(
		RUNTIME ?? "",
		"node",
		"node_modules",
		"@ffprobe-installer",
		"linux-x64",
		"ffprobe",
	),
	python: path.join(RUNTIME ?? "", "piper-venv", "bin", "python"),
	voiceModel: path.join(RUNTIME ?? "", "voices", "en_US-ljspeech-high.onnx"),
	voiceConfig: path.join(
		RUNTIME ?? "",
		"voices",
		"en_US-ljspeech-high.onnx.json",
	),
	sysroot: path.join(RUNTIME ?? "", "sysroot"),
	installed: path.join(RUNTIME ?? "", "installed.json"),
};
const env = {
	PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
	HOME: process.env.HOME ?? "/tmp",
	TMPDIR: process.env.TMPDIR ?? "/tmp",
	PYTHONDONTWRITEBYTECODE: "1",
	PYTHONNOUSERSITE: "1",
	XDG_CACHE_HOME: process.env.XDG_CACHE_HOME ?? "/tmp",
	LANG: "C.UTF-8",
};
const runtimeAvailable = Boolean(
	RUNTIME &&
	fs.existsSync(TOOL_PATHS.installed) &&
	fs.existsSync(TOOL_PATHS.playwrightCore) &&
	fs.existsSync(TOOL_PATHS.ffmpeg) &&
	fs.existsSync(TOOL_PATHS.ffprobe) &&
	fs.existsSync(TOOL_PATHS.python) &&
	fs.existsSync(TOOL_PATHS.voiceModel) &&
	fs.existsSync(TOOL_PATHS.voiceConfig),
);
const productionEnabled = process.env.SDP_FIXTURE_PRODUCTION === "approved";

function hashInputs(inputFile) {
	return {
		startup: sha256File(path.join(FIXTURE, "index.html")),
		helper: sha256File(path.join(FIXTURE, "interaction-helper.mjs")),
		pageScript: sha256File(path.join(FIXTURE, "capture-page.mjs")),
		input: sha256File(inputFile),
		runtime: sha256File(TOOL_PATHS.installed),
	};
}

function attemptRoot(temp, name) {
	const evidence = process.env.SDP_FIXTURE_EVIDENCE_DIR;
	if (!evidence) return path.join(temp.dir, name);
	fs.mkdirSync(evidence, { recursive: true, mode: 0o700 });
	return path.join(evidence, name);
}

test(
	"fixture driver rejects changed approved bytes before spawning processes",
	{
		skip: runtimeAvailable
			? false
			: "approved pinned runtime is unavailable; no install is attempted",
	},
	async (t) => {
		const temp = makeTempDir();
		t.after(temp.cleanup);
		const input = path.join(temp.dir, "input.txt");
		fs.writeFileSync(input, "synthetic input");
		const expectedHashes = hashInputs(input);
		expectedHashes.input = "0".repeat(64);
		await assert.rejects(
			runFixtureDemo({
				outDir: path.join(temp.dir, "must-not-exist"),
				inputFile: input,
				expectedHashes,
				paths: TOOL_PATHS,
			}),
			/changed before spawn/,
		);
		assert.equal(fs.existsSync(path.join(temp.dir, "must-not-exist")), false);
	},
);

test(
	"ordinary browser journey and helper preserve full payload and export a narrated review candidate",
	{
		skip:
			runtimeAvailable && productionEnabled
				? false
				: "fixture export production is opt-in and its two-run allowance has been consumed",
	},
	async (t) => {
		await holdMediaLock(t);
		const temp = makeTempDir();
		t.after(temp.cleanup);
		const input = path.join(temp.dir, "input.txt");
		const text =
			"A synthetic imported row that the actual fixture file-input handler displays. ".repeat(
				14,
			);
		fs.writeFileSync(input, text);
		const outDir = attemptRoot(temp, "repository-demo-complete");
		fs.mkdirSync(path.dirname(outDir), { recursive: true, mode: 0o700 });
		const run = await runFixtureDemo({
			outDir,
			inputFile: input,
			expectedHashes: hashInputs(input),
			paths: TOOL_PATHS,
		});
		assert.equal(run.result.outcome, "done");
		assert.equal(
			run.payload.text.length > 500,
			true,
			"the structured page result exceeds helper detail truncation",
		);
		assert.equal(run.result.detail.length, 500);
		assert.equal(fs.readFileSync(run.original.file, "utf8"), run.payload.text);
		assert.deepEqual(run.survivors, []);
		assert.equal(run.exported.report.status, "candidate-for-human-review");
		assert.equal(run.exported.report.humanReview, "not-performed");
		assert.ok(
			run.exported.report.files.some(
				(file) => file.path === run.exported.output && file.sha256,
			),
		);
		const vtt = fs.readFileSync(run.exported.captions, "utf8");
		assert.match(vtt, /^WEBVTT/m);
		assert.match(vtt, /<v Narrator>/);
		assert.ok(run.exported.cues.every((cue) => cue.endMs > cue.startMs));
		assert.ok(
			run.events.findIndex((entry) => entry.event === "original-flushed") <
				run.events.findIndex((entry) => entry.event === "browser-close-start"),
		);
		assert.ok(
			run.events.findIndex((entry) => entry.event === "browser-closed") <
				run.events.findIndex((entry) => entry.event === "review-exported"),
		);
		const decoded = path.join(
			path.dirname(run.exported.output),
			"decoded-review.wav",
		);
		const decodedAudio = await decodeMono(
			TOOL_PATHS,
			run.exported.output,
			decoded,
			env,
		);
		assert.ok(
			decodedAudio.samples.length > 0,
			"the complete export decodes to audio",
		);
	},
);

test(
	"unknown helper result remains an honest incomplete candidate with original bytes",
	{
		skip:
			runtimeAvailable && productionEnabled
				? false
				: "fixture export production is opt-in and its two-run allowance has been consumed",
	},
	async (t) => {
		await holdMediaLock(t);
		const temp = makeTempDir();
		t.after(temp.cleanup);
		const input = path.join(temp.dir, "input.txt");
		fs.writeFileSync(input, "synthetic output with an unverified helper claim");
		const outDir = attemptRoot(temp, "repository-demo-incomplete");
		fs.mkdirSync(path.dirname(outDir), { recursive: true, mode: 0o700 });
		const run = await runFixtureDemo({
			outDir,
			inputFile: input,
			expectedHashes: hashInputs(input),
			helperMode: "unknown",
			paths: TOOL_PATHS,
		});
		assert.equal(run.result.outcome, "helper-unknown");
		assert.equal(run.stop, "helper-unknown");
		assert.ok(fs.statSync(run.original.file).size > 0);
		assert.equal(
			run.exported.report.status,
			"incomplete-candidate-for-human-review",
		);
		assert.match(
			run.exported.report.limitations.join(" "),
			/helper outcome was helper-unknown/,
		);
		assert.match(fs.readFileSync(run.exported.captions, "utf8"), /incomplete/i);
		assert.equal(run.exported.report.humanReview, "not-performed");
		assert.deepEqual(run.survivors, []);
		assert.ok(
			run.events.findIndex((entry) => entry.event === "original-flushed") <
				run.events.findIndex((entry) => entry.event === "browser-close-start"),
		);
	},
);

test(
	"ordinary browser driver completes helper interaction and preserves captured bytes without exporting",
	{
		skip: runtimeAvailable
			? false
			: "approved pinned runtime is unavailable; no install is attempted",
	},
	async (t) => {
		await holdMediaLock(t);
		const temp = makeTempDir();
		t.after(temp.cleanup);
		const input = path.join(temp.dir, "input.txt");
		const text = "No export is produced in this focused interaction check.";
		fs.writeFileSync(input, text);
		const outDir = path.join(temp.dir, "complete-without-export");
		const run = await runFixtureDemo({
			outDir,
			inputFile: input,
			expectedHashes: hashInputs(input),
			paths: TOOL_PATHS,
			makeExport: false,
		});
		assert.equal(run.result.outcome, "done");
		assert.equal(run.payload.text, `Imported demo-input.txt: ${text}`);
		assert.equal(fs.readFileSync(run.original.file, "utf8"), run.payload.text);
		assert.equal(run.exported, null);
		assert.deepEqual(run.survivors, []);
	},
);

test(
	"timeout stops new interaction but flushes already-present originals before browser close",
	{
		skip: runtimeAvailable
			? false
			: "approved pinned runtime is unavailable; no install is attempted",
	},
	async (t) => {
		await holdMediaLock(t);
		const temp = makeTempDir();
		t.after(temp.cleanup);
		const input = path.join(temp.dir, "input.txt");
		fs.writeFileSync(input, "synthetic input for a timed-out helper");
		const outDir = path.join(temp.dir, "timeout-without-export");
		const run = await runFixtureDemo({
			outDir,
			inputFile: input,
			expectedHashes: hashInputs(input),
			paths: TOOL_PATHS,
			helperMode: "hang",
			actionTimeoutMs: 500,
			makeExport: false,
		});
		assert.equal(run.result.outcome, "timeout");
		assert.ok(fs.statSync(run.original.file).size > 0);
		const stopped = run.events.findIndex(
			(event) => event.event === "interaction-timeout",
		);
		assert.ok(stopped >= 0);
		assert.equal(
			run.events
				.slice(stopped + 1)
				.some((event) =>
					["journey-start", "helper-start"].includes(event.event),
				),
			false,
		);
		assert.ok(
			run.events.findIndex((event) => event.event === "original-flushed") <
				run.events.findIndex((event) => event.event === "browser-close-start"),
		);
		assert.deepEqual(run.survivors, []);
	},
);

test(
	"hard deadline bounds a hung finalizer and owned cleanup",
	{
		skip: runtimeAvailable
			? false
			: "approved pinned runtime is unavailable; no install is attempted",
	},
	async (t) => {
		await holdMediaLock(t);
		const temp = makeTempDir();
		t.after(temp.cleanup);
		const input = path.join(temp.dir, "input.txt");
		fs.writeFileSync(input, "synthetic");
		const outDir = path.join(temp.dir, "hung-finalizer");
		const started = Date.now();
		await assert.rejects(
			runFixtureDemo({
				outDir,
				inputFile: input,
				expectedHashes: hashInputs(input),
				paths: TOOL_PATHS,
				hardDeadlineMs: 9000,
				actionTimeoutMs: 3000,
				finalizeDelayMs: 15000,
				makeExport: false,
			}),
			/hard deadline/,
		);
		assert.ok(
			Date.now() - started < 15000,
			`whole-run cancellation took ${Date.now() - started} ms`,
		);
		const report = JSON.parse(
			fs.readFileSync(path.join(outDir, "fixture-result.json"), "utf8"),
		);
		assert.ok(
			report.events.some((event) => event.event === "owned-process-cleanup"),
		);
		assert.deepEqual(report.survivors, []);
		assert.equal(
			fs.existsSync(path.join(outDir, "originals", "capture.original")),
			false,
		);
	},
);
