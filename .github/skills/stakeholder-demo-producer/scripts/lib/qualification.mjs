import { createHash } from "node:crypto";

// Pure evidence checks only: no caller, scheduling, device or provider access.
const finite = (value) => Number.isFinite(value) && value >= 0;
const identifier = (value) => typeof value === "string" && value.trim().length > 0;
const identifiers = (value) => Array.isArray(value) && value.every(identifier) && new Set(value).size === value.length;
const digest = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const observation = (value, meaning = value?.meaning) => value?.meaning === meaning && identifier(meaning) &&
	identifier(value.sourceRef) && identifier(value.clockId) && identifier(value.clockOrigin) && Number.isFinite(value.atMs) &&
	(value.uncertaintyMs === null || (finite(value.uncertaintyMs?.before) && finite(value.uncertaintyMs?.after) &&
		identifier(value.uncertaintyMs.basisRef)));

// Compare only independently bounded observations on the same origin; never solve a clock mapping.
function order(before, after) {
	if (before.clockId !== after.clockId || before.clockOrigin !== after.clockOrigin ||
		before.uncertaintyMs === null || after.uncertaintyMs === null) return "unknown";
	if (before.atMs + before.uncertaintyMs.after < after.atMs - after.uncertaintyMs.before) return "before";
	if (before.atMs - before.uncertaintyMs.before > after.atMs + after.uncertaintyMs.after) return "reversed";
	return "unknown";
}

function pcmDigest(samples) {
	const bytes = Buffer.alloc(samples.length * 2);
	samples.forEach((sample, index) => bytes.writeInt16LE(sample, index * 2));
	return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Evaluate supplied evidence; only stage deadlines use the caller's single monotonic clock.
 * The caller owns deadlines, capture, attribution observations and cleanup.
 * Passing supplied evidence is not independent verification of its origin.
 */
export function evaluateQualification({ stage, startMs, nowMs, deadlineMs, evidence = {}, evidenceRefs = [], cancelled = false }) {
	const result = (status, code, nextAction, extra = {}) => ({
		stage,
		status,
		code,
		scope: "supplied-evidence-only",
		startMs,
		finishedMs: nowMs,
		elapsedMs: finite(nowMs) && finite(startMs) && nowMs >= startMs ? nowMs - startMs : null,
		evidenceRefs: Array.isArray(evidenceRefs) ? [...evidenceRefs] : [],
		nextAction,
		...extra,
	});
	const unknown = (code, nextAction) => result("unknown", code, nextAction);
	const failed = (code, nextAction) => result("failed", code, nextAction);
	if (!finite(startMs) || !finite(nowMs) || !finite(deadlineMs) || nowMs < startMs || deadlineMs < startMs) {
		return unknown("clock-unknown", "Supply ordered stage timestamps on one monotonic clock.");
	}
	if (cancelled) return result("cancelled", "cancelled", "Run the existing owned-resource cleanup.");
	if (nowMs >= deadlineMs) return result("timeout", "stage-timeout", "Stop this stage and run the existing owned-resource cleanup.");
	if (!["readiness", "before-input", "response"].includes(stage)) {
		return unknown("unsupported-stage", "Use a supported evidence stage; do not infer an integration result.");
	}
	if (!evidence || typeof evidence !== "object" || !identifiers(evidenceRefs) || evidenceRefs.length === 0) {
		return unknown("evidence-missing", "Supply this stage's recorded evidence references.");
	}
	if (evidence.failure) return result("failed", "stage-failed", "Inspect the recorded stage failure and clean up; do not retry automatically.");

	const { sessionId, baseline } = evidence;
	if (!identifier(sessionId)) return unknown("session-unknown", "Identify the current fresh session.");
	const validBaseline = () => baseline?.sessionId === sessionId && finite(baseline.atMs) && identifiers(baseline.responseIds);

	if (stage === "readiness" || stage === "before-input") {
		const snapshot = evidence.snapshot;
		if (!snapshot || snapshot.sessionId !== sessionId || snapshot.atMs !== nowMs ||
			!identifiers(snapshot.responseIds) || !["peerReady", "inputEnabled", "outputActive"].every((key) => typeof snapshot[key] === "boolean")) {
			return unknown("readiness-unknown", "Observe current-session input/output gates immediately before input; a presentation label is insufficient.");
		}
		if (stage === "before-input" && (!validBaseline() || baseline.atMs > nowMs)) {
			return unknown("baseline-unknown", "Capture a current-session response baseline before preparing input.");
		}
		if (!snapshot.peerReady || !snapshot.inputEnabled || snapshot.outputActive) {
			return result("wait", "not-ready", "Observe readiness again within the existing deadline; do not send speech.");
		}
		if (stage === "before-input" && (baseline.responseIds.length !== snapshot.responseIds.length ||
			snapshot.responseIds.some((id) => !baseline.responseIds.includes(id)))) {
			return result("wait", "baseline-invalidated", "A response changed after the baseline; re-establish readiness and baseline before input.");
		}
		return result("pass", "ready-for-input", "Recheck these same-session gates at the actual input boundary.", {
			baseline: { sessionId, atMs: nowMs, responseIds: [...snapshot.responseIds] },
		});
	}

	const { input, response, audio, receiver, clock } = evidence;
	if (!validBaseline() || !input || !response || !audio ||
		![input.sessionId, response.sessionId, audio.sessionId, input.id, input.turnId, response.id,
			response.inputId, response.turnId, audio.responseId].every(identifier)) {
		return unknown("attribution-unknown", "Supply current-session input, normalized causal identities and received media; never infer them from time or order.");
	}
	if (input.sessionId !== sessionId || response.sessionId !== sessionId || audio.sessionId !== sessionId ||
		response.inputId !== input.id || response.turnId !== input.turnId || audio.responseId !== response.id ||
		baseline.responseIds.includes(response.id)) {
		return failed("attribution-contradiction", "Stop this qualification: supplied identities identify another session, input, response or prior output.");
	}
	if (input.deliveryObserved !== true || !identifier(input.deliveryRef) || !identifier(response.associationRef)) {
		return unknown("association-unknown", "Preserve actual input receipt and authoritative input/response ledger references.");
	}
	if (!finite(input.sentAtMs)) return unknown("input-time-unknown", "Supply the input observation on the stage clock.");
	if (baseline.atMs > input.sentAtMs || input.sentAtMs < startMs || input.sentAtMs > nowMs) {
		return failed("input-order-contradiction", "Stop: the supplied input contradicts its baseline or stage interval.");
	}
	const generation = response.generation;
	if (!identifier(generation?.status)) return unknown("generation-unknown", "Supply this response's actual generation status.");
	if (["failed", "cancelled", "incomplete"].includes(generation.status)) {
		return failed("generation-unsuccessful", "Preserve the unsuccessful response status; do not diagnose a provider fault from qualification alone.");
	}
	if (generation.status !== "completed") return unknown("generation-unknown", "Observe a completed response within the existing deadline.");

	const pcm = audio.pcm;
	if (pcm === undefined || pcm === null) return unknown("media-unknown", "Supply actual decoded PCM, not a transcript or media label.");
	if (typeof pcm !== "object" || Array.isArray(pcm)) {
		return failed("media-invalid", "Stop: the supplied PCM record is malformed.");
	}
	if (["bitDepth", "channels", "sampleRate", "samples", "frames"].some((key) => pcm[key] === undefined || pcm[key] === null)) {
		return unknown("media-unknown", "Supply the missing decoded format, frame count and sample data; absence is not a measured contradiction.");
	}
	if (pcm.bitDepth !== 16 || ![1, 2].includes(pcm.channels) ||
		!Number.isInteger(pcm.sampleRate) || pcm.sampleRate < 8000 || pcm.sampleRate > 96000 ||
		!(pcm.samples instanceof Int16Array) || pcm.samples.length === 0 || pcm.samples.length % pcm.channels !== 0) {
		return failed("media-invalid", "Stop: supplied decoded PCM is empty, malformed or outside the supported format.");
	}
	const frames = pcm.samples.length / pcm.channels;
	if (!Number.isSafeInteger(pcm.frames) || pcm.frames !== frames) {
		return failed("frames-contradiction", "Stop: the declared frame count contradicts the interleaved decoded samples.");
	}
	if (!pcm.samples.some((sample) => sample !== 0)) {
		return failed("media-silent", "The captured candidate is digital silence, not a received audible reply.");
	}
	const { source, artifacts, membership, capture, output } = audio;
	if (!receiver || !source || ![receiver.sessionId, receiver.peerId, receiver.trackId, receiver.bindingRef,
		source.sessionId, source.peerId, source.trackId, source.direction, source.bindingRef].every(identifier)) {
		return unknown("source-unknown", "Supply the actual app peer/receiver binding and received-track provenance.");
	}
	if (receiver.sessionId !== sessionId || source.sessionId !== sessionId || source.direction !== "received" ||
		source.peerId !== receiver.peerId || source.trackId !== receiver.trackId || source.bindingRef !== receiver.bindingRef) {
		return failed("source-contradiction", "Stop: the supplied media belongs to another peer, track, direction or source binding.");
	}
	if (![artifacts?.original?.ref, artifacts?.decoded?.ref, artifacts?.conversionRef,
		artifacts?.original?.sha256, artifacts?.decoded?.sha256, artifacts?.decoded?.pcmSha256].every(identifier)) {
		return unknown("artifacts-unknown", "Preserve original/decoded artifact hashes, PCM digest and conversion provenance.");
	}
	if (![artifacts.original.sha256, artifacts.decoded.sha256, artifacts.decoded.pcmSha256].every(digest) ||
		pcmDigest(pcm.samples) !== artifacts.decoded.pcmSha256) {
		return failed("media-digest-contradiction", "Stop: decoded samples or artifact digest declarations contradict the supplied media record.");
	}
	if (membership?.kind !== "response-bound-received-capture" ||
		![membership.sessionId, membership.responseId, membership.peerId, membership.trackId, membership.bindingRef,
			membership.associationRef, membership.isolationRef, membership.coverageRef, membership.history?.ref,
			membership.originalSha256, membership.decodedSha256, membership.pcmSha256].every(identifier)) {
		return unknown("membership-unknown", "Supply response-specific media association, isolation, coverage and history evidence; a label or verification flag is insufficient.");
	}
	if (membership.sessionId !== sessionId || membership.responseId !== response.id ||
		membership.peerId !== receiver.peerId || membership.trackId !== receiver.trackId ||
		membership.bindingRef !== receiver.bindingRef || membership.associationRef !== response.associationRef ||
		membership.originalSha256 !== artifacts.original.sha256 || membership.decodedSha256 !== artifacts.decoded.sha256 ||
		membership.pcmSha256 !== artifacts.decoded.pcmSha256) {
		return failed("membership-contradiction", "Stop: the membership record does not bind this response, receiver and exact media.");
	}
	const history = membership.history;
	if (!identifiers(history.responseIds) || !identifiers(history.baselineResponseIds) || !identifiers(history.gaps) ||
		history.gaps.length || history.responseIds.length === 0) {
		return unknown("history-unknown", "Require complete current-session output history; gaps cannot establish isolation.");
	}
	if (history.responseIds.some((id) => id !== response.id)) {
		return failed("competing-output", "Stop: greeting, prior or competing response media contaminates this one-reply candidate.");
	}
	if (history.baselineResponseIds.length !== baseline.responseIds.length ||
		baseline.responseIds.some((id) => !history.baselineResponseIds.includes(id))) {
		return unknown("isolation-unknown", "Preserve the actual pre-input baseline and evidence excluding its output.");
	}
	if (!identifier(output?.responseId) || !identifier(output?.status)) {
		return unknown("output-unknown", "Supply response-specific received-output/drain evidence separately from generation.");
	}
	if (output.responseId !== response.id || output.status === "cleared") {
		return failed("output-contradiction", "Stop: another response or interrupted output cannot qualify as this complete reply.");
	}
	if (output.status !== "drained") return unknown("output-unknown", "Observe received-output drain within the existing deadline.");

	const controls = [capture?.started, input.sent, output.started, output.drained, capture?.finalized];
	const meanings = ["recorder-start-event", "input-sent", "received-output-start", "received-output-drain", "recorder-stop-event"];
	const extraObservations = audio.observations ?? [];
	if (!identifier(clock?.id) || !identifier(clock?.origin) ||
		!controls.every((entry, index) => observation(entry, meanings[index])) ||
		!observation(generation.completed, "generation-completed-receipt") ||
		!Array.isArray(extraObservations) || !extraObservations.every((entry) => observation(entry))) {
		return unknown("timing-unknown", "Preserve each observation's source, origin, meaning and explicit uncertainty; unknown is not zero.");
	}
	if (controls.some((entry) => entry.clockId !== clock.id || entry.clockOrigin !== clock.origin)) {
		return unknown("timing-unknown", "Necessary observations on different clocks are incomparable without a separately established mapping.");
	}
	if (input.sent.atMs !== input.sentAtMs || controls.some((entry) => entry.atMs < startMs || entry.atMs > nowMs)) {
		return failed("timing-contradiction", "Stop: supplied control observations contradict the stage clock or input fact.");
	}
	if (generation.completed.clockId === clock.id && generation.completed.clockOrigin === clock.origin &&
		(generation.completed.atMs < startMs || generation.completed.atMs > nowMs)) {
		return failed("generation-time-contradiction", "Stop: a generation receipt on the stage clock lies outside this observation interval.");
	}
	for (let index = 1; index < controls.length; index += 1) {
		const relation = order(controls[index - 1], controls[index]);
		if (relation === "reversed") return failed("timing-contradiction", "Stop: supplied bounded control/received-output observations establish reversed order.");
		if (relation !== "before") return unknown("timing-unknown", "Necessary event order is unproved: uncertainty is unknown, touching or overlapping.");
	}
	if (order(input.sent, generation.completed) === "reversed") {
		return failed("generation-time-contradiction", "Stop: comparable observations place generation completion before the input.");
	}
	return result("pass", "current-turn-audio", "Verify referenced source/ledger/artifact evidence in the trusted run path; human full-file review remains required.", {
		media: { frames, mediaDurationMs: frames / pcm.sampleRate * 1000, pcmSha256: artifacts.decoded.pcmSha256 },
		timing: {
			sampleClockMapping: null,
			observations: [...controls, generation.completed, ...extraObservations].map((entry) => ({
				sourceRef: entry.sourceRef, clockId: entry.clockId, clockOrigin: entry.clockOrigin,
				meaning: entry.meaning, atMs: entry.atMs,
				uncertaintyMs: entry.uncertaintyMs === null ? null : { ...entry.uncertaintyMs },
			})),
		},
	});
}
