import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import {
	installVoiceInput,
	armVoiceCapture,
} from "../scripts/lib/voice-capture.mjs";
import { launchBrowser } from "../scripts/lib/browser.mjs";
import {
	ProcRegistry,
	withCancellation,
} from "../scripts/lib/proc-registry.mjs";
import { toolPaths } from "../scripts/lib/toolchain.mjs";
import { ffmpegRun } from "../scripts/lib/export-check.mjs";
import { readWav, writeWav } from "../scripts/lib/audio.mjs";
import {
	startFrameCapture,
	finalizeCapture,
	readPageBytes,
	saveOriginalBlob,
} from "../scripts/lib/recording.mjs";
import { holdMediaLock, makeTempDir } from "./helpers.mjs";
import process from "node:process";

test("voice page functions serialize without repository or Node dependencies", () => {
	for (const fn of [installVoiceInput, armVoiceCapture]) {
		const restored = new Function(`return (${fn.toString()})`)();
		assert.equal(typeof restored, "function");
		assert.doesNotMatch(fn.toString(), /node:|\/home\/|localhost|process\.env/);
	}
});

test(
	"recorder startup failure cleans up and cannot hang finalization",
	{ timeout: 1000 },
	async () => {
		let closed = 0;
		let tracksStopped = 0;
		const node = {
			connect() {},
			disconnect() {},
			start() {},
			stop() {},
			offset: {},
		};
		const element = {
			tagName: "AUDIO",
			paused: false,
			srcObject: {},
			addEventListener() {},
			removeEventListener() {},
			captureStream: () => ({ getAudioTracks: () => [{}] }),
		};
		const context = vm.createContext({
			Document: class {
				createElement() {
					return element;
				}
			},
			document: { querySelectorAll: () => [element] },
			AudioContext: class {
				state = "running";
				async resume() {}
				createMediaStreamDestination() {
					return {
						stream: {
							getTracks: () => [
								{
									stop() {
										tracksStopped++;
									},
								},
							],
						},
					};
				}
				createMediaStreamSource() {
					return node;
				}
				createConstantSource() {
					return node;
				}
				createAnalyser() {
					return {};
				}
				async close() {
					this.state = "closed";
					closed++;
				}
			},
			MediaRecorder: class {
				addEventListener() {}
				start() {
					throw new Error("controlled recorder startup failure");
				}
			},
		});
		vm.runInContext(`(${armVoiceCapture.toString()})()`, context);
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.match(
			vm.runInContext("__sdpVoiceCapture.status().error", context),
			/controlled recorder startup failure/,
		);
		assert.equal(
			await vm.runInContext("__sdpVoiceCapture.stop()", context),
			null,
		);
		assert.equal(closed, 1);
		assert.equal(tracksStopped, 1);
	},
);

test("stopping during asynchronous audio startup waits for cleanup without starting a recorder", { timeout: 1000 }, async () => {
	let resume;
	let closed = 0;
	let recorders = 0;
	const element = {
		tagName: "AUDIO", paused: false,
		addEventListener() {}, removeEventListener() {},
		captureStream: () => ({ getAudioTracks: () => [{}] }),
	};
	const context = vm.createContext({
		Document: class { createElement() { return element; } },
		document: { querySelectorAll: () => [element] },
		AudioContext: class {
			state = "running";
			resume() { return new Promise((resolve) => { resume = resolve; }); }
			async close() { this.state = "closed"; closed++; }
		},
		MediaRecorder: class { constructor() { recorders++; } },
	});
	vm.runInContext(`(${armVoiceCapture.toString()})()`, context);
	let finished = false;
	const stop = vm.runInContext("__sdpVoiceCapture.stop()", context).then((value) => { finished = true; return value; });
	await Promise.resolve();
	assert.equal(finished, false);
	resume();
	assert.equal(await stop, null);
	assert.equal(closed, 1);
	assert.equal(recorders, 0);
});

test(
	"browser voice primitives retain timed silence and never use a physical microphone",
	{
		skip:
			!process.env.SDP_RUNTIME_DIR &&
			"optional pinned browser/media runtime not supplied",
	},
	async (t) => {
		await holdMediaLock(t);
		const temp = makeTempDir();
		t.after(temp.cleanup);
		const paths = toolPaths(process.env.SDP_RUNTIME_DIR);
		const registry = new ProcRegistry({
			logFile: path.join(temp.dir, "processes.jsonl"),
		});
		const controller = new AbortController();
		const timer = setTimeout(
			() => controller.abort(new Error("voice check deadline")),
			60_000,
		);
		let browser;
		try {
			await withCancellation(controller.signal, async () => {
				const origin = "http://127.0.0.1:43129";
				browser = await launchBrowser({
					paths,
					dir: temp.dir,
					registry,
					origins: [origin],
					recordVideo: false,
					signal: controller.signal,
				});
				const page = await browser.context.newPage();
				await assert.rejects(
					page.evaluate(installVoiceInput),
					/secure capture context/,
				);
				await page.route(`${origin}/`, (route) =>
					route.fulfill({
						contentType: "text/html",
						body: "<button>Play controlled input</button>",
					}),
				);
				await page.goto(origin);
				const samples = new Float32Array(24000 * 3);
				for (let i = 0; i < samples.length; i++) {
					if (i < 24000 || i >= 48000)
						samples[i] = Math.sin((i / 24000) * Math.PI * 880) * 0.1;
				}
				const source = path.join(temp.dir, "input.wav");
				writeWav(source, samples, 24000);
				await page.evaluate(installVoiceInput);
				await page.evaluate(armVoiceCapture);
				await assert.rejects(
					page.evaluate(() =>
						globalThis.navigator.mediaDevices.getUserMedia({
							audio: true,
							video: true,
						}),
					),
					/audio-only/,
				);
				await assert.rejects(
					page.evaluate(() =>
						globalThis.__sdpVoiceInput.queue({ wavBase64: "" }),
					),
					/invalid/,
				);
				await page.evaluate((wavBase64) => {
					globalThis.document.querySelector("button").onclick = async () => {
						const stream = await globalThis.navigator.mediaDevices.getUserMedia(
							{
								audio: true,
								video: false,
							},
						);
						const audio = globalThis.document.createElement("audio");
						audio.srcObject = stream;
						globalThis.document.body.append(audio);
						await audio.play();
						globalThis.inputTiming = await globalThis.__sdpVoiceInput.queue({
							wavBase64,
						});
					};
				}, fs.readFileSync(source).toString("base64"));
				const frameDir = path.join(temp.dir, "frames");
				fs.mkdirSync(frameDir);
				const screen = await startFrameCapture({ page, outDir: frameDir });
				await page.getByRole("button").click();
				await page.waitForFunction(() => Boolean(globalThis.inputTiming));
				await page.waitForTimeout(3600);
				const file = path.join(temp.dir, "captured.webm");
				const finalized = await finalizeCapture({
					stopScreen: () => screen.stop(),
					stopAudio: () =>
						page.evaluate(() => globalThis.__sdpVoiceCapture.stop()),
					saveAudio: async (metadata) => {
						const count = screen.frames.length;
						await page.waitForTimeout(300);
						const saved = await saveOriginalBlob({
							outDir: temp.dir,
							file: "captured.webm",
							expectedBytes: metadata.byteLength,
							readBlob: () =>
								readPageBytes({
									expectedBytes: metadata.byteLength,
									chunkBytes: 1024,
									readChunk: (range) =>
										page.evaluate(({ offset, length }) => {
											const chunk = globalThis.__sdpVoiceCapture
												.readOriginal()
												.subarray(offset, offset + length);
											return globalThis.btoa(String.fromCharCode(...chunk));
										}, range),
								}),
						});
						assert.equal(
							screen.frames.length,
							count,
							"transfer must not extend screen capture",
						);
						return saved;
					},
				});
				assert.equal(finalized.screenError, undefined);
				assert.equal(finalized.audioError, undefined);
				assert.ok(finalized.screen.frames.length > 10);
				assert.ok(
					Math.max(
						...finalized.screen.frames.map((frame) => frame.uncertaintyMs),
					) < 500,
				);
				const capture = finalized.audio.metadata;
				assert.equal(capture.error, null);
				assert.ok(capture.activityWindowMs > 0);
				assert.ok(capture.activity.some((event) => event.active));
				await page.evaluate(() => globalThis.__sdpVoiceInput.stop());
				await browser.close();
				browser = null;
				const wav = path.join(temp.dir, "captured.wav");
				await ffmpegRun(
					paths,
					[
						"-n",
						"-i",
						file,
						"-ac",
						"1",
						"-ar",
						"24000",
						"-c:a",
						"pcm_s16le",
						wav,
					],
					{ PATH: "/usr/bin:/bin", HOME: temp.dir, TMPDIR: temp.dir },
				);
				const decoded = readWav(wav);
				assert.ok(
					Math.abs(
						decoded.samples.length / decoded.sampleRate -
							(capture.stoppedAt - capture.startedAt) / 1000,
					) < 0.2,
				);
				const rms = (start, end) => {
					const values = decoded.samples.slice(start * 24000, end * 24000);
					return Math.sqrt(
						values.reduce((sum, value) => sum + value * value, 0) /
							values.length,
					);
				};
				assert.ok(rms(0.3, 0.7) > 0.01);
				assert.ok(rms(1.4, 1.8) < 0.001);
				assert.ok(rms(2.4, 2.8) > 0.01);
			});
		} finally {
			if (browser) await browser.close();
			await registry.stopAll(500);
			clearTimeout(timer);
			assert.deepEqual(registry.survivors(), []);
		}
	},
);
