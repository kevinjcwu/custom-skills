/**
 * Browser-page primitives, not an app integration. Install before app startup.
 * The run-local adapter owns selectors, permission, turn attribution and timing.
 * Each exported function is self-contained for page.evaluate/addInitScript.
 */
export async function installVoiceInput() {
	if (globalThis.__sdpVoiceInput)
		throw new Error("voice input already installed");
	if (
		!globalThis.navigator?.mediaDevices?.getUserMedia ||
		!globalThis.AudioContext
	) {
		throw new Error(
			"generated voice requires a supported browser and secure capture context",
		);
	}
	const context = new globalThis.AudioContext();
	const destination = context.createMediaStreamDestination();
	const silence = context.createConstantSource();
	silence.offset.value = 0;
	silence.connect(destination);
	silence.start();
	const original = globalThis.navigator.mediaDevices.getUserMedia;
	const sources = new Set();
	let issued = false;
	let stopped = false;
	const generated = async (constraints) => {
		if (!constraints?.audio || constraints.video) {
			throw new Error(
				"generated voice supports audio-only capture; another adapter is required",
			);
		}
		if (stopped || issued)
			throw new Error("generated input is stopped or already consumed");
		issued = true;
		await context.resume();
		return destination.stream;
	};
	globalThis.navigator.mediaDevices.getUserMedia = generated;
	globalThis.__sdpVoiceInput = {
		async queue({ wavBase64 }) {
			if (
				stopped ||
				typeof wavBase64 !== "string" ||
				!wavBase64 ||
				wavBase64.length > 16 * 1024 * 1024
			) {
				throw new Error("invalid generated input");
			}
			const bytes = Uint8Array.from(globalThis.atob(wavBase64), (char) =>
				char.charCodeAt(0),
			);
			const decoded = await context.decodeAudioData(bytes.buffer);
			if (stopped) throw new Error("generated input stopped while decoding");
			await context.resume();
			const source = context.createBufferSource();
			source.buffer = decoded;
			source.connect(destination);
			sources.add(source);
			source.onended = () => {
				sources.delete(source);
				source.disconnect();
			};
			const when = context.currentTime + 0.05;
			const startMs = globalThis.performance.now() + 50;
			source.start(when);
			return {
				startMs,
				durationSeconds: decoded.duration,
				sampleRate: decoded.sampleRate,
			};
		},
		async stop() {
			if (stopped) return;
			stopped = true;
			if (globalThis.navigator.mediaDevices.getUserMedia === generated) {
				globalThis.navigator.mediaDevices.getUserMedia = original;
			}
			for (const source of sources) {
				source.stop();
				source.disconnect();
			}
			silence.stop();
			silence.disconnect();
			for (const track of destination.stream.getTracks()) track.stop();
			await context.close();
		},
	};
	return { ready: true, provenance: "generated; not application output" };
}

export function armVoiceCapture({
	selector = null,
	maxBytes = 16 * 1024 * 1024,
} = {}) {
	if (globalThis.__sdpVoiceCapture)
		throw new Error("voice capture already installed");
	if (
		(selector !== null && (typeof selector !== "string" || !selector)) ||
		!Number.isSafeInteger(maxBytes) ||
		maxBytes < 1 ||
		maxBytes > 16 * 1024 * 1024
	) {
		throw new Error("invalid voice capture options");
	}
	// Validate before installing the hook.
	const existing = globalThis.document.querySelectorAll(selector ?? "audio");
	const prototype = globalThis.Document.prototype;
	const originalCreate = prototype.createElement;
	const listeners = [];
	let sink;
	let recorder;
	let context;
	let source;
	let keepAlive;
	let destination;
	let timer;
	let finished;
	let starting = false;
	let startup;
	let stopped = false;
	let bytes;
	let error = null;
	let startedAt = null;
	let stoppedAt = null;
	let firstAudibleAt = null;
	let lastAudibleAt = null;
	let active = false;
	let activityWindowMs = null;
	const activity = [];
	const status = () => ({
		startedAt,
		firstAudibleAt,
		lastAudibleAt,
		active,
		error,
		activityWindowMs,
		activityThresholdRms: 0.0005,
	});
	const start = async (element) => {
		if (stopped || error || (selector && !element.matches(selector))) return;
		if (sink && element !== sink) {
			error =
				"ambiguous audio output; bind a selector in the run-local adapter";
			return;
		}
		if (recorder || starting) return;
		starting = true;
		sink = element;
		try {
			if (typeof element.captureStream !== "function")
				throw new Error("audio captureStream unavailable");
			const stream = element.captureStream();
			if (!stream.getAudioTracks().length)
				throw new Error("audio output track unavailable");
			context = new globalThis.AudioContext();
			await context.resume();
			if (stopped) {
				await context.close();
				return;
			}
			destination = context.createMediaStreamDestination();
			source = context.createMediaStreamSource(stream);
			source.connect(destination);
			keepAlive = context.createConstantSource();
			keepAlive.offset.value = 0;
			keepAlive.connect(destination);
			keepAlive.start();
			const analyser = context.createAnalyser();
			analyser.fftSize = 1024;
			activityWindowMs = (analyser.fftSize / context.sampleRate) * 1000;
			source.connect(analyser);
			recorder = new globalThis.MediaRecorder(destination.stream);
			const chunks = [];
			let byteLength = 0;
			recorder.addEventListener("dataavailable", (event) => {
				byteLength += event.data.size;
				if (byteLength > maxBytes) {
					error = "voice capture byte limit reached; original is incomplete";
					if (recorder.state !== "inactive") recorder.stop();
				} else if (event.data.size) chunks.push(event.data);
			});
			recorder.addEventListener("start", () => {
				startedAt = globalThis.performance.now();
			});
			finished = new Promise((resolve, reject) => {
				recorder.addEventListener(
					"stop",
					async () => {
						try {
							stoppedAt ??= globalThis.performance.now();
							globalThis.clearInterval(timer);
							bytes = new Uint8Array(
								await new globalThis.Blob(chunks, {
									type: recorder.mimeType,
								}).arrayBuffer(),
							);
							source.disconnect();
							keepAlive.stop();
							keepAlive.disconnect();
							for (const track of destination.stream.getTracks()) track.stop();
							await context.close();
							resolve({
								...status(),
								stoppedAt,
								byteLength: bytes.length,
								mimeType: recorder.mimeType,
								activity,
							});
						} catch (failure) {
							reject(failure);
						}
					},
					{ once: true },
				);
				recorder.addEventListener("error", (event) => {
					error = String(event.error?.message ?? "voice recorder failed");
					if (recorder.state !== "inactive") recorder.stop();
				}, { once: true });
			});
			finished.catch(() => {});
			recorder.start(250);
			const samples = new Float32Array(analyser.fftSize);
			timer = globalThis.setInterval(() => {
				analyser.getFloatTimeDomainData(samples);
				const audible =
					Math.sqrt(
						samples.reduce((sum, value) => sum + value * value, 0) /
							samples.length,
					) > 0.0005;
				const now = globalThis.performance.now();
				if (audible !== active) {
					active = audible;
					activity.push({
						pageMs: now,
						audioSeconds: context.currentTime,
						active,
					});
				}
				if (audible) {
					firstAudibleAt ??= now;
					lastAudibleAt = now;
				}
			}, 50);
		} catch (failure) {
			error = String(failure.message ?? failure);
			recorder = null;
			source?.disconnect();
			if (keepAlive) {
				keepAlive.stop();
				keepAlive.disconnect();
			}
			for (const track of destination?.stream.getTracks() ?? []) track.stop();
			if (context?.state !== "closed") await context?.close();
		} finally {
			starting = false;
		}
	};
	const watch = (element) => {
		if (element.tagName !== "AUDIO") return;
		const playing = () => {
			if (starting) {
				if (sink !== element && (!selector || element.matches(selector)))
					error = "ambiguous audio output; bind a selector in the run-local adapter";
				return;
			}
			startup = start(element);
		};
		element.addEventListener("playing", playing);
		listeners.push(() => element.removeEventListener("playing", playing));
		if (!element.paused) playing();
	};
	const hookedCreate = function (name, options) {
		const element = Reflect.apply(originalCreate, this, [name, options]);
		watch(element);
		return element;
	};
	prototype.createElement = hookedCreate;
	globalThis.__sdpVoiceCapture = {
		status,
		async stop() {
			stopped = true;
			if (prototype.createElement === hookedCreate)
				prototype.createElement = originalCreate;
			for (const remove of listeners) remove();
			await startup;
			if (!recorder) {
				if (context && context.state !== "closed") await context.close();
				return null;
			}
			if (recorder.state !== "inactive") {
				stoppedAt = globalThis.performance.now();
				recorder.stop();
			}
			return finished;
		},
		readOriginal() {
			if (!bytes) throw new Error("voice original not finalized");
			return bytes;
		},
	};
	for (const element of existing) watch(element);
	return {
		armed: true,
		selector,
		provenance: "helper-captured; source unverified",
	};
}
