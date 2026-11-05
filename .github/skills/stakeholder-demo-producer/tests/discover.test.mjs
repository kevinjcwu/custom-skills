import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { compileGitignore, discover } from "../scripts/lib/discover.mjs";
import { validateContract } from "../scripts/lib/contracts.mjs";
import { copyDir, FIXTURE_REPOS, makeTempDir, runSdp } from "./helpers.mjs";

const SECRET = "sentinel-secret-value-do-not-read";

test("voice discovery flags literal investigation leads, not working features", (t) => {
	const { dir, cleanup } = makeTempDir();
	t.after(cleanup);
	fs.writeFileSync(path.join(dir, "voice.ts"), `
		const capture = navigator.mediaDevices.getUserMedia({ audio: true });
		const options = { interrupt_response: true, turn_detection: {} };
		const event = "conversation.item.input_audio_transcription.completed";
		const stop = "response.cancel";
	`);
	const catalog = discover(dir);
	const signals = new Set(catalog.inventory.signals.map((entry) => entry.signal));
	for (const expected of ["microphone", "voice-interruption", "voice-transcription", "voice-turn-detection"]) {
		assert.ok(signals.has(expected), expected);
	}
	assert.ok(catalog.inventory.signals.every((entry) => entry.evidence && entry.line > 0));
	assert.ok(catalog.capabilities.every((entry) => entry.provenance === "inventory"));
	assert.ok(catalog.platforms.every((entry) => entry.class === "inferred"));
});

function prepareTarget(t, fixture) {
	const { dir, cleanup } = makeTempDir();
	t.after(cleanup);
	const root = path.join(dir, "target");
	copyDir(path.join(FIXTURE_REPOS, fixture), root);
	const outside = path.join(dir, "outside");
	fs.mkdirSync(outside);
	fs.writeFileSync(path.join(outside, "secret.txt"), `${SECRET}\n`);
	fs.appendFileSync(path.join(root, ".gitignore"), "dist/\n*.log\n");
	fs.writeFileSync(path.join(root, ".env"), `TOKEN=${SECRET}\n`);
	fs.writeFileSync(path.join(root, ".env.local"), `TOKEN=${SECRET}\n`);
	fs.writeFileSync(path.join(root, "id_rsa"), `${SECRET}\n`);
	fs.writeFileSync(path.join(root, "server.pem"), `${SECRET}\n`);
	fs.mkdirSync(path.join(root, ".git"));
	fs.writeFileSync(path.join(root, ".git", "config"), `${SECRET}\n`);
	fs.mkdirSync(path.join(root, "node_modules", "dep"), { recursive: true });
	fs.writeFileSync(path.join(root, "node_modules", "dep", "index.js"), `${SECRET}\n`);
	fs.mkdirSync(path.join(root, "dist"));
	fs.writeFileSync(path.join(root, "dist", "bundle.js"), `${SECRET}\n`);
	fs.writeFileSync(path.join(root, "debug.log"), `${SECRET}\n`);
	fs.mkdirSync(path.join(root, "nested"));
	fs.writeFileSync(path.join(root, "nested", ".gitignore"), "*.txt\n!keep.txt\n");
	fs.writeFileSync(path.join(root, "nested", "drop.txt"), `${SECRET}\n`);
	fs.writeFileSync(path.join(root, "nested", "keep.txt"), "kept\n");
	fs.symlinkSync(path.join(outside, "secret.txt"), path.join(root, "linked-secret.md"));
	fs.symlinkSync(outside, path.join(root, "linked-dir"));
	return { root, dir };
}

for (const fixture of ["static-web", "cli-api"]) {
	test(`discovers ${fixture} passively without reading denied, ignored or linked content`, (t) => {
		const { root, dir } = prepareTarget(t, fixture);
		const catalog = discover(root, { label: fixture });
		const json = JSON.stringify(catalog);

		assert.deepEqual(validateContract("capability-catalog", catalog), []);
		assert.ok(!json.includes(SECRET), "secret content leaked into the catalog");
		assert.ok(!json.includes("sentinel-example-value"), "config example values were copied");
		assert.ok(!json.includes(dir), "an absolute path leaked into the catalog");
		assert.equal(fs.existsSync(path.join(root, "EXECUTED-MARKER")), false, "a package script was executed");

		const skipped = new Map(catalog.skipped.map((item) => [item.path, item.reason]));
		for (const denied of [".env", ".env.local", "id_rsa", "server.pem", ".git", "node_modules"]) {
			assert.equal(skipped.get(denied), "denied", denied);
		}
		assert.equal(skipped.get("dist"), "ignored");
		assert.equal(skipped.get("debug.log"), "ignored");
		assert.equal(skipped.get("nested/drop.txt"), "ignored");
		assert.equal(skipped.has("nested/keep.txt"), false);
		assert.equal(skipped.get("linked-secret.md"), "symlink");
		assert.equal(skipped.get("linked-dir"), "symlink");
		assert.equal(catalog.repo.skippedCount, catalog.skipped.length);

		for (const item of catalog.evidence) {
			const bytes = fs.readFileSync(path.join(root, item.ref.path));
			assert.match(item.sha256, /^[0-9a-f]{64}$/);
			assert.notEqual(item.ref.path.startsWith("/"), true);
			assert.ok(bytes.length >= 0);
		}
		assert.ok(catalog.inventory.manifests.length > 0);
		assert.ok(catalog.inventory.entryPoints.length > 0);
		assert.ok(catalog.inventory.tests[0].titles.length > 0);
		assert.ok(catalog.inventory.docs[0].headings.length > 0);
		assert.ok(catalog.runCommands.every((command) => command.executed === false));
		assert.ok(catalog.platforms.every((platform) => platform.class === "inferred" && platform.reason));
		assert.ok(catalog.capabilities.every((capability) => capability.provenance === "inventory" && capability.class === "fact"));
		assert.deepEqual(catalog.components, []);
		assert.deepEqual(catalog.edges, []);
		assert.deepEqual(discover(root, { label: fixture }), catalog, "discovery is deterministic");
	});
}

test("static-web inventory reads only key names from config examples", (t) => {
	const { root } = prepareTarget(t, "static-web");
	const catalog = discover(root);
	assert.deepEqual(catalog.inventory.configExampleKeys[0].names, ["PAGE_TITLE", "CARD_LIMIT"]);
	assert.ok(catalog.inventory.entryPoints.some((entry) => entry.kind === "html-page" && entry.name === "Recipe Cards"));
	assert.deepEqual(catalog.platforms.map((platform) => platform.id), ["browser"]);
});

test("cli-api inventory finds the bin, the server candidate and run commands", (t) => {
	const { root } = prepareTarget(t, "cli-api");
	const catalog = discover(root);
	const kinds = catalog.inventory.entryPoints.map((entry) => entry.kind).sort();
	assert.deepEqual(kinds, ["bin", "cli-candidate", "server-candidate"]);
	assert.deepEqual(catalog.runCommands.map((command) => command.name), ["start", "test"]);
	assert.deepEqual(catalog.platforms.map((platform) => platform.id), ["http-service", "terminal"]);
});

test("bounds are respected and recorded", (t) => {
	const { root } = prepareTarget(t, "cli-api");
	fs.writeFileSync(path.join(root, "large.md"), "z".repeat(2048));
	const limited = discover(root, { limits: { maxFiles: 2, maxFileBytes: 1024 } });
	assert.equal(limited.repo.fileCount, 2);
	const reasons = new Map(limited.skipped.map((item) => [item.path, item.reason]));
	assert.equal(reasons.get("large.md"), "too-large");
	assert.ok([...reasons.values()].includes("limit"));
	assert.deepEqual(validateContract("capability-catalog", limited), []);
	assert.throws(() => discover(root, { limits: { maxFiles: 0 } }), { code: "invalid-limit" });
	assert.throws(() => discover(path.join(root, "missing")), { code: "read-failed" });
});

test("gitignore subset handles anchoring, globstar, classes and negation", () => {
	const rules = compileGitignore("# c\n/build\nlogs/**/*.log\n*.tmp\n!keep.tmp\nsrc/[ab].js\n", "");
	const match = (relPath) => {
		let ignored = false;
		for (const rule of rules) {
			if (rule.regex.test(relPath)) {
				ignored = !rule.negate;
			}
		}
		return ignored;
	};
	assert.equal(match("build"), true);
	assert.equal(match("sub/build"), false);
	assert.equal(match("logs/a/b/x.log"), true);
	assert.equal(match("logs/x.log"), true);
	assert.equal(match("deep/file.tmp"), true);
	assert.equal(match("deep/keep.tmp"), false);
	assert.equal(match("src/a.js"), true);
	assert.equal(match("src/c.js"), false);
});

test("ignore rules that cannot be applied exactly stop discovery instead of reading ignored files", async (t) => {
	const { dir, cleanup } = makeTempDir();
	t.after(cleanup);
	const sentinel = "SYNTHETIC_IGNORED_CONTENT";
	const cases = [
		["posix-class", "private[[:digit:]].md\n", {}, "gitignore-unsupported"],
		["reversed-range", "[z-a]\nprivate1.md\n", {}, "gitignore-unsupported"],
		["unclosed-class", "private[1.md\n", {}, "gitignore-unsupported"],
		["trailing-backslash", "private1.md\\\n", {}, "gitignore-unsupported"],
		["oversized", `# ${"x".repeat(200)}\nprivate1.md\n`, { maxFileBytes: 128 }, "gitignore-too-large"],
	];
	for (const [name, rules, limits, code] of cases) {
		const root = path.join(dir, name);
		fs.mkdirSync(path.join(root, "nested"), { recursive: true });
		fs.writeFileSync(path.join(root, "nested", ".gitignore"), rules);
		fs.writeFileSync(path.join(root, "nested", "private1.md"), `# ${sentinel}\n`);
		assert.throws(() => discover(root, { limits }), { code }, name);
		const cli = await runSdp(["discover", "--root", root, ...(limits.maxFileBytes ? ["--max-file-bytes", String(limits.maxFileBytes)] : [])]);
		assert.equal(cli.code, 1, name);
		assert.equal(cli.json.error.code, code, name);
		assert.equal(cli.json.error.details.path, "nested/.gitignore", name);
		assert.ok(!cli.stdout.includes(sentinel), name);
	}
	const linked = path.join(dir, "linked");
	fs.mkdirSync(linked);
	fs.writeFileSync(path.join(dir, "rules.txt"), "private1.md\n");
	fs.symlinkSync(path.join(dir, "rules.txt"), path.join(linked, ".gitignore"));
	assert.throws(() => discover(linked), { code: "gitignore-unsupported" });
	// Supported classes still compile and match.
	assert.equal(compileGitignore("private[0-9].md\nx[!ab]\n", "")[0].regex.test("private1.md"), true);
});

test("ignore files are read the way Git reads them: BOM, trailing spaces and raw bytes", async (t) => {
	const { dir, cleanup } = makeTempDir();
	t.after(cleanup);
	const sentinel = "SYNTHETIC_IGNORED_CONTENT";
	const bom = Buffer.from([0xef, 0xbb, 0xbf]);
	const cases = [
		["utf8-bom", Buffer.concat([bom, Buffer.from("private1.md\n")]), "private1.md"],
		["utf8-bom-crlf", Buffer.concat([bom, Buffer.from("private1.md\r\n")]), "private1.md"],
		// Git trims only unescaped U+0020; NBSP and escaped spaces are part of the name.
		["trailing-nbsp", Buffer.from("private\u00a0\n"), "private\u00a0"],
		["escaped-space", Buffer.from("private\\ \n"), "private "],
	];
	for (const [name, rules, ignored] of cases) {
		const root = path.join(dir, name);
		fs.mkdirSync(root);
		fs.writeFileSync(path.join(root, ".gitignore"), rules);
		fs.writeFileSync(path.join(root, ignored), `# ${sentinel}\n`);
		fs.writeFileSync(path.join(root, "README.md"), "# Visible\n");
		const catalog = discover(root);
		assert.deepEqual(catalog.skipped, [{ path: ignored, reason: "ignored" }], name);
		assert.ok(!JSON.stringify(catalog).includes(sentinel), name);
		const cli = await runSdp(["discover", "--root", root]);
		assert.equal(cli.code, 0, name);
		assert.ok(!cli.stdout.includes(sentinel), name);
	}
	assert.equal(compileGitignore("private\t\n", "")[0].regex.test("private"), false);

	const invalid = path.join(dir, "invalid-utf8");
	fs.mkdirSync(invalid);
	fs.writeFileSync(path.join(invalid, ".gitignore"), Buffer.concat([Buffer.from("private"), Buffer.from([0xff]), Buffer.from("\n")]));
	assert.throws(() => discover(invalid), { code: "gitignore-unsupported" });
});

test("an installed demo skill inside the target is skipped, not inventoried as the app", (t) => {
	const { dir, cleanup } = makeTempDir();
	t.after(cleanup);
	const root = path.join(dir, "target");
	copyDir(path.join(FIXTURE_REPOS, "static-web"), root);
	const skill = path.join(root, ".github", "skills", "demo");
	fs.mkdirSync(path.join(skill, "scripts"), { recursive: true });
	fs.writeFileSync(path.join(skill, "scripts", "tool.mjs"), "#!/usr/bin/env node\nnavigator.mediaDevices.getUserMedia({ audio: true });\n");
	const catalog = discover(root, { label: "static-web", excludeDirs: [skill] });
	assert.deepEqual(validateContract("capability-catalog", catalog), []);
	assert.deepEqual(catalog.skipped.filter((item) => item.reason === "demo-skill"), [{ path: ".github/skills/demo", reason: "demo-skill" }]);
	assert.equal(JSON.stringify(catalog.evidence).includes(".github/skills/demo"), false);
	assert.equal(catalog.platforms.some((item) => item.id === "audio"), false);
	const included = discover(root, { label: "static-web", excludeDirs: [] });
	assert.equal(included.platforms.some((item) => item.id === "audio"), true);
});
