import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { validateContract } from "../scripts/lib/contracts.mjs";
import { checkProducible, clipWindow, layoutTimeline, silentWindows, TIMING } from "../scripts/lib/produce.mjs";
import { launchBrowser } from "../scripts/lib/browser.mjs";
import { ProcRegistry } from "../scripts/lib/proc-registry.mjs";
import { requireTools } from "../scripts/lib/toolchain.mjs";
import { makeTempDir, writeJson } from "./helpers.mjs";

const EXPORT_TOOLS = requireTools(["ffmpeg", "ffprobe", "python", "voiceModel"]);

const frames = (ms) => Math.ceil((ms * TIMING.fps) / 1000);

test("the edit layout tiles exactly and holds the main visual until narration ends", () => {
	const layout = layoutTimeline([
		{ id: "scene.a", diagram: true, kind: "recorded-output-panel", narrationMs: 12000 },
		{ id: "scene.b", diagram: false, kind: "browser-clip", clipMs: 3000, narrationMs: 1000 },
		{ id: "scene.c", diagram: false, kind: "browser-clip", clipMs: 2000, narrationMs: 6000 },
	]);
	let cursor = 0;
	for (const segment of layout.segments) {
		assert.equal(segment.startFrame, cursor);
		cursor += segment.frames;
	}
	assert.equal(cursor, layout.totalFrames);
	const byId = Object.fromEntries(layout.segments.map((segment) => [segment.id, segment]));
	// Narration longer than the minimum visuals extends the main visual, not the diagram.
	assert.equal(byId["seg.scene.a.diagram"].frames, frames(TIMING.diagramMinMs));
	assert.equal(byId["seg.scene.a.diagram"].frames + byId["seg.scene.a.main"].frames, frames(TIMING.leadMs + 12000 + TIMING.tailMs));
	// A clip longer than its narration is kept whole and never held.
	assert.equal(byId["seg.scene.b.main"].frames, frames(3000));
	assert.equal(byId["seg.scene.b.main"].heldFrames, 0);
	// A clip shorter than its narration freezes its last frame for the difference.
	assert.equal(byId["seg.scene.c.main"].heldFrames, frames(TIMING.leadMs + 6000 + TIMING.tailMs) - frames(2000));
	assert.equal(layout.narrationStartMs["scene.a"], (frames(TIMING.titleMs) * 1000) / TIMING.fps + TIMING.leadMs);
});

test("silent windows exclude narration with margins and drop windows too short to measure", () => {
	const windows = silentWindows(
		[
			{ startMs: 4500, endMs: 9000 },
			{ startMs: 9500, endMs: 12000 },
		],
		20000,
	);
	assert.deepEqual(windows, [
		{ startMs: 0, endMs: 4250 },
		{ startMs: 12250, endMs: 19950 },
	]);
});

test("a clip window comes only from successful, timed browser attempts of that scene", () => {
	const attempt = (sceneId, disposition, start, end) => ({ type: "action.attempt", sceneId, disposition, data: { videoStartMs: start, videoEndMs: end } });
	const events = [attempt("scene.v", "ok", 1000, 2000), attempt("scene.v", "ok", 2100, 5000), attempt("scene.v", "failed", 5100, 9000), attempt("scene.w", "ok", 9000, 9500)];
	assert.deepEqual(clipWindow(events, "scene.v"), { inMs: 1000 - TIMING.clipLeadMs, outMs: 5000 + TIMING.clipTailMs });
	assert.equal(clipWindow(events, "scene.x"), null);
	assert.equal(clipWindow([{ type: "action.attempt", sceneId: "scene.p", disposition: "ok", data: { exitCode: 0 } }], "scene.p"), null);
});

test("a clip's lead and tail never show a neighbouring scene's recorded actions", () => {
	const attempt = (sceneId, disposition, start, end) => ({ type: "action.attempt", sceneId, disposition, data: { videoStartMs: start, videoEndMs: end } });
	// The previous scene ended 100 ms before, and the next one (even a failed attempt) starts 200 ms after.
	const events = [attempt("scene.u", "failed", 500, 900), attempt("scene.v", "ok", 1000, 5000), attempt("scene.w", "ok", 5200, 6000)];
	assert.deepEqual(clipWindow(events, "scene.v"), { inMs: 900, outMs: 5200 });
	assert.deepEqual(clipWindow(events, "scene.w"), { inMs: 5000, outMs: 6000 + TIMING.clipTailMs });
});

test("an export is blocked without a passed calibration and a QA-checked run", (t) => {
	const temp = makeTempDir();
	t.after(temp.cleanup);
	const calibrationFile = path.join(temp.dir, "calibration.json");
	writeJson(calibrationFile, { passed: false, export: { profile: { fps: 25 } }, floors: {} });
	const run = path.join(temp.dir, "run");
	fs.mkdirSync(run);
	const { reasons } = checkProducible({ runPath: run, calibrationFile, audience: "business" });
	assert.ok(reasons.includes("the calibration did not pass"));
	assert.ok(reasons.includes("the calibration was made with a different export profile"));
	assert.ok(reasons.includes("the calibration has no export silence threshold"));
	assert.ok(reasons.some((reason) => reason.startsWith("manifest:")));
	assert.ok(reasons.some((reason) => reason.includes("run `sdp qa` first")));
});

test("the export manifest contract requires a contiguous edit and honest verdict", () => {
	const sha = "a".repeat(64);
	const doc = {
		schema: "export-manifest.v1",
		runId: "run-x",
		audience: "business",
		inputs: { runManifestSha256: sha, qaReportSha256: sha, claimLedgerSha256: sha, calibrationSha256: sha },
		profile: { video: "h264 High yuv420p 1280x720 30fps crf20 medium", audio: "aac LC 48000Hz stereo 160k narrator -16LUFS", container: "mp4 +faststart" },
		totalFrames: 60,
		durationMs: 2000,
		segments: [
			{ id: "seg.title", kind: "title-card", startFrame: 0, frames: 30, label: "title-card" },
			{ id: "seg.closing", kind: "closing-card", startFrame: 30, frames: 30, label: "closing-card" },
		],
		narration: [],
		files: [
			{ path: "final/x.mp4", sha256: sha, bytes: 1, role: "export-video" },
			{ path: "final/x.vtt", sha256: sha, bytes: 1, role: "captions" },
		],
		checks: [{ id: "export-profile", status: "pass", detail: "ok" }],
		verdict: "structural-pass",
		limitations: [],
	};
	assert.deepEqual(validateContract("export-manifest", doc), []);
	const gap = structuredClone(doc);
	gap.segments[1].startFrame = 31;
	assert.ok(validateContract("export-manifest", gap).some((error) => error.path === "/segments/1/startFrame"));
	const short = { ...structuredClone(doc), totalFrames: 61, durationMs: (61 * 1000) / 30 };
	assert.ok(validateContract("export-manifest", short).some((error) => error.path === "/totalFrames"));
	const dishonest = structuredClone(doc);
	dishonest.checks[0].status = "fail";
	assert.ok(validateContract("export-manifest", dishonest).some((error) => error.path === "/verdict"));
	const noCaptions = structuredClone(doc);
	noCaptions.files.pop();
	assert.ok(validateContract("export-manifest", noCaptions).some((error) => error.message.includes("captions")));
});

test("cancelling the card browser interrupts an operation in flight and leaves no browser process", { skip: EXPORT_TOOLS.ok ? false : "toolchain not installed (run `sdp setup install`)" }, async (t) => {
	const temp = makeTempDir();
	t.after(temp.cleanup);
	const dir = temp.dir;
	const registry = new ProcRegistry();
	const controller = new AbortController();
	const browser = await launchBrowser({ paths: EXPORT_TOOLS.paths, dir, registry, origins: [], recordVideo: false, id: "card-browser", signal: controller.signal });
	const page = await browser.context.newPage();
	// Stands in for a card setContent or screenshot that does not return.
	const inFlight = page.waitForFunction(() => false, null, { timeout: 0, polling: 100 });
	setTimeout(() => controller.abort(), 300);
	const started = Date.now();
	const outcome = await Promise.race([
		inFlight.then(() => "resolved", () => "rejected"),
		new Promise((resolve) => setTimeout(() => resolve("still running"), 10000)),
	]);
	assert.equal(outcome, "rejected", "the in-flight browser operation must end when the run is cancelled");
	assert.ok(Date.now() - started < 5000, `took ${Date.now() - started} ms`);
	const closed = await browser.close();
	assert.notEqual(closed.stopped.result, "failed", JSON.stringify(closed.stopped));
	assert.deepEqual(registry.survivors(), []);
	// An already-cancelled run never starts a browser.
	await assert.rejects(launchBrowser({ paths: EXPORT_TOOLS.paths, dir, registry: new ProcRegistry(), origins: [], recordVideo: false, id: "late", signal: AbortSignal.abort() }), /cancelled/);
	if (outcome !== "rejected") {
		await registry.stop("card-browser");
	}
});

// Live processes whose command line names a path inside dir (this test's own browser).
function browsersUnder(dir) {
	const found = [];
	for (const name of fs.readdirSync("/proc")) {
		if (!/^\d+$/.test(name)) {
			continue;
		}
		try {
			const stat = fs.readFileSync(`/proc/${name}/stat`, "utf8");
			if (["Z", "X"].includes(stat.slice(stat.lastIndexOf(")") + 2)[0])) {
				continue;
			}
			if (fs.readFileSync(`/proc/${name}/cmdline`, "utf8").includes(dir)) {
				found.push(Number(name));
			}
		} catch {
			// exited meanwhile
		}
	}
	return found;
}

test("cancelling while the card browser is starting stops it and refuses the launch", { skip: EXPORT_TOOLS.ok ? false : "toolchain not installed (run `sdp setup install`)" }, async (t) => {
	const temp = makeTempDir();
	t.after(temp.cleanup);
	const registry = new ProcRegistry();
	const controller = new AbortController();
	const launching = launchBrowser({ paths: EXPORT_TOOLS.paths, dir: temp.dir, registry, origins: [], recordVideo: false, id: "card-browser", signal: controller.signal });
	launching.catch(() => {});
	// Abort as soon as the browser process exists, before the launch has finished.
	const deadline = Date.now() + 20000;
	while (!browsersUnder(temp.dir).length && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 2));
	}
	assert.ok(browsersUnder(temp.dir).length, "the browser process never appeared");
	controller.abort();
	const started = Date.now();
	const outcome = await Promise.race([
		launching.then(async (browser) => {
			await browser.close();
			return "launched";
		}, (error) => error.message),
		new Promise((resolve) => setTimeout(() => resolve("still starting"), 10000)),
	]);
	assert.match(outcome, /cancelled/);
	assert.ok(Date.now() - started < 5000, `took ${Date.now() - started} ms`);
	assert.deepEqual(browsersUnder(temp.dir), []);
});

test("cancelling while the card browser is closing stops it instead of waiting for the graceful close", { skip: EXPORT_TOOLS.ok ? false : "toolchain not installed (run `sdp setup install`)" }, async (t) => {
	const temp = makeTempDir();
	t.after(temp.cleanup);
	const registry = new ProcRegistry();
	const controller = new AbortController();
	const browser = await launchBrowser({ paths: EXPORT_TOOLS.paths, dir: temp.dir, registry, origins: [], recordVideo: true, id: "card-browser", signal: controller.signal });
	const page = await browser.context.newPage();
	await page.setContent("<p>card</p>");
	const closing = browser.close();
	// The graceful close (finishing and saving the video) is now under way.
	controller.abort();
	const closed = await closing;
	assert.deepEqual(closed.videos, [], "nothing is saved from a cancelled browser");
	assert.ok(["terminated", "killed"].includes(closed.stopped.result), JSON.stringify(closed.stopped));
	assert.deepEqual(registry.survivors(), []);
	assert.deepEqual(browsersUnder(temp.dir), [], "no browser or video encoder is left running");
});
