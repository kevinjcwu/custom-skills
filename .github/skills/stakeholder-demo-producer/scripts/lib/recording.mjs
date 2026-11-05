import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { hasControlCharacter } from "./paths.mjs";

/** Stop every capture before any potentially blocking original-byte transfer. */
export async function finalizeCapture({ stopScreen, stopAudio, saveAudio }) {
	if (
		![stopScreen, stopAudio, saveAudio].every((fn) => typeof fn === "function")
	)
		throw new Error("capture finalization requires stop and save functions");
	const [screen, audio] = await Promise.allSettled([
		Promise.resolve().then(stopScreen),
		Promise.resolve().then(stopAudio),
	]);
	const result = {};
	if (screen.status === "fulfilled") result.screen = screen.value;
	else result.screenError = String(screen.reason?.message ?? screen.reason);
	if (audio.status === "fulfilled") {
		result.audio = { metadata: audio.value, original: null };
		if (audio.value?.byteLength) {
			try {
				result.audio.original = await saveAudio(audio.value);
			} catch (error) {
				result.audioError = String(error.message ?? error);
				if (error.partialOriginal) result.audio.partialOriginal = error.partialOriginal;
			}
		}
	} else result.audioError = String(audio.reason?.message ?? audio.reason);
	return result;
}

/** Read bounded base64 chunks rather than serializing a whole byte array. */
export async function readPageBytes({
	readChunk,
	expectedBytes,
	chunkBytes = 48 * 1024,
	maxBytes = 16 * 1024 * 1024,
	onChunk,
	signal,
}) {
	if (
		typeof readChunk !== "function" ||
		!Number.isSafeInteger(expectedBytes) ||
		expectedBytes < 0 ||
		!Number.isSafeInteger(maxBytes) ||
		maxBytes < 0 ||
		expectedBytes > maxBytes ||
		!Number.isSafeInteger(chunkBytes) ||
		chunkBytes < 1 ||
		chunkBytes > 64 * 1024 ||
		(onChunk !== undefined && typeof onChunk !== "function")
	)
		throw new Error("invalid page transfer byte bound or chunk size");
	const chunks = [];
	for (let offset = 0; offset < expectedBytes; offset += chunkBytes) {
		signal?.throwIfAborted();
		const length = Math.min(chunkBytes, expectedBytes - offset);
		const encoded = await readChunk({ offset, length });
		if (
			typeof encoded !== "string" ||
			encoded.length > Math.ceil(length / 3) * 4
		)
			throw new Error("page chunk length exceeds its declared bound");
		const bytes = Buffer.from(encoded, "base64");
		if (bytes.length !== length || bytes.toString("base64") !== encoded)
			throw new Error("page chunk length or base64 encoding is invalid");
		// The driver may persist validated chunks before a later transfer fails.
		await onChunk?.(bytes, { offset, expectedBytes });
		signal?.throwIfAborted();
		chunks.push(bytes);
	}
	return Buffer.concat(chunks, expectedBytes);
}

/** Capture real frames with page-clock intervals; the caller owns the deadline. */
export async function startFrameCapture({
	page,
	outDir,
	intervalMs = 100,
	signal,
}) {
	if (
		!Number.isSafeInteger(intervalMs) ||
		intervalMs < 30 ||
		intervalMs > 1000 ||
		fs.realpathSync(outDir) !== path.resolve(outDir) ||
		!fs.lstatSync(outDir).isDirectory() ||
		fs.readdirSync(outDir).length
	)
		throw new Error(
			"frame capture requires an empty real directory and a bounded interval",
		);
	const frames = [];
	let stopping = false;
	let error;
	let lastAfter = -Infinity;
	let ready;
	const first = new Promise((resolve) => {
		ready = resolve;
	});
	const loop = (async () => {
		try {
			while (!stopping) {
				signal?.throwIfAborted();
				const before = await page.evaluate(() => globalThis.performance.now());
				const file = path.join(
					outDir,
					`${String(frames.length).padStart(6, "0")}.jpg`,
				);
				await page.screenshot({
					path: file,
					type: "jpeg",
					quality: 85,
					animations: "allow",
					timeout: 5000,
				});
				const after = await page.evaluate(() => globalThis.performance.now());
				if (!Number.isFinite(before) || !Number.isFinite(after) ||
					before < lastAfter || after < before)
					throw new Error("nonmonotonic frame capture clock");
				lastAfter = after;
				frames.push({
					file,
					pageMs: (before + after) / 2,
					uncertaintyMs: (after - before) / 2,
				});
				fs.appendFileSync(
					path.join(outDir, "frames.jsonl"),
					`${JSON.stringify(frames.at(-1))}\n`,
				);
				ready();
				await delay(Math.max(0, intervalMs - (after - before)));
			}
		} catch (failure) {
			error = failure;
			ready();
		}
	})();
	await first;
	if (error) throw error;
	return {
		frames,
		async stop() {
			stopping = true;
			await loop;
			if (error) throw error;
			const endMs = await page.evaluate(() => globalThis.performance.now());
			if (!Number.isFinite(endMs) || endMs < lastAfter)
				throw new Error("nonmonotonic frame capture end clock");
			return {
				frames,
				endMs,
			};
		},
	};
}

function transcriptEntries(result) {
	if (!Array.isArray(result?.transcript)) {
		throw new Error("helper result has no structured transcript");
	}
	return result.transcript.filter(
		(entry) =>
			entry &&
			typeof entry === "object" &&
			entry.message &&
			typeof entry.message === "object",
	);
}

/**
 * Extract exactly one declared helper page call and its correlated full reply.
 * The helper's abbreviated detail field is deliberately not consulted.
 */
export function readPageResult(result, { script, callId }) {
	if (
		typeof script !== "string" ||
		script.length === 0 ||
		(callId !== undefined &&
			(typeof callId !== "string" || callId.length === 0))
	) {
		throw new Error("a page script and optional call id are required");
	}
	const entries = transcriptEntries(result);
	const requests = entries.filter(
		({ dir, message }) =>
			dir === "from-helper" &&
			message.type === "page" &&
			message.script === script &&
			(callId === undefined || message.id === callId),
	);
	if (requests.length !== 1) {
		throw new Error(
			`expected one ${script} page request${callId ? ` (${callId})` : ""}, found ${requests.length}`,
		);
	}
	const request = requests[0].message;
	const replies = entries.filter(
		({ dir, message }) =>
			dir === "to-helper" &&
			message.type === "page-result" &&
			message.id === request.id,
	);
	if (replies.length !== 1) {
		throw new Error(
			`expected one reply for page call ${request.id}, found ${replies.length}`,
		);
	}
	const reply = replies[0].message;
	if (reply.ok !== true) {
		throw new Error(
			`page call ${request.id} failed: ${String(reply.error ?? "unknown page error")}`,
		);
	}
	return reply.value;
}

function safeRegularFile(file, label) {
	const stat = fs.lstatSync(file);
	if (
		!stat.isFile() ||
		stat.isSymbolicLink() ||
		fs.realpathSync(file) !== path.resolve(file)
	) {
		throw new Error(`${label} must be a regular file, not a link`);
	}
	return stat;
}

/**
 * Transfer a bounded page blob to a new, exclusive original file.
 * readBlob is an explicit page reader supplied by the run-local driver.
 */
export async function saveOriginalBlob({
	readBlob,
	outDir,
	file,
	expectedBytes,
	expectedSha256,
	maxBytes = 16 * 1024 * 1024,
}) {
	if (typeof readBlob !== "function") {
		throw new Error("readBlob must be a function");
	}
	if (
		!Number.isSafeInteger(maxBytes) ||
		maxBytes < 0 ||
		!Number.isSafeInteger(expectedBytes) ||
		expectedBytes < 0 ||
		expectedBytes > maxBytes
	) {
		throw new Error("declared blob size is outside the permitted byte bound");
	}
	const root = fs.realpathSync(outDir);
	if (
		root !== path.resolve(outDir) ||
		!fs.lstatSync(root).isDirectory() ||
		fs.lstatSync(root).isSymbolicLink()
	) {
		throw new Error("original output directory is not a directory");
	}
	if (
		typeof file !== "string" ||
		file.length === 0 ||
		hasControlCharacter(file) ||
		path.isAbsolute(file) ||
		file.split(/[\\/]/).some((part) => part === ".." || part === "")
	) {
		throw new Error(
			"original file must be a relative path inside the output directory",
		);
	}
	const destination = path.resolve(root, file);
	if (!destination.startsWith(`${root}${path.sep}`)) {
		throw new Error("original file escapes the output directory");
	}
	const parent = path.dirname(destination);
	if (
		fs.realpathSync(parent) !== parent ||
		!fs.statSync(parent).isDirectory()
	) {
		throw new Error("original file parent must be an existing real directory");
	}
	const bytes = await readBlob();
	if (!(Buffer.isBuffer(bytes) || bytes instanceof Uint8Array)) {
		throw new Error("page blob reader must return bytes");
	}
	if (bytes.byteLength !== expectedBytes || bytes.byteLength > maxBytes) {
		throw new Error(
			`received blob size ${bytes.byteLength} contradicts declared size ${expectedBytes}`,
		);
	}
	const data = Buffer.from(bytes);
	if (data.length !== expectedBytes || data.length > maxBytes) {
		throw new Error(
			`received blob size ${data.length} contradicts declared size ${expectedBytes}`,
		);
	}
	const sha256 = createHash("sha256").update(data).digest("hex");
	if (expectedSha256 !== undefined && sha256 !== expectedSha256) {
		throw new Error("received blob hash does not match the declared hash");
	}
	let fd;
	try {
		fd = fs.openSync(destination, "wx", 0o600);
		fs.writeFileSync(fd, data);
	} catch (error) {
		if (error.code === "EEXIST") {
			throw new Error("refusing to overwrite an existing original", {
				cause: error,
			});
		}
		throw error;
	} finally {
		if (fd !== undefined) {
			fs.closeSync(fd);
		}
	}
	const stat = safeRegularFile(destination, "saved original");
	return { file: destination, bytes: stat.size, sha256 };
}
