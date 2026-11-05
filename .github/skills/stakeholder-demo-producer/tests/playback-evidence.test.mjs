import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { checkActionChronology, compareAvLandmarks, playbackCues } from "../scripts/lib/playback-evidence.mjs";

function action() {
	const event = (sequence, atMs, extra = {}) => ({ sequence, atMs, clockId: "page", actionId: "owned-action", ...extra });
	const pcm = new Int16Array(240);
	pcm.fill(1200);
	const bytes = Buffer.alloc(pcm.length * 2);
	pcm.forEach((value, i) => bytes.writeInt16LE(value, i * 2));
	return {
		baseline: { sequence: 10, atMs: 100, clockId: "page", drained: true, oneActionInFlight: true },
		input: event(11, 110, { endMs: 200 }),
		accepted: event(12, 210, { text: "Who must approve this request?" }),
		toolPairs: [{
			call: event(13, 220, { id: "retrieval", query: "Required approval authority" }),
			result: event(14, 230, { callId: "retrieval", evidenceRef: "source-backed-result" }),
		}],
		receivedAudio: [event(15, 240, { pcm, sampleRate: 24000, channels: 1 })],
		playouts: [event(16, 250, {
			sha256: createHash("sha256").update(bytes).digest("hex"),
			directOutput: true, sampleRate: 24000, channels: 1, playbackRate: 1,
			detune: 0, loop: false, interrupted: false, startMs: 250, endedAtMs: 260,
		})],
		outcomeRefs: ["observed-relevant-answer-and-rendered-source"],
	};
}

test("owned-action evidence accepts a paraphrased query without conflating it with actual speech", () => {
	const evidence = action();
	const result = checkActionChronology(evidence);
	assert.equal(result.status, "pass");
	assert.equal(result.acceptedInput, evidence.accepted.text);
	assert.match(result.scope, /not provider-turn/);
});

test("stale, overlapping, unbound, incomplete and wrong-identity audio stay unknown", () => {
	for (const mutate of [
		(e) => { e.baseline.drained = false; },
		(e) => { e.baseline.oneActionInFlight = false; },
		(e) => { e.accepted.sequence = 9; },
		(e) => { e.accepted.actionId = "prior-action"; },
		(e) => { e.toolPairs[0].call.atMs = 180; },
		(e) => { e.toolPairs[0].result.callId = "other-call"; },
		(e) => { e.receivedAudio[0].atMs = 150; },
		(e) => { e.playouts[0].sha256 = "0".repeat(64); },
		(e) => { e.playouts[0].interrupted = true; },
		(e) => { e.playouts[0].endedAtMs = null; },
		(e) => { e.playouts[0].endedAtMs = 255; },
		(e) => { e.playouts[0].startMs = 1000; },
		(e) => { e.playouts[0].directOutput = false; },
		(e) => { e.outcomeRefs = []; },
		(e) => { e.receivedAudio.push(e.receivedAudio[0]); e.playouts.push(e.playouts[0]); },
		(e) => { e.toolPairs = [null]; },
	]) {
		const evidence = action();
		mutate(evidence);
		assert.equal(checkActionChronology(evidence).status, "unknown");
	}
});

test("early and late AV checks expose accumulating drift and retain uncertain results", () => {
	const landmarks = [
		{ videoMs: 1000, audioMs: 1020, uncertaintyMs: 10, evidenceRef: "early" },
		{ videoMs: 20000, audioMs: 20400, uncertaintyMs: 10, evidenceRef: "late" },
	];
	const result = compareAvLandmarks(landmarks, { toleranceMs: 80 });
	assert.equal(result.status, "misaligned");
	assert.equal(result.driftMs, 380);
	assert.equal(compareAvLandmarks([landmarks[0], { ...landmarks[1], audioMs: 20030 }], { toleranceMs: 80 }).status, "within-observed-bound");
	assert.equal(compareAvLandmarks([landmarks[0], { ...landmarks[1], audioMs: 20080 }], { toleranceMs: 80 }).status, "unknown");
	assert.throws(() => compareAvLandmarks([landmarks[0]], { toleranceMs: 80 }), /two bounded/);
});

test("full captions omit interrupted, missing, partial and outro-crossing playouts", () => {
	const utterance = { role: "Assistant (actual app output)", text: "The complete answer.", complete: true, expectedChunks: 1, coverageRef: "all-associated-chunks", plays: [{ startMs: 100, durationMs: 200, endedAtMs: 300, interrupted: false }] };
	const bounds = { journeyStartMs: 1000, journeyEndMs: 2000 };
	assert.deepEqual(playbackCues([utterance], bounds), [{ role: utterance.role, text: utterance.text, startMs: 1100, endMs: 1300 }]);
	for (const play of [
		{ ...utterance.plays[0], interrupted: true },
		{ ...utterance.plays[0], endedAtMs: null },
		{ ...utterance.plays[0], endedAtMs: 250 },
		{ startMs: 900, durationMs: 200, endedAtMs: 1100, interrupted: false },
	]) assert.deepEqual(playbackCues([{ ...utterance, plays: [play] }], bounds), []);
	assert.deepEqual(playbackCues([{ ...utterance, plays: [] }], bounds), []);
	assert.deepEqual(playbackCues([{ ...utterance, complete: false }], bounds), []);
	assert.deepEqual(playbackCues([{ ...utterance, expectedChunks: 2 }], bounds), []);
});
