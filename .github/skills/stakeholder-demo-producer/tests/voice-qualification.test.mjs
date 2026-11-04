import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import vm from "node:vm";
import { runHelper } from "../scripts/lib/helper-adapter.mjs";
import { ProcRegistry } from "../scripts/lib/proc-registry.mjs";
import { evaluateQualification } from "../scripts/lib/qualification.mjs";
import { captureScript, readiness, responseEvidence } from "./fixtures/voice-qualification/observations.mjs";

const stageResults = [];
const dispatchResults = [];
const cleanupResults = [];
const fixture = new URL("./fixtures/voice-qualification/protocol-helper.mjs", import.meta.url);

function evaluate(stage, evidence, options = {}) {
	const result = evaluateQualification({
		stage,
		startMs: 0,
		nowMs: stage === "response" ? 600 : evidence.snapshot?.atMs ?? 100,
		deadlineMs: 1000,
		evidenceRefs: ["synthetic:voice-qualification"],
		evidence,
		...options,
	});
	stageResults.push(result);
	return result;
}

after(() => {
	const out = process.env.SDP_QUALIFICATION_EVIDENCE_DIR;
	if (!out) return;
	fs.mkdirSync(out, { recursive: true });
	fs.writeFileSync(path.join(out, "stage-results.json"), `${JSON.stringify({ synthetic: true, results: stageResults, dispatch: dispatchResults }, null, "\t")}\n`);
	fs.writeFileSync(path.join(out, "cleanup.json"), `${JSON.stringify({ synthetic: true, records: cleanupResults }, null, "\t")}\n`);
});

async function dispatch(t, operation, script, { hang = false, cancel = false } = {}) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qualification-"));
	const registry = new ProcRegistry();
	const context = vm.createContext({ state: { operations: [] } });
	let evaluations = 0;
	const controller = new AbortController();
	t.after(async () => {
		await registry.stopAll(500);
		assert.deepEqual(registry.survivors(), []);
		fs.rmSync(dir, { recursive: true });
		cleanupResults.push({ operation, script, survivors: registry.survivors(), privateDirectoryRemoved: !fs.existsSync(dir) });
	});
	const result = await runHelper({
		registry,
		id: `probe-${operation}`,
		executable: process.execPath,
		argv: [fixture.pathname, operation, script],
		cwd: dir,
		env: { PATH: "/usr/bin:/bin", HOME: dir, TMPDIR: dir, XDG_CACHE_HOME: dir, PYTHONDONTWRITEBYTECODE: "1" },
		outDir: dir,
		interaction: { needs: ["browser-page"], media: [], pageScripts: [{ id: "page.capture" }] },
		pageScripts: new Map([["page.capture", captureScript]]),
		page: {
			evaluate(expression) {
				evaluations += 1;
				if (cancel) controller.abort();
				return hang ? new Promise(() => {}) : Promise.resolve(vm.runInContext(expression, context, { timeout: 100 }));
			},
		},
		action: { id: `action.${operation}` },
		timeoutMs: hang ? 300 : 3000,
		killGraceMs: 100,
		maxOutputBytes: 65536,
		signal: controller.signal,
		now: () => performance.now(),
	});
	dispatchResults.push({ synthetic: true, operation, script, outcome: result.outcome, pageCalls: result.pageCalls, evaluations, operations: Array.from(context.state.operations), transcript: result.transcript });
	return { result, evaluations, operations: Array.from(context.state.operations) };
}

test("actual runHelper dispatch evaluates declared page.capture for both arm and speak", { timeout: 10000 }, async (t) => {
	for (const operation of ["arm", "speak"]) {
		const { result, evaluations, operations } = await dispatch(t, operation, "page.capture");
		assert.equal(result.outcome, "done", JSON.stringify(result.error));
		assert.equal(evaluations, 1);
		assert.deepEqual(operations, [operation]);
		assert.equal(JSON.parse(result.detail).operation, operation);
		assert.ok(result.transcript.some((entry) => entry.message?.type === "page-result" && entry.message.ok));
	}
});

test("actual runHelper rejects undeclared capture for both arm and speak without evaluation", { timeout: 10000 }, async (t) => {
	for (const operation of ["arm", "speak"]) {
		const { result, evaluations, operations } = await dispatch(t, operation, "capture");
		assert.equal(result.outcome, "helper-failed");
		assert.match(result.detail, /unknown page script/);
		assert.equal(evaluations, 0);
		assert.deepEqual(operations, []);
	}
});

test("existing runner bounds a pending page call and cleans up on deadline and cancellation", { timeout: 10000 }, async (t) => {
	const timed = await dispatch(t, "arm", "page.capture", { hang: true });
	assert.equal(timed.result.outcome, "timeout");
	assert.equal(timed.evaluations, 1);
	const cancelled = await dispatch(t, "speak", "page.capture", { hang: true, cancel: true });
	assert.equal(cancelled.result.outcome, "cancelled");
	assert.equal(cancelled.evaluations, 1);
});

test("500ms post-Listening greeting transition prevents premature input and later permits a new baseline", () => {
	const initial = evaluate("readiness", readiness(100));
	assert.equal(initial.status, "pass");
	const greeting = readiness(600);
	greeting.baseline = initial.baseline;
	Object.assign(greeting.snapshot, { label: "Preparing response/Microphone sending", outputActive: true, responseIds: ["response.greeting", "response.automatic"] });
	assert.equal(evaluate("before-input", greeting).status, "wait");
	greeting.snapshot.outputActive = false;
	assert.equal(evaluate("before-input", greeting).code, "baseline-invalidated");
	const refreshed = evaluate("readiness", greeting);
	assert.equal(refreshed.status, "pass");
	greeting.baseline = refreshed.baseline;
	assert.equal(evaluate("before-input", greeting).status, "pass", "label alone is not the readiness gate");
});

test("immediate same-session recheck refuses stale snapshots, missing gates, and changed sessions", () => {
	const evidence = readiness();
	evidence.baseline = evaluate("readiness", evidence).baseline;
	assert.equal(evaluate("before-input", evidence, { nowMs: 101 }).code, "readiness-unknown");
	evidence.snapshot.sessionId = "session.old";
	assert.equal(evaluate("before-input", evidence).status, "unknown");
	evidence.snapshot.sessionId = evidence.sessionId;
	delete evidence.snapshot.inputEnabled;
	assert.equal(evaluate("before-input", evidence).status, "unknown");
	delete evidence.baseline;
	assert.equal(evaluate("before-input", evidence).status, "unknown");
});

test("complete labelled synthetic evidence passes policy only despite unequal control and media durations", () => {
	const evidence = responseEvidence();
	const before = structuredClone(evidence);
	const result = evaluate("response", evidence);
	assert.equal(result.status, "pass");
	assert.equal(result.code, "current-turn-audio");
	assert.equal(result.scope, "supplied-evidence-only");
	assert.equal(result.media.frames, 800);
	assert.equal(result.media.mediaDurationMs, 100);
	assert.equal(evidence.audio.capture.finalized.atMs - evidence.audio.capture.started.atMs, 430);
	assert.equal(result.timing.sampleClockMapping, null);
	assert.equal(result.timing.observations.find((entry) => entry.meaning === "render-clock").uncertaintyMs, null);
	assert.deepEqual(evidence, before, "evaluation must not rewrite generation facts or manufacture endpoints");
	assert.deepEqual(result.evidenceRefs, ["synthetic:voice-qualification"]);
});

test("known stale greetings, prior sessions and wrong causal identities fail qualification", () => {
	const cases = [
		(e) => { e.response.id = "response.greeting"; e.audio.responseId = e.response.id; },
		(e) => { e.response.sessionId = "session.old"; },
		(e) => { e.input.sessionId = "session.old"; },
		(e) => { e.audio.responseId = "response.unrelated"; },
		(e) => { e.response.inputId = "input.unrelated"; },
		(e) => { e.response.turnId = "turn.unrelated"; },
		(e) => { e.baseline.atMs = 250; },
		(e) => { e.response.generation.completed.atMs = 700; },
	];
	for (const mutate of cases) {
		const evidence = responseEvidence();
		mutate(evidence);
		assert.equal(evaluate("response", evidence).status, "failed");
	}
});

test("missing identities, delivery, media or authoritative association remain unknown", () => {
	const cases = [
		(e) => { delete e.audio; e.text = "A new reply"; },
		(e) => { delete e.response.inputId; },
		(e) => { e.input.deliveryObserved = false; },
		(e) => { delete e.input.deliveryRef; },
		(e) => { delete e.response.associationRef; },
	];
	for (const mutate of cases) {
		const evidence = responseEvidence();
		mutate(evidence);
		assert.equal(evaluate("response", evidence).status, "unknown");
	}
});

test("strict decoded format, integer frames, silence and sample digest reject corrupt media", () => {
	const cases = [
		(e) => { e.audio.pcm = "invalid"; },
		(e) => { e.audio.pcm = 0; },
		(e) => { e.audio.pcm = false; },
		(e) => { e.audio.pcm.samples.fill(0); },
		(e) => { e.audio.pcm.samples = new Int16Array(); },
		(e) => { e.audio.pcm.samples = [1000]; },
		(e) => { e.audio.pcm.sampleRate = 0; },
		(e) => { e.audio.pcm.bitDepth = 8; },
		(e) => { e.audio.pcm.channels = 2; },
		(e) => { e.audio.pcm.frames += 1; },
		(e) => { e.audio.pcm.samples[0] += 1; },
		(e) => { e.audio.artifacts.decoded.pcmSha256 = "f".repeat(64); },
	];
	for (const mutate of cases) {
		const evidence = responseEvidence();
		mutate(evidence);
		assert.equal(evaluate("response", evidence).status, "failed");
	}
	const missing = responseEvidence();
	delete missing.audio.pcm;
	assert.equal(evaluate("response", missing).status, "unknown");
	for (const key of ["bitDepth", "channels", "sampleRate", "samples", "frames"]) {
		for (const absent of [undefined, null]) {
			const partial = responseEvidence();
			partial.audio.pcm[key] = absent;
			assert.equal(evaluate("response", partial).status, "unknown", `missing ${key} is not a positive media contradiction`);
		}
	}
});

test("bare labels, verification flags and missing source or coverage never substitute for membership", () => {
	const cases = [
		(e) => { delete e.audio.membership; },
		(e) => { e.audio.membership = { verified: true, responseId: e.response.id }; },
		(e) => { delete e.receiver; },
		(e) => { delete e.audio.source.bindingRef; },
		(e) => { delete e.audio.artifacts.conversionRef; },
		(e) => { delete e.audio.membership.isolationRef; },
		(e) => { delete e.audio.membership.coverageRef; },
		(e) => { delete e.audio.membership.history.gaps; },
		(e) => { e.audio.membership.history.gaps = ["synthetic:missing-events"]; },
		(e) => { e.audio.membership.history.baselineResponseIds = []; },
	];
	for (const mutate of cases) {
		const evidence = responseEvidence();
		mutate(evidence);
		assert.equal(evaluate("response", evidence).status, "unknown");
	}
});

test("wrong received peer, track, artifact or membership response is a positive contradiction", () => {
	const cases = [
		(e) => { e.audio.source.peerId = "peer.other"; },
		(e) => { e.audio.source.trackId = "track.participant"; },
		(e) => { e.audio.source.direction = "sent"; },
		(e) => { e.audio.membership.responseId = "response.greeting"; },
		(e) => { e.audio.membership.originalSha256 = "f".repeat(64); },
		(e) => { e.audio.membership.decodedSha256 = "f".repeat(64); },
		(e) => { e.audio.membership.pcmSha256 = "f".repeat(64); },
		(e) => { e.audio.membership.bindingRef = "synthetic:other-binding"; },
	];
	for (const mutate of cases) {
		const evidence = responseEvidence();
		mutate(evidence);
		assert.equal(evaluate("response", evidence).status, "failed");
	}
});

test("required clock uncertainty, source, meaning and origin cannot be omitted or inferred", () => {
	const cases = [
		(e) => { e.audio.capture.started.uncertaintyMs = null; },
		(e) => { e.audio.output.started.clockId = "provider.clock"; },
		(e) => { e.audio.output.started.clockOrigin = "document.old"; },
		(e) => { delete e.audio.capture.started.sourceRef; },
		(e) => { e.audio.capture.started.meaning = "render-clock"; },
		(e) => { delete e.audio.capture.started.uncertaintyMs.basisRef; },
		(e) => { e.audio.capture.started.uncertaintyMs = 0; },
	];
	for (const mutate of cases) {
		const evidence = responseEvidence();
		mutate(evidence);
		assert.equal(evaluate("response", evidence).status, "unknown");
	}
});

test("touching or overlapping bounded observations are unknown, proven reversed order fails", () => {
	for (const before of [150, 151]) {
		const evidence = responseEvidence();
		evidence.audio.output.started.uncertaintyMs.before = before;
		assert.equal(evaluate("response", evidence).status, "unknown");
	}
	const reversed = responseEvidence();
	reversed.audio.capture.started.atMs = 360;
	assert.equal(evaluate("response", reversed).status, "failed");
});

test("generation completion and later received drain are separate; unrelated optional clocks stay unbound", () => {
	const evidence = responseEvidence();
	assert.ok(evidence.audio.output.drained.atMs > evidence.response.generation.completed.atMs);
	const generation = structuredClone(evidence.response.generation);
	assert.equal(evaluate("response", evidence).status, "pass");
	assert.deepEqual(evidence.response.generation, generation);
	Object.assign(evidence.response.generation.completed, {
		clockId: "backend.monotonic", clockOrigin: "backend.process", atMs: 9000, uncertaintyMs: null,
	});
	assert.equal(evaluate("response", evidence).status, "pass", "no cross-clock generation/playout ordering is invented");
});

test("unsuccessful generation, cleared output and competing response media cannot qualify", () => {
	const cases = [
		...["failed", "cancelled", "incomplete"].map((status) => (e) => { e.response.generation.status = status; }),
		(e) => { e.audio.output.status = "cleared"; },
		(e) => { e.audio.output.responseId = "response.other"; },
		(e) => { e.audio.membership.history.responseIds.push("response.greeting"); },
		(e) => { e.audio.membership.history.responseIds.push("response.other"); },
	];
	for (const mutate of cases) {
		const evidence = responseEvidence();
		mutate(evidence);
		assert.equal(evaluate("response", evidence).status, "failed");
	}
	for (const mutate of [
		(e) => { delete e.response.generation; },
		(e) => { delete e.audio.output.drained; },
		(e) => { e.audio.membership.history.responseIds = []; },
	]) {
		const evidence = responseEvidence();
		mutate(evidence);
		assert.equal(evaluate("response", evidence).status, "unknown");
	}
});

test("the historical 660ms mechanics-only summary remains unknown without invented live identities", () => {
	const mechanicsOnly = {
		decodedPcm: { frames: 15840, sampleRate: 24000, decodedDurationMs: 660 },
		controlDurationMs: 1001,
		independentCapturedFirstLastSampleAnchors: null,
		responseEnvelope: null,
	};
	assert.equal(evaluate("response", mechanicsOnly).status, "unknown");
});

test("stage deadlines, cancellation, observed failure and missing evidence terminate honestly", () => {
	assert.equal(evaluate("readiness", readiness(), { nowMs: 1000 }).status, "timeout");
	assert.equal(evaluate("response", responseEvidence(), { cancelled: true }).status, "cancelled");
	assert.equal(evaluate("readiness", { failure: "session-rejected" }).status, "failed");
	assert.equal(evaluate("response", {}).status, "unknown");
	assert.equal(evaluate("response", responseEvidence(), { evidenceRefs: [] }).status, "unknown");
	assert.equal(evaluate("readiness", readiness(), { nowMs: -1 }).status, "unknown");
});
