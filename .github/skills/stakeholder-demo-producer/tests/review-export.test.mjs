import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeTempDir } from "./helpers.mjs";
import { exportReview } from "../scripts/lib/review-export.mjs";

test("refuses incomplete exports without a declared limitation before starting media tools", async (t) => {
	const temp = makeTempDir();
	t.after(temp.cleanup);
	const outDir = path.join(temp.dir, "exports");
	fs.mkdirSync(outDir);
	await assert.rejects(
		exportReview({
			outDir,
			screenVideo: path.join(temp.dir, "missing.webm"),
			paths: {},
			env: {
				PATH: "/usr/bin:/bin",
				HOME: temp.dir,
				TMPDIR: temp.dir,
				PYTHONDONTWRITEBYTECODE: "1",
				PYTHONNOUSERSITE: "1",
			},
			intro: "Observed opening.",
			outro: "Observed ending.",
			status: "incomplete",
		}),
		/explicit limitations/,
	);
	assert.deepEqual(fs.readdirSync(outDir), []);
});

test("rejects ambiguous track provenance, out-of-range offsets and control text", async (t) => {
	const temp = makeTempDir();
	t.after(temp.cleanup);
	const outDir = path.join(temp.dir, "exports");
	fs.mkdirSync(outDir);
	const screen = path.join(temp.dir, "screen.webm");
	fs.writeFileSync(screen, "not media");
	const base = {
		outDir,
		screenVideo: screen,
		paths: {},
		env: {
			PATH: "/usr/bin:/bin",
			HOME: temp.dir,
			TMPDIR: temp.dir,
			PYTHONDONTWRITEBYTECODE: "1",
			PYTHONNOUSERSITE: "1",
		},
		intro: "Observed opening.",
		outro: "Observed ending.",
		status: "complete",
	};
	await assert.rejects(
		exportReview({
			...base,
			tracks: [
				{
					file: screen,
					role: "Participant",
					label: "User",
					provenance: "app-output",
					caption: "Reply",
					offsetMs: 0,
					uncertaintyMs: 0,
				},
			],
		}),
		/requires a role, label, explicit provenance/,
	);
	assert.deepEqual(fs.readdirSync(outDir), []);
});
