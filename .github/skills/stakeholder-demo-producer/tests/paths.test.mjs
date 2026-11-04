import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Buffer } from "node:buffer";
import {
	approvedAbsoluteErrors,
	expandBindingNeedles,
	findLeakInBytes,
	findLeaks,
	mediaLooksLikeHostPath,
	redactBytes,
	relativeRefErrors,
	resolveContained,
} from "../scripts/lib/paths.mjs";
import { makeTempDir } from "./helpers.mjs";

test("relative refs reject POSIX, Windows, UNC, traversal and control forms", () => {
	assert.deepEqual(relativeRefErrors("src/app.mjs"), []);
	assert.deepEqual(relativeRefErrors(".", { allowDot: true }), []);
	for (const bad of [
		"/abs",
		"../up",
		"a/../../b",
		"C:\\win",
		"c:rel",
		"\\\\host\\share",
		"a\\b",
		"nul\u0000byte",
		"tab\there",
		"a//b",
		"a/./b",
		"",
		".",
	]) {
		assert.notDeepEqual(relativeRefErrors(bad), [], JSON.stringify(bad));
	}
});

test("approved absolute paths must be normalised absolute paths", () => {
	assert.deepEqual(approvedAbsoluteErrors("/a/b"), []);
	for (const bad of ["a/b", "/a/../b", "/a/b/", "/a//b", "/a/\u0001", ""]) {
		assert.notDeepEqual(approvedAbsoluteErrors(bad), [], JSON.stringify(bad));
	}
});

test("resolveContained rejects lexical and symlink escapes", (t) => {
	const { dir, cleanup } = makeTempDir();
	t.after(cleanup);
	const root = path.join(dir, "root");
	const outside = path.join(dir, "outside");
	fs.mkdirSync(path.join(root, "inner"), { recursive: true });
	fs.mkdirSync(outside);
	fs.symlinkSync(outside, path.join(root, "escape"));
	fs.symlinkSync(path.join(root, "inner"), path.join(root, "ok-link"));

	assert.equal(resolveContained(root, "inner/new.txt"), path.join(root, "inner", "new.txt"));
	assert.equal(resolveContained(root, "ok-link/file"), path.join(root, "ok-link", "file"));
	assert.throws(() => resolveContained(root, "../outside"), { code: "invalid-path" });
	assert.throws(() => resolveContained(root, "escape/file"), { code: "path-escape" });
	assert.throws(() => resolveContained(root, "escape"), { code: "path-escape" });
	assert.throws(() => resolveContained(root, "/etc"), { code: "invalid-path" });
});

test("binding leaks are found in JSON keys, values and bytes, and redacted", (t) => {
	const { dir, cleanup } = makeTempDir();
	t.after(cleanup);
	const needles = expandBindingNeedles([{ id: "targetRoot", value: dir }]);
	assert.ok(needles.some((needle) => needle.value === dir));
	const doc = { ok: "relative/path", nested: [{ msg: `failed in ${dir}/x` }], [`${dir}`]: 1 };
	const leaks = findLeaks(doc, needles);
	assert.equal(leaks.length, 2);
	assert.ok(leaks.every((leak) => leak.binding === "targetRoot"));
	const bytes = Buffer.from(`a ${dir}/b and ${dir}`);
	assert.equal(findLeakInBytes(bytes, needles), "targetRoot");
	const redacted = redactBytes(bytes, needles);
	assert.equal(redacted.replacements, 2);
	assert.equal(redacted.bytes.toString(), "a <binding:targetRoot>/b and <binding:targetRoot>");
	assert.equal(findLeakInBytes(redacted.bytes, needles), null);
});

test("compressed media are checked for host paths in printable runs only", () => {
	// A short "x:/" inside compressed bytes is chance, not a path.
	assert.equal(mediaLooksLikeHostPath(Buffer.from([0x00, 0x20, 0x78, 0x3a, 0x2f, 0x81, 0x02])), false);
	const embedded = Buffer.concat([Buffer.from([0x00, 0x9f]), Buffer.from(" source=/home/someone/raw.webm"), Buffer.from([0x00])]);
	assert.equal(mediaLooksLikeHostPath(embedded), true);
	assert.equal(mediaLooksLikeHostPath(Buffer.from([0x00, ...Buffer.from(" C:\\Users\\x\\a.png"), 0x00])), true);
	assert.equal(mediaLooksLikeHostPath(Buffer.from([0x00, ...Buffer.from("D:/data/run.webm"), 0x00])), true);
	// Found in a real recorded VP8 stream: a drive letter with no path segment after it is chance.
	assert.equal(mediaLooksLikeHostPath(Buffer.from([0x00, ...Buffer.from("A:/\\6Zm?"), 0x00])), false);
});
