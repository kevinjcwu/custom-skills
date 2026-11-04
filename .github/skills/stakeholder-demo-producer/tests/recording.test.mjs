import { test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { makeTempDir } from "./helpers.mjs";
import { readPageResult, saveOriginalBlob } from "../scripts/lib/recording.mjs";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

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
