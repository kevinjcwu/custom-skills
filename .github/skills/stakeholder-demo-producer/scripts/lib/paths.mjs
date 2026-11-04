// Path rules shared by contracts, discovery, preflight and run.
//
// Relative refs are POSIX-style, repository-relative strings. They are
// validated lexically first and then resolved against a real root, so both
// "../x" style traversal and symlinked escapes are rejected.
import fs from "node:fs";
import path from "node:path";
import { Buffer } from "node:buffer";
import { SdpError } from "./errors.mjs";

const MAX_REF_LENGTH = 4096;

/** True when the string contains NUL, C0 control characters or DEL. */
export function hasControlCharacter(value) {
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code < 0x20 || code === 0x7f) {
			return true;
		}
	}
	return false;
}

/**
 * Returns the reasons a value is not an acceptable relative ref.
 * @param {unknown} value
 * @param {{allowDot?: boolean}} [options] allowDot permits "." (a cwd).
 * @returns {string[]}
 */
export function relativeRefErrors(value, options = {}) {
	if (typeof value !== "string") {
		return ["must be a string"];
	}
	const errors = [];
	if (value.length === 0) {
		return ["must not be empty"];
	}
	if (value.length > MAX_REF_LENGTH) {
		errors.push(`must be at most ${MAX_REF_LENGTH} characters`);
	}
	if (hasControlCharacter(value)) {
		errors.push("must not contain NUL or control characters");
	}
	if (value.includes("\\")) {
		errors.push("must not contain a backslash");
	}
	if (value.startsWith("/")) {
		errors.push("must be relative, not absolute");
	}
	if (/^[A-Za-z]:/.test(value)) {
		errors.push("must not start with a drive prefix");
	}
	if (options.allowDot && value === ".") {
		return errors;
	}
	for (const segment of value.split("/")) {
		if (segment === "" || segment === "." || segment === "..") {
			errors.push("must not contain empty, '.' or '..' segments");
			break;
		}
	}
	return errors;
}

/** Returns the reasons a value is not an acceptable approved absolute path. */
export function approvedAbsoluteErrors(value) {
	if (typeof value !== "string" || value.length === 0) {
		return ["must be a non-empty string"];
	}
	const errors = [];
	if (hasControlCharacter(value)) {
		errors.push("must not contain NUL or control characters");
	}
	if (!path.isAbsolute(value)) {
		errors.push("must be an absolute path");
	} else if (path.resolve(value) !== value) {
		errors.push("must be normalised (no '.', '..', duplicate or trailing separators)");
	}
	return errors;
}

/** True when candidate equals root or lies below it (both absolute). */
export function isInside(root, candidate) {
	const rel = path.relative(root, candidate);
	if (rel === "") {
		return true;
	}
	return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

function nearestExisting(target) {
	let current = target;
	for (;;) {
		try {
			fs.lstatSync(current);
			return current;
		} catch {
			const parent = path.dirname(current);
			if (parent === current) {
				return current;
			}
			current = parent;
		}
	}
}

/**
 * Resolves a relative ref below a root and verifies containment after
 * following symlinks of the nearest existing ancestor.
 * @param {string} root Absolute root directory.
 * @param {string} ref Relative ref.
 * @param {{allowDot?: boolean}} [options]
 * @returns {string} The lexical absolute path below root.
 */
export function resolveContained(root, ref, options = {}) {
	const errors = relativeRefErrors(ref, options);
	if (errors.length > 0) {
		throw new SdpError("invalid-path", `invalid relative path: ${errors.join("; ")}`);
	}
	const rootReal = fs.realpathSync(root);
	const joined = ref === "." ? rootReal : path.join(rootReal, ...ref.split("/"));
	if (!isInside(rootReal, joined)) {
		throw new SdpError("path-escape", "path escapes its root");
	}
	const existing = nearestExisting(joined);
	const real = fs.realpathSync(existing);
	if (!isInside(rootReal, real)) {
		throw new SdpError("path-escape", "path escapes its root through a symlink");
	}
	return joined;
}

/**
 * Builds the list of binding strings that must never appear in outputs.
 * Real paths are included because a resolved path can differ from the
 * approved spelling.
 * @param {{id: string, value: string}[]} bindings
 */
export function expandBindingNeedles(bindings) {
	const needles = [];
	const seen = new Set();
	for (const binding of bindings) {
		const values = [binding.value];
		try {
			values.push(fs.realpathSync(binding.value));
		} catch {
			// A missing binding has no realpath; the approved spelling remains.
		}
		for (const value of values) {
			if (typeof value === "string" && value.length >= 2 && !seen.has(value)) {
				seen.add(value);
				needles.push({ id: binding.id, value });
			}
		}
	}
	needles.sort((a, b) => b.value.length - a.value.length);
	return needles;
}

/** Finds JSON strings (keys or values) that contain a binding value. */
export function findLeaks(value, needles, pointer = "") {
	const leaks = [];
	const visit = (node, at) => {
		if (typeof node === "string") {
			for (const needle of needles) {
				if (node.includes(needle.value)) {
					leaks.push({ pointer: at || "/", binding: needle.id });
					break;
				}
			}
		} else if (Array.isArray(node)) {
			node.forEach((item, index) => visit(item, `${at}/${index}`));
		} else if (node !== null && typeof node === "object") {
			for (const [key, item] of Object.entries(node)) {
				visit(key, `${at}/${key}#key`);
				visit(item, `${at}/${key}`);
			}
		}
	};
	visit(value, pointer);
	return leaks;
}

/** Finds a binding value in raw bytes. */
export function findLeakInBytes(bytes, needles) {
	for (const needle of needles) {
		if (bytes.includes(Buffer.from(needle.value, "utf8"))) {
			return needle.id;
		}
	}
	return null;
}

/**
 * Replaces every binding value in bytes with "<binding:id>", longest first.
 * @returns {{bytes: Buffer, replacements: number}}
 */
export function redactBytes(bytes, needles) {
	let current = bytes;
	let replacements = 0;
	for (const needle of needles) {
		const search = Buffer.from(needle.value, "utf8");
		const replacement = Buffer.from(`<binding:${needle.id}>`, "utf8");
		const parts = [];
		let start = 0;
		let index = current.indexOf(search, start);
		if (index === -1) {
			continue;
		}
		while (index !== -1) {
			parts.push(current.subarray(start, index), replacement);
			replacements += 1;
			start = index + search.length;
			index = current.indexOf(search, start);
		}
		parts.push(current.subarray(start));
		current = Buffer.concat(parts);
	}
	return { bytes: current, replacements };
}

// Heuristic used when no bindings are known: strings that start like a host
// absolute path (POSIX home/temp roots, Windows drive or UNC). Exact binding
// values are caught separately by needles; this only flags likely leaks.
const ABSOLUTE_LOOKING =
	/(?:^|[\s"'=:(])(?:\/(?:home|Users|root|tmp|var|private|mnt|opt|srv|workspace|workspaces)\/|[A-Za-z]:[\\/]|\\\\+[A-Za-z0-9][A-Za-z0-9.-]+\\+[A-Za-z0-9][A-Za-z0-9$_.-])/;

export function looksLikeHostPath(text) {
	return ABSOLUTE_LOOKING.test(text);
}

/** Artifact roles holding compressed media rather than text. */
export const BINARY_ROLES = Object.freeze(["screenshot", "browser-video", "helper-media"]);

/** In media, a drive letter only counts when a real path segment follows it ("D:/data/"). */
const MEDIA_DRIVE_CHANCE = /(?:^|[\s"'=:(])[A-Za-z]:[\\/](?![A-Za-z0-9_. $-]{2,}[\\/])/g;

/**
 * Host-path heuristic for compressed media: only printable ASCII runs of at
 * least minRun bytes are examined (as `strings` would show them), because
 * short random byte sequences in compressed data resemble "c:/" by chance.
 * A drive letter with no path segment after it is also chance there.
 * Exact binding values are refused separately when media are written.
 */
export function mediaLooksLikeHostPath(bytes, minRun = 8) {
	const runs = [];
	let start = -1;
	for (let index = 0; index <= bytes.length; index++) {
		const byte = index < bytes.length ? bytes[index] : 0;
		const printable = byte >= 0x20 && byte < 0x7f;
		if (printable && start < 0) {
			start = index;
		} else if (!printable && start >= 0) {
			if (index - start >= minRun) {
				runs.push(bytes.subarray(start, index).toString("latin1"));
			}
			start = -1;
		}
	}
	return runs.some((run) => looksLikeHostPath(run.replace(MEDIA_DRIVE_CHANCE, " ")));
}
