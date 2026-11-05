import { test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { makeTempDir } from "./helpers.mjs";
import {
	readPageResult,
	saveOriginalBlob,
	readPageBytes,
	finalizeCapture,
	startFrameCapture,
} from "../scripts/lib/recording.mjs";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("finalization stops both clocks before a slow byte transfer starts", async () => {
	const calls = [];
	let finishScreen;
	let finishAudio;
	const pending = finalizeCapture({
		stopScreen: () => {
			calls.push("screen-stop");
			return new Promise((resolve) => {
				finishScreen = resolve;
			});
		},
		stopAudio: () => {
			calls.push("audio-stop");
			return new Promise((resolve) => {
				finishAudio = resolve;
			});
		},
		saveAudio: async (metadata) => {
			calls.push("transfer");
			assert.deepEqual(metadata, { byteLength: 3 });
			return { bytes: 3 };
		},
	});
	await Promise.resolve();
	assert.deepEqual(calls, ["screen-stop", "audio-stop"]);
	finishAudio({ byteLength: 3 });
	await Promise.resolve();
	assert.equal(calls.includes("transfer"), false);
	finishScreen({ endMs: 125 });
	const result = await pending;
	assert.deepEqual(calls, ["screen-stop", "audio-stop", "transfer"]);
	assert.equal(result.screen.endMs, 125);
	assert.equal(result.audio.original.bytes, 3);
});

test("a failed screen finalizer still preserves a finalized audio original", async () => {
	const result = await finalizeCapture({
		stopScreen: async () => {
			throw new Error("screen unavailable");
		},
		stopAudio: async () => ({ byteLength: 3 }),
		saveAudio: async () => ({ bytes: 3 }),
	});
	assert.match(result.screenError, /screen unavailable/);
	assert.equal(result.audio.original.bytes, 3);
});

test("transfer failure preserves independent screen/audio metadata and persisted partial chunks", async (t) => {
	const temp = makeTempDir();
	t.after(temp.cleanup);
	const partial = path.join(temp.dir, "audio.partial");
	const result = await finalizeCapture({
		stopScreen: async () => ({ endMs: 200 }),
		stopAudio: async () => ({ byteLength: 6, error: "capture incomplete" }),
		saveAudio: async () => {
			try {
				return await readPageBytes({
					expectedBytes: 6,
					chunkBytes: 3,
					readChunk: async ({ offset }) => {
						if (offset) throw new Error("controlled transfer failure");
						return Buffer.from("abc").toString("base64");
					},
					onChunk: (bytes) => fs.appendFileSync(partial, bytes),
				});
			} catch (error) {
				error.partialOriginal = { file: partial, bytes: fs.statSync(partial).size, complete: false };
				throw error;
			}
		},
	});
	assert.equal(result.screen.endMs, 200);
	assert.equal(result.audio.metadata.error, "capture incomplete");
	assert.match(result.audioError, /controlled transfer failure/);
	assert.equal(result.audio.partialOriginal.complete, false);
	assert.equal(fs.readFileSync(partial, "utf8"), "abc");
});

test("failed audio finalization does not discard successful screen finalization", async () => {
	const result = await finalizeCapture({
		stopScreen: () => ({ endMs: 123 }),
		stopAudio: () => { throw new Error("audio stop failed"); },
		saveAudio: () => { throw new Error("must not transfer"); },
	});
	assert.equal(result.screen.endMs, 123);
	assert.match(result.audioError, /audio stop failed/);
});

test("page transfer respects cancellation without fetching another chunk", async () => {
	const controller = new AbortController();
	let reads = 0;
	await assert.rejects(readPageBytes({
		expectedBytes: 6,
		chunkBytes: 3,
		signal: controller.signal,
		readChunk: async () => { reads++; return Buffer.from("abc").toString("base64"); },
		onChunk: () => controller.abort(new Error("cancel transfer")),
	}), /cancel transfer/);
	assert.equal(reads, 1);
});

test("bounded base64 chunks preserve bytes and reject short or oversized responses", async () => {
	const bytes = Buffer.from([0, 255, 1, 2, 128, 3, 4]);
	const chunks = [];
	const output = await readPageBytes({
		expectedBytes: bytes.length,
		chunkBytes: 3,
		readChunk: async ({ offset, length }) => {
			chunks.push(length);
			return bytes.subarray(offset, offset + length).toString("base64");
		},
	});
	assert.deepEqual(output, bytes);
	assert.deepEqual(chunks, [3, 3, 1]);
	await assert.rejects(
		readPageBytes({
			expectedBytes: 4,
			chunkBytes: 3,
			readChunk: async () => Buffer.from([1, 2]).toString("base64"),
		}),
		/chunk length/,
	);
	await assert.rejects(
		readPageBytes({
			expectedBytes: 17 * 1024 * 1024,
			readChunk: async () => {
				throw new Error("must not read");
			},
		}),
		/byte bound/,
	);
});

test("timestamped capture preserves the final frame clock before transfer", async (t) => {
	const temp = makeTempDir();
	t.after(temp.cleanup);
	const times = [10, 30, 45];
	const page = {
		evaluate: async () => times.shift(),
		screenshot: async ({ path: file }) => fs.writeFileSync(file, "frame"),
	};
	const capture = await startFrameCapture({ page, outDir: temp.dir });
	const result = await capture.stop();
	assert.equal(result.frames.length, 1);
	assert.equal(result.frames[0].pageMs, 20);
	assert.equal(result.frames[0].uncertaintyMs, 10);
	assert.equal(result.endMs, 45);
});

test("invalid final screen clock is rejected while timestamped original frames remain on disk", async (t) => {
	const temp = makeTempDir();
	t.after(temp.cleanup);
	const times = [10, 30, 20];
	const capture = await startFrameCapture({
		page: {
			evaluate: async () => times.shift(),
			screenshot: async ({ path: file }) => fs.writeFileSync(file, "original frame"),
		},
		outDir: temp.dir,
	});
	await assert.rejects(capture.stop(), /nonmonotonic.*end clock/);
	assert.equal(fs.readFileSync(path.join(temp.dir, "000000.jpg"), "utf8"), "original frame");
	assert.equal(JSON.parse(fs.readFileSync(path.join(temp.dir, "frames.jsonl"), "utf8")).pageMs, 20);
});

test("screen startup failure preserves any partial original and terminates the capture loop", async (t) => {
	const temp = makeTempDir();
	t.after(temp.cleanup);
	let attempts = 0;
	await assert.rejects(startFrameCapture({
		page: {
			evaluate: async () => 10,
			screenshot: async ({ path: file }) => {
				attempts++;
				fs.writeFileSync(file, "partial screenshot");
				throw new Error("controlled screenshot failure");
			},
		},
		outDir: temp.dir,
	}), /controlled screenshot failure/);
	assert.equal(attempts, 1);
	assert.equal(fs.readFileSync(path.join(temp.dir, "000000.jpg"), "utf8"), "partial screenshot");
});

function transcript(value, { ok = true, detail = "truncated" } = {}) {
	return {
		detail,
		transcript: [
			{
				dir: "from-helper",
				message: {
					type: "page",
					id: "call-1",
					script: "capture.flush",
					arg: { op: "flush" },
				},
			},
			{
				dir: "to-helper",
				message: {
					type: "page-result",
					id: "call-1",
					ok,
					...(ok ? { value } : { error: "fixture failure" }),
				},
			},
		],
	};
}

test("extracts the full structured page payload by script and call id", () => {
	const payload = { text: "journey ".repeat(100), bytes: [1, 2, 3] };
	const result = readPageResult(transcript(payload), {
		script: "capture.flush",
		callId: "call-1",
	});
	assert.equal(result.text.length, payload.text.length);
	assert.deepEqual(result, payload);
});

test("rejects absent, duplicate, mismatched and failed page results", () => {
	const base = transcript("ok");
	assert.throws(
		() => readPageResult({ transcript: [] }, { script: "capture.flush" }),
		/found 0/,
	);
	assert.throws(() => readPageResult(base, { script: "other" }), /found 0/);
	assert.throws(
		() =>
			readPageResult(transcript(null, { ok: false }), {
				script: "capture.flush",
			}),
		/fixture failure/,
	);
	assert.throws(
		() =>
			readPageResult(
				{ ...base, transcript: [...base.transcript, ...base.transcript] },
				{ script: "capture.flush" },
			),
		/found 2/,
	);
	assert.throws(
		() =>
			readPageResult(
				{ transcript: [base.transcript[0]] },
				{ script: "capture.flush" },
			),
		/found 0/,
	);
	assert.throws(
		() =>
			readPageResult(
				{
					transcript: [
						base.transcript[0],
						{
							...base.transcript[1],
							message: { ...base.transcript[1].message, id: "other" },
						},
					],
				},
				{ script: "capture.flush" },
			),
		/found 0/,
	);
});

test("transfers bounded originals exclusively and verifies byte identity", async (t) => {
	const temp = makeTempDir();
	t.after(temp.cleanup);
	const originals = path.join(temp.dir, "originals");
	fs.mkdirSync(originals);
	const bytes = Buffer.from("preserved original fixture bytes");
	const expectedSha256 = digest(bytes);
	const saved = await saveOriginalBlob({
		readBlob: async () => bytes,
		outDir: originals,
		file: "capture.bin",
		expectedBytes: bytes.length,
		expectedSha256,
		maxBytes: 1024,
	});
	assert.equal(fs.readFileSync(saved.file).toString(), bytes.toString());
	assert.equal(saved.sha256, expectedSha256);
	assert.equal(saved.bytes, bytes.length);
	await assert.rejects(
		saveOriginalBlob({
			readBlob: async () => bytes,
			outDir: originals,
			file: "capture.bin",
			expectedBytes: bytes.length,
		}),
		/overwrite/,
	);
	await assert.rejects(
		saveOriginalBlob({
			readBlob: async () => bytes,
			outDir: temp.dir,
			file: "escape.bin",
			expectedBytes: bytes.length + 1,
		}),
		/contradicts/,
	);
	await assert.rejects(
		saveOriginalBlob({
			readBlob: async () => bytes,
			outDir: temp.dir,
			file: "../escape.bin",
			expectedBytes: bytes.length,
		}),
		/relative path/,
	);
	await assert.rejects(
		saveOriginalBlob({
			readBlob: async () => bytes,
			outDir: originals,
			file: "hash.bin",
			expectedBytes: bytes.length,
			expectedSha256: "0".repeat(64),
		}),
		/hash does not match/,
	);
});

test("original destinations refuse symlink parents and preserve pre-existing bytes", async (t) => {
	const temp = makeTempDir();
	t.after(temp.cleanup);
	const outside = path.join(temp.dir, "outside");
	fs.mkdirSync(outside);
	fs.symlinkSync(outside, path.join(temp.dir, "linked"), "dir");
	await assert.rejects(
		saveOriginalBlob({
			readBlob: async () => Buffer.from("x"),
			outDir: temp.dir,
			file: "linked/file.bin",
			expectedBytes: 1,
		}),
		/real directory/,
	);
	const existing = path.join(temp.dir, "keep.bin");
	fs.writeFileSync(existing, "do not replace");
	await assert.rejects(
		saveOriginalBlob({
			readBlob: async () => Buffer.from("replacement"),
			outDir: temp.dir,
			file: "keep.bin",
			expectedBytes: 11,
		}),
		/overwrite/,
	);
	assert.equal(fs.readFileSync(existing, "utf8"), "do not replace");
});
