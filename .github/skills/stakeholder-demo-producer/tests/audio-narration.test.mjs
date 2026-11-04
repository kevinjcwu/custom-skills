import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { activeSegments, envelopeCorrelation, frameLevels, noiseFloor, readWav, toneLevel, toneOnsetMs, writeWav } from "../scripts/lib/audio.mjs";
import { splitSentences, synthesizeNarration, toWebVtt } from "../scripts/lib/narration.mjs";
import { requireTools } from "../scripts/lib/toolchain.mjs";
import { makeTempDir } from "./helpers.mjs";

const RATE = 48000;

function signal(seconds, fill) {
	const samples = new Float32Array(Math.round(seconds * RATE));
	for (let index = 0; index < samples.length; index += 1) {
		samples[index] = fill(index / RATE);
	}
	return samples;
}

// Deterministic low-level noise (LCG) so tests do not depend on Math.random.
function noise(amplitude) {
	let state = 12345;
	return () => {
		state = (state * 1103515245 + 12345) % 2147483648;
		return ((state / 2147483648) * 2 - 1) * amplitude;
	};
}

test("WAV round-trips through 16-bit PCM", (t) => {
	const { dir, cleanup } = makeTempDir();
	t.after(cleanup);
	const file = path.join(dir, "tone with space.wav");
	const tone = signal(0.1, (time) => 0.5 * Math.sin(2 * Math.PI * 1000 * time));
	writeWav(file, tone, RATE);
	const back = readWav(file);
	assert.equal(back.sampleRate, RATE);
	assert.equal(back.samples.length, tone.length);
	assert.ok(Math.abs(back.samples[100] - tone[100]) < 1e-4);
});

test("segments are found relative to a measured floor, not a fixed level", () => {
	const hiss = noise(0.001);
	const floorRecording = signal(1, hiss);
	const floor = noiseFloor(frameLevels(floorRecording, RATE).levels);
	assert.ok(floor.medianDb < -60);
	const n = noise(0.001);
	const take = signal(2, (time) => n() + (time >= 0.5 && time < 1.2 ? 0.2 * Math.sin(2 * Math.PI * 440 * time) : 0));
	const { segments } = activeSegments(frameLevels(take, RATE), floor);
	assert.equal(segments.length, 1);
	assert.ok(Math.abs(segments[0].startMs - 500) <= 10);
	assert.ok(Math.abs(segments[0].endMs - 1200) <= 10);
});

test("tone detection finds the marker frequency and its onset", () => {
	const take = signal(1, (time) => (time >= 0.3 ? 0.3 * Math.sin(2 * Math.PI * 1000 * time) : 0));
	assert.ok(toneLevel(take, RATE, 1000, RATE * 0.5, RATE * 0.1) > toneLevel(take, RATE, 3000, RATE * 0.5, RATE * 0.1) + 30);
	assert.equal(toneOnsetMs(take, RATE, 1000, -100), 300);
	assert.equal(toneOnsetMs(signal(1, () => 0), RATE, 1000, -100), null);
});

test("envelope correlation detects a delayed copy and rejects an unrelated signal", () => {
	const pattern = Array.from({ length: 200 }, (_, index) => (Math.floor(index / 13) % 3 === 0 ? -10 : -60));
	const delayed = [...Array(7).fill(-60), ...pattern].slice(0, 200);
	const match = envelopeCorrelation(pattern, delayed, 20);
	assert.equal(match.lagFrames, 7);
	assert.ok(match.coefficient > 0.9);
	const unrelated = Array.from({ length: 200 }, (_, index) => (Math.floor(index / 41) % 2 === 0 ? -10 : -60));
	assert.ok(envelopeCorrelation(pattern, unrelated, 20).coefficient < 0.5);
});

test("narration text splits into sentences and captions are escaped WebVTT", () => {
	assert.deepEqual(splitSentences("One.  Two!\nThree? Four"), ["One.", "Two!", "Three?", "Four"]);
	// Periods inside file names, versions and hosts are not sentence ends, and no text is ever dropped.
	const dotted = "Open src/main.ts to start. Version 1.2.3 runs at api.example.test/v1... Done?! Next";
	assert.deepEqual(splitSentences(dotted), ["Open src/main.ts to start.", "Version 1.2.3 runs at api.example.test/v1...", "Done?!", "Next"]);
	for (const text of [dotted, ".leading dot", "a.b.c", "Ends with a file name.txt", "x . y"]) {
		assert.equal(splitSentences(text).join(" "), text.replace(/\s+/g, " ").trim(), text);
	}
	assert.equal(
		toWebVtt([{ startMs: 3723004, endMs: 3724500, role: "Narrator", text: "a < b & c" }]),
		"WEBVTT\n\n1\n01:02:03.004 --> 01:02:04.500\n<v Narrator>a &lt; b &amp; c\n",
	);
});

test("Piper narration produces cue-aligned audio", { skip: requireTools(["python", "voiceModel"]).ok ? false : "toolchain not installed (run `sdp setup install`)" }, async (t) => {
	const { dir, cleanup } = makeTempDir();
	t.after(cleanup);
	const out = path.join(dir, "narration.wav");
	const result = await synthesizeNarration({ text: "First sentence. Second one.", outWav: out, paths: requireTools(["python"]).paths, pauseMs: 250 });
	assert.equal(result.cues.length, 2);
	assert.equal(result.cues[0].startMs, 0);
	assert.ok(Math.abs(result.cues[1].startMs - result.cues[0].endMs - 250) < 1);
	const wav = readWav(out);
	assert.ok(Math.abs((wav.samples.length / wav.sampleRate) * 1000 - result.durationMs) < 1);
	const floor = { p95Db: -90, spreadDb: 0 };
	assert.ok(activeSegments(frameLevels(wav.samples, wav.sampleRate), floor).segments.length >= 1);
});
