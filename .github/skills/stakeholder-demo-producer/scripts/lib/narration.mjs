// Offline narration (Piper) with exact, sentence-level caption timing.
//
// Each sentence is synthesised separately and concatenated with a fixed
// pause, so every caption cue's start/end is the true sample position of
// its audio rather than an estimate.
import fs from "node:fs";
import path from "node:path";
import { execCapture } from "./proc-registry.mjs";
import { readWav, writeWav } from "./audio.mjs";

/**
 * Splits narration at sentence punctuation followed by a space. Punctuation
 * inside a word (src/main.ts, 1.2.3, example.com) is not a boundary, and
 * the parts always rejoin to the whole text, so nothing is ever dropped.
 */
export function splitSentences(text) {
	const normalized = text.replace(/\s+/g, " ").trim();
	return normalized ? normalized.split(/(?<=[.!?]) /) : [];
}

/**
 * @param {{text: string, outWav: string, paths: object, pauseMs?: number, role?: string}} options
 * @returns {Promise<{durationMs: number, sampleRate: number, cues: {startMs: number, endMs: number, role: string, text: string}[]}>}
 */
export async function synthesizeNarration({ text, outWav, paths, pauseMs = 300, role = "Narrator" }) {
	const sentences = splitSentences(text);
	if (sentences.length === 0) {
		throw new Error("narration text is empty");
	}
	const work = `${outWav}.parts`;
	const privateDir = fs.mkdtempSync(path.join(path.dirname(outWav), ".narrator-private-"));
	const home = path.join(privateDir, "home");
	const tmp = path.join(privateDir, "tmp");
	const env = {
		PATH: "/usr/bin:/bin",
		HOME: home,
		TMPDIR: tmp,
		XDG_CACHE_HOME: path.join(home, ".cache"),
		PYTHONDONTWRITEBYTECODE: "1",
		LANG: "C.UTF-8",
	};
	const pieces = [];
	let sampleRate = null;
	try {
		fs.mkdirSync(work, { recursive: true });
		fs.mkdirSync(home, { mode: 0o700 });
		fs.mkdirSync(tmp, { mode: 0o700 });
		for (const [index, sentence] of sentences.entries()) {
			const file = path.join(work, `${index}.wav`);
			const result = await execCapture(paths.python, ["-m", "piper", "-m", paths.voiceModel, "-c", paths.voiceConfig, "-f", file], { env, input: sentence, timeoutMs: 120000 });
			if (result.code !== 0) {
				throw new Error(`piper failed (exit ${result.code}): ${result.stderr.trim().split("\n").at(-1)}`);
			}
			const wav = readWav(file);
			sampleRate ??= wav.sampleRate;
			if (wav.sampleRate !== sampleRate) {
				throw new Error("piper produced inconsistent sample rates");
			}
			pieces.push({ sentence, samples: wav.samples });
		}
	} finally {
		fs.rmSync(work, { recursive: true, force: true });
		fs.rmSync(privateDir, { recursive: true, force: true });
	}
	const pause = Math.round((sampleRate * pauseMs) / 1000);
	const total = pieces.reduce((sum, piece) => sum + piece.samples.length, 0) + pause * (pieces.length - 1);
	const out = new Float32Array(total);
	const cues = [];
	let cursor = 0;
	for (const [index, piece] of pieces.entries()) {
		out.set(piece.samples, cursor);
		cues.push({ startMs: (cursor / sampleRate) * 1000, endMs: ((cursor + piece.samples.length) / sampleRate) * 1000, role, text: piece.sentence });
		cursor += piece.samples.length + (index < pieces.length - 1 ? pause : 0);
	}
	writeWav(outWav, out, sampleRate);
	return { durationMs: (total / sampleRate) * 1000, sampleRate, cues };
}

function timestamp(ms) {
	const total = Math.max(0, Math.round(ms));
	const hours = Math.floor(total / 3600000);
	const minutes = Math.floor((total % 3600000) / 60000);
	const seconds = Math.floor((total % 60000) / 1000);
	const millis = total % 1000;
	return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

/** WebVTT with role-labelled voice spans. Cue text is escaped. */
export function toWebVtt(cues) {
	const escape = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
	const body = [...cues]
		.sort((a, b) => a.startMs - b.startMs)
		.map((cue, index) => `${index + 1}\n${timestamp(cue.startMs)} --> ${timestamp(cue.endMs)}\n<v ${escape(cue.role)}>${escape(cue.text)}`);
	return `WEBVTT\n\n${body.join("\n\n")}\n`;
}
