import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { SKILL_ROOT } from "./helpers.mjs";

const skill = fs.readFileSync(path.join(SKILL_ROOT, "SKILL.md"), "utf8");
const BLOCKED = [];

function frontmatter(text) {
	const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
	assert.ok(match, "SKILL.md starts with YAML frontmatter");
	const fields = {};
	const lines = match[1].split("\n");
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		const field = /^([a-z-]+):\s*(.*)$/.exec(line);
		assert.ok(field, `frontmatter line is a simple key: value pair: ${line}`);
		let value = field[2];
		if (value === ">-") {
			const continuation = [];
			while (lines[index + 1]?.startsWith("  ")) {
				continuation.push(lines[++index].slice(2));
			}
			assert.ok(continuation.length, "folded scalar has content");
			value = continuation.join(" ");
		} else {
			assert.doesNotMatch(
				value,
				/:\s/,
				"plain frontmatter scalars must not contain mapping syntax",
			);
		}
		fields[field[1]] = value;
	}
	return fields;
}

function walk(dir) {
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = path.join(dir, entry.name);
		return entry.isDirectory() ? walk(full) : [full];
	});
}

test("frontmatter names the folder and describes when to use the skill", () => {
	const fields = frontmatter(skill);
	assert.equal(fields.name, path.basename(SKILL_ROOT));
	assert.match(fields.name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
	assert.ok(
		fields.description.length > 0 && fields.description.length <= 1024,
		`description length ${fields.description.length}`,
	);
	assert.match(fields.description, /Use it when/);
	assert.match(fields.compatibility, /Node\.js 24/);
	assert.equal("allowed-tools" in fields, false);
});

test("every linked file exists inside the skill and every reference is linked", () => {
	const docs = [
		path.join(SKILL_ROOT, "SKILL.md"),
		...walk(path.join(SKILL_ROOT, "references")),
	];
	const linked = new Set();
	for (const doc of docs) {
		for (const [, target] of fs
			.readFileSync(doc, "utf8")
			.matchAll(/\]\(([^)]+)\)/g)) {
			assert.equal(
				/^[a-z]+:|^\//i.test(target),
				false,
				`links are relative: ${target}`,
			);
			const resolved = path.resolve(path.dirname(doc), target);
			assert.ok(
				resolved.startsWith(SKILL_ROOT + path.sep),
				`link stays inside the skill: ${target}`,
			);
			assert.ok(fs.existsSync(resolved), `linked file exists: ${target}`);
			linked.add(resolved);
		}
	}
	for (const reference of walk(path.join(SKILL_ROOT, "references"))) {
		assert.ok(
			linked.has(reference) || skill.includes(path.basename(reference)),
			`${path.basename(reference)} is reachable from SKILL.md`,
		);
	}
});

test("the agent-orchestrated route and its reusable utilities are packaged", () => {
	assert.match(skill, /agent-orchestrated driver route/);
	assert.ok(
		fs.existsSync(
			path.join(SKILL_ROOT, "references", "repository-workflow.md"),
		),
	);
	assert.ok(
		fs.existsSync(path.join(SKILL_ROOT, "scripts", "lib", "recording.mjs")),
	);
	assert.ok(
		fs.existsSync(path.join(SKILL_ROOT, "scripts", "lib", "review-export.mjs")),
	);
	const workflow = fs.readFileSync(
		path.join(SKILL_ROOT, "references", "repository-workflow.md"),
		"utf8",
	);
	assert.match(
		workflow,
		/Helper-development permission alone does not authorize recording/,
	);
	assert.match(workflow, /Hard stop/);
	assert.match(workflow, /incomplete review candidate/);
	assert.match(workflow, /fresh independent-session acceptance/);
});

test("portable workflow discusses showcase once and commissions repo-local voice gaps without review budgets", () => {
	const workflow = fs.readFileSync(
		path.join(SKILL_ROOT, "references", "repository-workflow.md"),
		"utf8",
	);
	const voice = fs.readFileSync(
		path.join(SKILL_ROOT, "references", "voice-integration.md"),
		"utf8",
	);
	assert.match(workflow, /one approval covering/);
	assert.match(workflow, /no fixed round/);
	assert.doesNotMatch(
		workflow,
		/30 active minutes|two harmless fixture corrections|at most four helper/,
	);
	assert.match(voice, /Configuration alone never proves a feature works/);
	assert.match(voice, /host\/user must permit delegation/);
	assert.match(voice, /never implied by unlimited review/);
	assert.match(voice, /not a mandatory cross-app protocol/);
	assert.ok(
		fs.existsSync(path.join(SKILL_ROOT, "scripts", "lib", "voice-capture.mjs")),
	);
});

test("skill sources are portable: no host paths, owner names or endpoints", () => {
	const files = [
		path.join(SKILL_ROOT, "SKILL.md"),
		...["references", "scripts", "schemas"].flatMap((dir) =>
			walk(path.join(SKILL_ROOT, dir)),
		),
	];
	const forbidden = [
		/\/home\//,
		/\/Users\/[a-z]/,
		/[A-Z]:\\Users/,
		/realtime/i,
		/wukev/i,
		/kevinjcwu/i,
		/herdr/i,
		/https?:\/\/(?!127\.0\.0\.1[:/"`])[a-z0-9]/i,
	];
	for (const file of files) {
		// The JSON Schema dialect identifier is a URI, not an endpoint.
		const text = fs
			.readFileSync(file, "utf8")
			.replaceAll('"https://json-schema.org/draft/2020-12/schema"', "");
		for (const pattern of forbidden) {
			assert.equal(
				pattern.test(text),
				false,
				`${path.relative(SKILL_ROOT, file)} matches ${pattern}`,
			);
		}
	}
	for (const name of [
		"package.json",
		"package-lock.json",
		"pnpm-lock.yaml",
		"yarn.lock",
		"node_modules",
	]) {
		assert.equal(
			fs.existsSync(path.join(SKILL_ROOT, name)),
			false,
			`${name} must not exist in the skill root`,
		);
	}
	for (const file of walk(path.join(SKILL_ROOT, "scripts"))) {
		for (const [, specifier] of fs
			.readFileSync(file, "utf8")
			.matchAll(/from "([^"]+)"/g)) {
			assert.ok(
				specifier.startsWith("node:") || specifier.startsWith("./"),
				`${path.basename(file)} imports only built-ins: ${specifier}`,
			);
		}
	}
});

test("blocked capabilities are listed in the lifecycle and commands", () => {
	assert.match(skill, /not implemented \(blocked\)/);
	assert.match(skill, /available now/);
	for (const command of BLOCKED) {
		assert.ok(
			skill.includes(`\`${command}\``),
			`SKILL.md lists ${command} as not implemented`,
		);
	}
	const platforms = fs.readFileSync(
		path.join(SKILL_ROOT, "references", "platform-support.md"),
		"utf8",
	);
	for (const capability of [
		"Browser",
		"speech synthesis",
		"captions",
		"export",
		"run-local helper",
		"Desktop and mobile",
	]) {
		assert.match(platforms, new RegExp(capability, "i"));
	}
});

test("the distributed package ships no app-specific caller, private audio route, network namespace or review job", () => {
	// Interactions a target needs beyond the generic adapters are written by the agent per run (run-local helpers).
	const archived = [
		"voice-caller",
		"voice-fixture",
		"voice-live",
		"pulse-route",
		"calibration",
		"clock",
		"session-facts",
		"cloud-ledger",
		"stream-budget",
		"netns",
		"request-attribution",
		"request-attribution-preload",
		"review-client",
		"review-job",
		"review-loopback",
	];
	const files = walk(SKILL_ROOT)
		.filter((file) => !/[\\/]\.(runtime|runs|test-runs)[\\/]/.test(file))
		.map((file) => path.relative(SKILL_ROOT, file));
	for (const name of archived) {
		assert.ok(
			!files.some((file) => path.basename(file).startsWith(`${name}.`)),
			`${name} is not part of the package`,
		);
	}
	assert.ok(
		!files.some((file) => file.split(path.sep).includes("voice-web")),
		"no voice app fixture or example",
	);
	assert.ok(
		!fs.existsSync(path.join(SKILL_ROOT, "references", "voice-participant.md")),
	);
	for (const file of files.filter((rel) =>
		rel.startsWith(`scripts${path.sep}`),
	)) {
		const text = fs.readFileSync(path.join(SKILL_ROOT, file), "utf8");
		assert.doesNotMatch(
			text,
			/converse|pulseaudio|slirp4netns|PulseAudio/,
			file,
		);
		for (const [, specifier] of text.matchAll(/(?:from |import\()"([^"]+)"/g)) {
			assert.ok(
				!archived.some((name) => specifier.endsWith(`/${name}.mjs`)),
				`${file} imports ${specifier}`,
			);
		}
	}
	const scripts = fs.readdirSync(path.join(SKILL_ROOT, "scripts", "helpers"));
	assert.deepEqual(
		scripts,
		["static-server.mjs"],
		"the only bundled helper is the generic static file server",
	);
});

test("local state folders are ignored and never tracked as package content", (t) => {
	// Tools, run outputs and test scratch folders are made on each host; an
	// interrupted test can leave .test-runs behind, which must not be committed.
	const ignored = fs
		.readFileSync(path.join(SKILL_ROOT, ".gitignore"), "utf8")
		.split("\n")
		.map((line) => line.trim());
	for (const folder of [".runtime/", ".runs/", ".test-runs/"]) {
		assert.ok(ignored.includes(folder), `.gitignore lists ${folder}`);
	}
	// When the skill sits in a Git checkout, nothing under those folders is in
	// the next snapshot. A snapshot (`git add -A`) holds the tracked files still
	// present and the untracked files not ignored; a tracked file already deleted
	// here leaves with that snapshot.
	const git = (args) =>
		execFileSync("git", args, {
			cwd: SKILL_ROOT,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		})
			.split("\0")
			.filter(Boolean);
	let next;
	try {
		const deleted = new Set(git(["ls-files", "-z", "--deleted", "--", "."]));
		next = [
			...git(["ls-files", "-z", "--cached", "--", "."]).filter(
				(file) => !deleted.has(file),
			),
			...git(["ls-files", "-z", "--others", "--exclude-standard", "--", "."]),
		];
	} catch {
		// Outside a Git checkout (or without git) there is no snapshot to check:
		// said as a skip, never as a pass.
		t.skip("not in a Git checkout: the snapshot contents were not checked");
		return;
	}
	const local = next.filter((file) =>
		/^\.(runtime|runs|test-runs)\//.test(file),
	);
	assert.deepEqual(local, [], "local state in the next snapshot");
});
