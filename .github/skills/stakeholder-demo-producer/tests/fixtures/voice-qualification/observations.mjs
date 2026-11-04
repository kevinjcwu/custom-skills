import { createHash } from "node:crypto";

// State/protocol fixtures, not a model of real Azure behavior.
export const captureScript = `(arg) => {
	if (!["arm", "speak"].includes(arg.operation)) throw new Error("unexpected operation");
	state.operations.push(arg.operation);
	return { synthetic: true, operation: arg.operation, count: state.operations.length };
}`;

export function readiness(atMs = 100) {
	return {
		sessionId: "session.current",
		snapshot: {
			sessionId: "session.current",
			atMs,
			label: "Listening",
			peerReady: true,
			inputEnabled: true,
			outputActive: false,
			responseIds: ["response.greeting"],
		},
	};
}

export function observation(meaning, atMs, overrides = {}) {
	return {
		sourceRef: `synthetic:${meaning}`,
		clockId: "browser.performance",
		clockOrigin: "document.current",
		meaning,
		atMs,
		uncertaintyMs: { before: 0, after: 0, basisRef: "synthetic:exact-clock" },
		...overrides,
	};
}

export function responseEvidence() {
	const samples = Int16Array.from({ length: 800 }, (_, index) => index % 2 ? 1000 : -1000);
	const bytes = Buffer.alloc(samples.length * 2);
	samples.forEach((sample, index) => bytes.writeInt16LE(sample, index * 2));
	const pcmSha256 = createHash("sha256").update(bytes).digest("hex");
	const originalSha256 = "1".repeat(64);
	const decodedSha256 = "2".repeat(64);
	return {
		clock: { id: "browser.performance", origin: "document.current" },
		sessionId: "session.current",
		baseline: { sessionId: "session.current", atMs: 100, responseIds: ["response.greeting"] },
		receiver: {
			sessionId: "session.current", peerId: "peer.app", trackId: "track.received",
			bindingRef: "synthetic:app-receiver-binding",
		},
		input: {
			sessionId: "session.current", id: "input.current", turnId: "turn.current",
			sentAtMs: 200, sent: observation("input-sent", 200),
			deliveryObserved: true, deliveryRef: "synthetic:accepted-input-item",
		},
		response: {
			sessionId: "session.current",
			id: "response.current",
			inputId: "input.current",
			turnId: "turn.current",
			associationRef: "synthetic:input-response-ledger",
			generation: { status: "completed", completed: observation("generation-completed-receipt", 500) },
		},
		audio: {
			sessionId: "session.current",
			responseId: "response.current",
			source: {
				sessionId: "session.current", peerId: "peer.app", trackId: "track.received",
				direction: "received", bindingRef: "synthetic:app-receiver-binding",
			},
			artifacts: {
				original: { ref: "synthetic:original-recording", sha256: originalSha256 },
				decoded: { ref: "synthetic:decoded-recording", sha256: decodedSha256, pcmSha256 },
				conversionRef: "synthetic:conversion-ledger",
			},
			membership: {
				kind: "response-bound-received-capture",
				sessionId: "session.current", responseId: "response.current",
				peerId: "peer.app", trackId: "track.received",
				bindingRef: "synthetic:app-receiver-binding",
				associationRef: "synthetic:input-response-ledger",
				originalSha256, decodedSha256, pcmSha256,
				isolationRef: "synthetic:response-isolation",
				coverageRef: "synthetic:received-media-coverage",
				history: {
					ref: "synthetic:output-history",
					responseIds: ["response.current"],
					baselineResponseIds: ["response.greeting"],
					gaps: [],
				},
			},
			capture: {
				started: observation("recorder-start-event", 150),
				finalized: observation("recorder-stop-event", 580),
			},
			output: {
				responseId: "response.current", status: "drained",
				started: observation("received-output-start", 350),
				drained: observation("received-output-drain", 550),
			},
			observations: [
				observation("render-clock", 10, { clockId: "audio.render", clockOrigin: "audio-context.current", uncertaintyMs: null }),
				observation("provider-relative", -5, { clockId: "provider.audio", clockOrigin: "provider-session.current", uncertaintyMs: null }),
			],
			// Synthetic samples and provenance references test policy, not source authentication.
			pcm: { bitDepth: 16, channels: 1, sampleRate: 8000, frames: 800, samples },
		},
	};
}
