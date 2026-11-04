import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { hasControlCharacter } from "./paths.mjs";

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
