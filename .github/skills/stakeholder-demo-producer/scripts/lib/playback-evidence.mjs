import { createHash } from "node:crypto";

const nonempty = (value) => typeof value === "string" && value.trim().length > 0;
const finite = (value) => Number.isFinite(value) && value >= 0;

/** Checks adapter-normalized observations, not provider causality or physical playback. */
export function checkActionChronology({
	baseline, input, accepted, toolPairs, receivedAudio, playouts, outcomeRefs,
}) {
	const unknown = (reason) => ({ status: "unknown", reason, scope: "supplied owned-action observations only" });
	if (!baseline?.drained || baseline.oneActionInFlight !== true ||
		!finite(baseline.atMs) || !Number.isSafeInteger(baseline.sequence) ||
		!nonempty(baseline.clockId)) return unknown("baseline-not-observed-drained");
	const current = (event) => event && event.clockId === baseline.clockId &&
		Number.isSafeInteger(event.sequence) && event.sequence > baseline.sequence &&
		finite(event.atMs) && event.atMs > baseline.atMs;
	if (!current(input) || !nonempty(input.actionId) || !finite(input.endMs) ||
		input.endMs <= input.atMs || !current(accepted) ||
		accepted.actionId !== input.actionId || accepted.atMs < input.endMs ||
		accepted.sequence <= input.sequence || !nonempty(accepted.text)) return unknown("input-chronology-ambiguous");
	if (!Array.isArray(toolPairs) || !toolPairs.length) return unknown("missing-tool-evidence");
	let previous = accepted;
	for (const pair of toolPairs) {
		const { call, result } = pair ?? {};
		if (!current(call) || !current(result) || !nonempty(call.id) ||
			call.actionId !== input.actionId || result.actionId !== input.actionId ||
			result.callId !== call.id || call.atMs < previous.atMs ||
			call.sequence <= previous.sequence || result.atMs < call.atMs ||
			result.sequence <= call.sequence || !nonempty(result.evidenceRef)) return unknown("tool-call-result-chronology-ambiguous");
		previous = result;
	}
	if (!Array.isArray(receivedAudio) || !receivedAudio.length ||
		!Array.isArray(playouts) || playouts.length !== receivedAudio.length) return unknown("missing-or-unmatched-playout");
	const sequences = new Set([input.sequence, accepted.sequence]);
	for (const pair of toolPairs) {
		for (const event of [pair.call, pair.result]) {
			if (sequences.has(event.sequence)) return unknown("duplicate-observation");
			sequences.add(event.sequence);
		}
	}
	const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
	for (const [index, audio] of receivedAudio.entries()) {
		const play = playouts[index];
		if (!current(audio) || !current(play) || sequences.has(audio.sequence) ||
			sequences.has(play.sequence) || audio.sequence === play.sequence) return unknown("stale-or-duplicate-playout");
		sequences.add(audio.sequence);
		sequences.add(play.sequence);
		if (!current(audio) || audio.actionId !== input.actionId ||
			audio.atMs < previous.atMs || audio.sequence <= previous.sequence ||
			!(audio.pcm instanceof Int16Array) || !audio.pcm.length ||
			!audio.pcm.some((sample) => sample !== 0) ||
			!Number.isInteger(audio.sampleRate) || audio.sampleRate < 8000 || audio.sampleRate > 96000 ||
			![1, 2].includes(audio.channels) || audio.pcm.length % audio.channels) return unknown("audio-source-or-chronology-ambiguous");
		const bytes = Buffer.alloc(audio.pcm.length * 2);
		audio.pcm.forEach((value, i) => bytes.writeInt16LE(value, i * 2));
		if (!current(play) || play.actionId !== input.actionId || play.sha256 !== hash(bytes) ||
			play.sequence <= audio.sequence || play.atMs < audio.atMs ||
			play.directOutput !== true || play.sampleRate !== audio.sampleRate ||
			play.channels !== audio.channels || play.playbackRate !== 1 || play.detune !== 0 ||
			play.loop !== false || play.interrupted !== false || !finite(play.startMs) ||
			play.startMs < play.atMs || !finite(play.endedAtMs) ||
			play.endedAtMs < play.startMs + audio.pcm.length / audio.channels / audio.sampleRate * 1000) return unknown("playout-identity-or-completion-ambiguous");
	}
	if (!Array.isArray(outcomeRefs) || !outcomeRefs.length || !outcomeRefs.every(nonempty)) return unknown("missing-observed-outcome");
	return {
		status: "pass",
		scope: "supplied owned-action observations only; not provider-turn or physical audio qualification",
		acceptedInput: accepted.text,
		queryTreatment: "retrieval queries may paraphrase accepted speech; validate relevant outcomes against source evidence",
		outcomeRefs: [...outcomeRefs],
	};
}

/** Compare early and late independently observed AV pairs without estimating a clock mapping. */
export function compareAvLandmarks(landmarks, { toleranceMs }) {
	if (!Array.isArray(landmarks) || landmarks.length < 2 ||
		!finite(toleranceMs) || !landmarks.every((entry) =>
			finite(entry.videoMs) && finite(entry.audioMs) && finite(entry.uncertaintyMs) &&
			nonempty(entry.evidenceRef))) throw new Error("at least two bounded AV landmarks are required");
	for (let i = 1; i < landmarks.length; i++) {
		if (landmarks[i].videoMs <= landmarks[i - 1].videoMs ||
			landmarks[i].audioMs <= landmarks[i - 1].audioMs) throw new Error("AV landmarks must be ordered early to late");
	}
	const offsets = landmarks.map((entry) => entry.audioMs - entry.videoMs);
	const driftMs = offsets.at(-1) - offsets[0];
	const aligned = offsets.every((offset, i) => Math.abs(offset) + landmarks[i].uncertaintyMs <= toleranceMs);
	const contradicted = offsets.some((offset, i) => Math.abs(offset) - landmarks[i].uncertaintyMs > toleranceMs);
	return {
		status: aligned ? "within-observed-bound" : contradicted ? "misaligned" : "unknown",
		offsetsMs: offsets,
		driftMs,
		scope: "supplied recorded landmarks; not a physical AV bound or proof between landmarks",
	};
}

/** Full transcript text is safe only when every associated playback completed. */
export function playbackCues(utterances, { journeyStartMs, journeyEndMs }) {
	if (!Array.isArray(utterances) || !finite(journeyStartMs) ||
		!finite(journeyEndMs) || journeyEndMs <= journeyStartMs) throw new Error("invalid caption journey bounds");
	return utterances.flatMap(({ text, role, plays, complete, expectedChunks, coverageRef }) => {
		if (!nonempty(text) || !nonempty(role) || !Array.isArray(plays) || !plays.length ||
			complete !== true || expectedChunks !== plays.length || !nonempty(coverageRef)) return [];
		if (plays.some((play) => !finite(play.startMs) || !finite(play.durationMs) ||
			play.durationMs <= 0 || !finite(play.endedAtMs) || play.interrupted !== false ||
			play.endedAtMs < play.startMs + play.durationMs)) return [];
		const startMs = journeyStartMs + Math.min(...plays.map((play) => play.startMs));
		const endMs = journeyStartMs + Math.max(...plays.map((play) => play.startMs + play.durationMs));
		// Clamping would caption unheard words when the journey itself ends early.
		if (startMs < journeyStartMs || endMs > journeyEndMs) return [];
		return [{ startMs, endMs, role, text }];
	});
}
