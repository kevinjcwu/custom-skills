// Shared test helpers: valid example contracts and test-owned temp dirs.
import fs from "node:fs";
import path from "node:path";
import crypto, { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { spawn } from "node:child_process";
import { contentSha256 } from "../scripts/lib/canonical.mjs";

export const SKILL_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);
export const SDP = path.join(SKILL_ROOT, "scripts", "sdp.mjs");
export const FIXTURE_REPOS = path.join(SKILL_ROOT, "tests", "fixtures", "repos");
const TEST_RUNS = path.join(SKILL_ROOT, ".test-runs");

export const HASH_A = "a".repeat(64);
export const HASH_B = "b".repeat(64);

/** Creates .test-runs/<uuid> and returns {dir, cleanup}. */
export function makeTempDir() {
	const dir = path.join(TEST_RUNS, randomUUID());
	// Test files run in parallel processes; another one may remove the empty
	// .test-runs between our mkdir calls, so retry on ENOENT.
	for (let attempt = 0; ; attempt += 1) {
		fs.mkdirSync(TEST_RUNS, { recursive: true });
		try {
			fs.mkdirSync(dir);
			break;
		} catch (error) {
			if (error.code !== "ENOENT" || attempt >= 5) {
				throw error;
			}
		}
	}
	const real = fs.realpathSync(dir);
	const cleanup = () => {
		const runsReal = fs.realpathSync(TEST_RUNS);
		const rel = path.relative(runsReal, real);
		if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
			throw new Error(`refusing to remove ${real}: outside .test-runs`);
		}
		fs.rmSync(real, { recursive: true, force: true });
		try {
			fs.rmdirSync(runsReal);
		} catch (error) {
			// Another test process still owns a directory here, or removed it first.
			if (error.code !== "ENOTEMPTY" && error.code !== "ENOENT" && error.code !== "EEXIST") {
				throw error;
			}
		}
	};
	return { dir: real, cleanup };
}

const MEDIA_LOCK = path.join(TEST_RUNS, "media.lock");

function processAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error.code === "EPERM";
	}
}

/**
 * Holds the cross-file media lock until the test ends. node:test runs test
 * files in parallel; tests that record a browser or audio route in real time,
 * or encode long exports, must not overlap, or CPU starvation skews the
 * recorded timing and the (unchanged) calibration gate rightly fails. A lock
 * whose owner process is gone is taken over; waiting is bounded.
 */
export async function holdMediaLock(t, { waitMs = 20 * 60_000 } = {}) {
	const deadline = Date.now() + waitMs;
	for (;;) {
		try {
			fs.mkdirSync(TEST_RUNS, { recursive: true });
			fs.writeFileSync(MEDIA_LOCK, String(process.pid), { flag: "wx" });
			break;
		} catch (error) {
			if (error.code === "ENOENT") {
				continue;
			}
			if (error.code !== "EEXIST") {
				throw error;
			}
		}
		let owner = 0;
		try {
			owner = Number(fs.readFileSync(MEDIA_LOCK, "utf8"));
		} catch (error) {
			if (error.code === "ENOENT") {
				continue;
			}
			throw error;
		}
		if (owner === process.pid) {
			throw new Error("media lock is already held by this test process");
		}
		// An empty file is a lock being written right now, not a stale one.
		if (owner > 0 && !processAlive(owner)) {
			fs.rmSync(MEDIA_LOCK, { force: true });
			continue;
		}
		if (Date.now() > deadline) {
			throw new Error(`media lock still held by pid ${owner} after ${waitMs} ms`);
		}
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	t.after(() => {
		try {
			if (Number(fs.readFileSync(MEDIA_LOCK, "utf8")) === process.pid) {
				fs.rmSync(MEDIA_LOCK, { force: true });
				fs.rmdirSync(TEST_RUNS);
			}
		} catch (error) {
			if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY" && error.code !== "EEXIST") {
				throw error;
			}
		}
	});
}

export function copyDir(from, to) {
	fs.cpSync(from, to, { recursive: true, verbatimSymlinks: true });
}

export function clone(value) {
	return JSON.parse(JSON.stringify(value));
}

export function exampleCatalog() {
	return {
		schema: "capability-catalog.v1",
		generatedBy: { tool: "sdp", contractVersion: "1" },
		repo: { label: "example", contentSha256: HASH_A, fileCount: 2, skippedCount: 0 },
		evidence: [
			{ id: "ev.manifest", kind: "manifest", ref: { path: "package.json" }, sha256: HASH_A },
			{
				id: "ev.cli",
				kind: "source",
				ref: { path: "bin/cli.mjs", lines: { start: 1, end: 3 } },
				sha256: HASH_B,
			},
		],
		inventory: {
			manifests: [{ evidence: "ev.manifest", kind: "package.json" }],
			entryPoints: [{ evidence: "ev.cli", kind: "bin", name: "example-cli" }],
			tests: [],
			docs: [],
			configExampleKeys: [],
			signals: [],
		},
		runCommands: [
			{ id: "cmd.start", evidence: "ev.manifest", name: "start", command: "node bin/cli.mjs", executed: false },
		],
		platforms: [
			{ id: "terminal", name: "Terminal", class: "inferred", evidence: ["ev.cli"], reason: "bin entry" },
		],
		capabilities: [
			{
				id: "cap.cli",
				title: "Command-line entry point",
				class: "fact",
				provenance: "inventory",
				evidence: ["ev.cli"],
				userVisible: true,
				platform: "terminal",
			},
		],
		components: [
			{ id: "comp.cli", name: "CLI", kind: "cli", evidence: ["ev.cli"] },
			{ id: "comp.lib", name: "Library", kind: "library", evidence: [] },
		],
		edges: [
			{ id: "edge.cli-lib", from: "comp.cli", to: "comp.lib", label: "calls", class: "inferred", evidence: [] },
		],
		forbiddenClaims: [
			{ id: "no-scale", pattern: "\\b(million|scales to)\\b", reason: "no load evidence" },
		],
		unknowns: [],
		skipped: [],
	};
}

export function exampleStoryboard(catalog = exampleCatalog()) {
	return {
		schema: "storyboard.v1",
		catalogSha256: contentSha256(catalog),
		title: "Example demo",
		goal: "Show the CLI greeting",
		audiences: ["business", "engineering"],
		confidentiality: { onScreen: "synthetic-only", exportAudience: "internal" },
		clarifications: [],
		dataProvenance: [
			{ id: "data.synthetic", kind: "synthetic", description: "fixed greeting input", rightsConfirmed: true },
		],
		claims: [
			{
				id: "claim.greets",
				text: "The CLI prints a greeting",
				class: "observed",
				evidence: ["ev.cli"],
				demonstratedBy: ["act.greet"],
				capability: "cap.cli",
			},
			{
				id: "claim.lib",
				text: "The CLI probably calls the library",
				class: "inferred",
				evidence: [],
				demonstratedBy: [],
			},
		],
		scenes: [
			{
				id: "scene.greet",
				title: "Greeting",
				adapter: "process",
				capabilities: ["cap.cli"],
				dataProvenance: ["data.synthetic"],
				actions: [{ id: "act.greet", op: "run", ref: "run.greet" }],
				expect: [
					{ id: "exp.exit", action: "act.greet", check: "exitCode", value: 0 },
					{ id: "exp.out", action: "act.greet", check: "stdoutIncludes", value: "hello" },
				],
				narration: [
					{
						id: "nar.biz",
						audience: "business",
						text: "A single command greets the user.",
						claims: ["claim.greets"],
						caption: { source: "narration-text", provenance: "agent-drafted" },
					},
					{
						id: "nar.eng",
						audience: "engineering",
						text: "The bin entry prints to stdout and exits zero.",
						claims: ["claim.greets"],
						caption: { source: "narration-text", provenance: "agent-drafted" },
					},
				],
				diagram: { edges: ["edge.cli-lib"], caption: "CLI to library (code path only)" },
			},
		],
	};
}

export function exampleAuthorization(storyboard = exampleStoryboard(), overrides = {}) {
	return {
		schema: "run-authorization.v1",
		storyboardSha256: contentSha256(storyboard),
		subject: "synthetic-fixture",
		bindings: {
			targetRoot: overrides.targetRoot ?? "/approved/target",
			runDir: overrides.runDir ?? "/approved/runs",
			executables: [{ id: "node", path: overrides.node ?? "/approved/bin/node" }],
		},
		commands: [
			{
				id: "run.greet",
				executable: "node",
				argv: ["bin/cli.mjs", "greet", "world"],
				cwd: ".",
				env: [{ name: "GREETING", value: "hello" }],
				envPassthrough: [],
			},
		],
		network: "none",
		http: { requests: [] },
		limits: {
			timeoutMs: 10000,
			maxOutputBytes: 65536,
			maxResponseBytes: 65536,
			maxRequestBytes: 4096,
			killGraceMs: 500,
			retries: 0,
		},
		stopConditions: ["first-failure", "cancellation", "limit-exceeded"],
	};
}

export const BEHAVE = path.join(SKILL_ROOT, "tests", "fixtures", "processes", "behave.mjs");
export const FIXTURE_SERVER = path.join(FIXTURE_REPOS, "cli-api", "server", "server.mjs");

/**
 * Starts the loopback fixture server with process.execPath and stops it in
 * the test's after hook. Resolves to its exact origin.
 */
export function startFixtureServer(t) {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [FIXTURE_SERVER], {
			stdio: ["ignore", "pipe", "inherit"],
			env: {},
		});
		t.after(
			() =>
				new Promise((done) => {
					if (child.exitCode !== null || child.signalCode !== null) {
						done();
						return;
					}
					child.once("exit", () => done());
					child.kill("SIGTERM");
				}),
		);
		let text = "";
		child.stdout.on("data", (chunk) => {
			text += chunk;
			const match = /listening (\d+)/.exec(text);
			if (match) {
				resolve({ origin: `http://127.0.0.1:${match[1]}`, child });
			}
		});
		child.once("error", reject);
		child.once("exit", (code) => reject(new Error(`fixture server exited ${code}`)));
	});
}

/**
 * Builds a real catalog -> storyboard -> authorization chain against a copy
 * of the cli-api fixture inside `dir`. With `origin`, a loopback HTTP scene
 * against the fixture server is added.
 * @param {{dir: string, origin?: string, subject?: string, discover: Function}} options
 */
export function cliApiScenario({ dir, origin, subject = "target", discover }) {
	const targetRoot = path.join(dir, "target");
	const runDir = path.join(dir, "runs");
	copyDir(path.join(FIXTURE_REPOS, "cli-api"), targetRoot);
	fs.mkdirSync(runDir);
	const catalog = discover(targetRoot, { label: "cli-api fixture" });
	const claims = [
		{
			id: "claim.tally",
			text: "The tally command counts and lists the items it is given",
			class: "observed",
			evidence: ["ev.bin-tally.mjs"],
			demonstratedBy: ["act.tally"],
			capability: "cap.entry.cli-candidate-bin-tally.mjs",
		},
		{
			id: "claim.tests",
			text: "The counting logic is probably covered by unit tests",
			class: "inferred",
			evidence: [],
			demonstratedBy: [],
		},
	];
	const narration = (sceneId, claim, business, engineering) => [
		{ id: `nar.${sceneId}.business`, audience: "business", text: business, claims: [claim], caption: { source: "narration-text", provenance: "agent-drafted" } },
		{ id: `nar.${sceneId}.engineering`, audience: "engineering", text: engineering, claims: [claim], caption: { source: "narration-text", provenance: "agent-drafted" } },
	];
	const scenes = [
		{
			id: "scene.tally",
			title: "Counting items from the terminal",
			adapter: "process",
			capabilities: ["cap.entry.cli-candidate-bin-tally.mjs"],
			dataProvenance: ["data.synthetic"],
			actions: [{ id: "act.tally", op: "run", ref: "cmd.tally" }],
			expect: [
				{ id: "exp.tally.exit", action: "act.tally", check: "exitCode", value: 0 },
				{ id: "exp.tally.out", action: "act.tally", check: "stdoutIncludes", value: "items: alpha, beta" },
			],
			narration: narration(
				"tally",
				"claim.tally",
				"One short command turns a list of items into a readable summary.",
				"bin/tally.mjs add writes the item count and list to stdout and exits zero.",
			),
		},
	];
	const requests = [];
	if (origin) {
		claims.push({
			id: "claim.items",
			text: "The service returns its item list over HTTP",
			class: "observed",
			evidence: ["ev.server-server.mjs"],
			demonstratedBy: ["act.items"],
			capability: "cap.entry.server-candidate-server-server.mjs",
		});
		scenes.push({
			id: "scene.items",
			title: "Reading items from the local service",
			adapter: "http",
			capabilities: ["cap.entry.server-candidate-server-server.mjs"],
			dataProvenance: ["data.synthetic"],
			actions: [{ id: "act.items", op: "request", ref: "req.items" }],
			expect: [
				{ id: "exp.items.status", action: "act.items", check: "status", value: 200 },
				{ id: "exp.items.body", action: "act.items", check: "bodyIncludes", value: "alpha" },
			],
			narration: narration(
				"items",
				"claim.items",
				"The same items are available to other tools through a simple web request.",
				"GET /items on the loopback service answers 200 with a JSON item list.",
			),
		});
		requests.push({ id: "req.items", origin, method: "GET", path: "/items", headers: [{ name: "accept", value: "application/json" }] });
	}
	const storyboard = {
		schema: "storyboard.v1",
		catalogSha256: contentSha256(catalog),
		title: "Tally walkthrough",
		goal: "Show how items are counted and served",
		audiences: ["business", "engineering"],
		confidentiality: { onScreen: "synthetic-only", exportAudience: "internal" },
		clarifications: [],
		dataProvenance: [{ id: "data.synthetic", kind: "synthetic", description: "fixed item names alpha and beta", rightsConfirmed: true }],
		claims,
		scenes,
	};
	const authorization = {
		schema: "run-authorization.v1",
		storyboardSha256: contentSha256(storyboard),
		subject,
		bindings: { targetRoot, runDir, executables: [{ id: "node", path: process.execPath }] },
		commands: [{ id: "cmd.tally", executable: "node", argv: ["bin/tally.mjs", "add", "alpha", "beta"], cwd: ".", env: [], envPassthrough: [] }],
		network: origin ? "loopback" : "none",
		http: { requests },
		limits: { timeoutMs: 10000, maxOutputBytes: 65536, maxResponseBytes: 65536, maxRequestBytes: 4096, killGraceMs: 500, retries: 0 },
		stopConditions: ["first-failure", "cancellation", "limit-exceeded"],
	};
	return { targetRoot, runDir, catalog, storyboard, authorization };
}

/**
 * Source of a SYNTHETIC run-local interaction helper used only by these
 * tests. It proves the helper plumbing (protocol, page scripts, media,
 * limits, cleanup); it is not a real interaction and not a voice caller.
 * argv[2] selects a behaviour; the default "ok" asks the page script "say"
 * to add a line, writes a test tone and reports done.
 */
export const SYNTHETIC_HELPER = `import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";
const mode = process.argv[2] ?? "ok";
const out = process.env.SDP_OUT_DIR;
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const finish = (message, code = 0) => process.stdout.write(JSON.stringify(message) + "\\n", () => process.exit(code));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function tone(file, ms, amplitude = 0.3) {
	const rate = 48000;
	const count = Math.round((rate * ms) / 1000);
	const data = Buffer.alloc(count * 2);
	for (let i = 0; i < count; i += 1) data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * amplitude * 32767), i * 2);
	const head = Buffer.alloc(44);
	head.write("RIFF", 0); head.writeUInt32LE(36 + data.length, 4); head.write("WAVE", 8); head.write("fmt ", 12);
	head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22); head.writeUInt32LE(rate, 24);
	head.writeUInt32LE(rate * 2, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34); head.write("data", 36); head.writeUInt32LE(data.length, 40);
	fs.writeFileSync(file, Buffer.concat([head, data]));
}
const pending = new Map();
let calls = 0;
const page = (script, arg) => new Promise((resolve) => { const id = String(++calls); pending.set(id, resolve); send({ type: "page", id, script, arg }); });
const media = (file, extra = {}) => ({ file, role: "simulated-user", startMs: 0, caption: "Hello there (synthetic test tone)", ...extra });
async function run(start) {
	const value = start.action.value ?? "hello";
	switch (mode) {
		case "env": return finish({ type: "result", status: "done", detail: Object.keys(process.env).sort().join(",") });
		case "failed": case "blocked": case "unknown": return finish({ type: "result", status: mode, detail: "synthetic " + mode });
		case "false-done": return finish({ type: "result", status: "done", detail: "claims success without doing anything" });
		case "done-exit-1": return finish({ type: "result", status: "done" }, 1);
		case "no-result": return process.exit(0);
		case "not-json": process.stdout.write("hello from the helper\\n"); return sleep(60000);
		case "two-results": send({ type: "result", status: "done" }); return finish({ type: "result", status: "done" });
		case "hang": return sleep(60000);
		case "flood": process.stderr.write("x".repeat(200000)); return sleep(60000);
		case "escape": spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", detached: true }).unref(); return sleep(60000);
		case "unknown-script": { const reply = await page("nope", value); return finish({ type: "result", status: reply.ok ? "done" : "failed", detail: reply.error }); }
		case "overlap": {
			// Two files over the same span: one audible, one silent (amplitude 0).
			const reply = await page("say", value);
			if (!reply.ok) return finish({ type: "result", status: "failed", detail: reply.error });
			tone(path.join(out, "user.wav"), 600);
			tone(path.join(out, "silent.wav"), 600, 0);
			await sleep(700);
			return finish({ type: "result", status: "done", media: [media("user.wav"), media("silent.wav", { role: "second-user", caption: "Second voice (synthetic, silent)" })] });
		}
		// Lets the page call start before reporting, so the helper exits while it is still pending.
		case "page-then-exit": return process.stdout.write(JSON.stringify({ type: "page", id: "1", script: "say", arg: value }) + "\\n" + JSON.stringify({ type: "result", status: "done", detail: "did not wait for the page reply" }) + "\\n", () => process.exit(0));
		case "page-only": { const reply = await page("say", value); return finish({ type: "result", status: reply.ok ? "done" : "failed", detail: reply.ok ? JSON.stringify(reply.value) : reply.error }); }
		case "path-parent": tone(path.join(out, "..", "escape.wav"), 200); return finish({ type: "result", status: "done", media: [media("../escape.wav")] });
		case "path-absolute": tone(path.join(out, "a.wav"), 200); return finish({ type: "result", status: "done", media: [media(path.join(out, "a.wav"))] });
		case "symlink": tone(path.join(out, "..", "outside.wav"), 200); fs.symlinkSync(path.join(out, "..", "outside.wav"), path.join(out, "link.wav")); return finish({ type: "result", status: "done", media: [media("link.wav")] });
		case "not-wav": fs.writeFileSync(path.join(out, "a.wav"), "not audio"); return finish({ type: "result", status: "done", media: [media("a.wav")] });
		case "oversize": fs.writeFileSync(path.join(out, "a.wav"), ""); fs.truncateSync(path.join(out, "a.wav"), 17 * 1024 * 1024); return finish({ type: "result", status: "done", media: [media("a.wav")] });
		case "undeclared-role": tone(path.join(out, "a.wav"), 200); return finish({ type: "result", status: "done", media: [media("a.wav", { role: "app-reply" })] });
		case "outside-window": tone(path.join(out, "a.wav"), 3000); return finish({ type: "result", status: "done", media: [media("a.wav")] });
		case "bad-caption": tone(path.join(out, "a.wav"), 200); return finish({ type: "result", status: "done", media: [media("a.wav", { caption: "line\\u0007bell" })] });
		default: {
			const reply = await page("say", value);
			if (!reply.ok) return finish({ type: "result", status: "failed", detail: reply.error });
			tone(path.join(out, "user.wav"), 600);
			await sleep(700);
			return finish({ type: "result", status: "done", media: [media("user.wav")] });
		}
	}
}
readline.createInterface({ input: process.stdin }).on("line", (line) => {
	const message = JSON.parse(line);
	if (message.type === "start") run(message);
	else if (message.type === "page-result") pending.get(message.id)?.(message);
});
`;

/** SYNTHETIC page script for SYNTHETIC_HELPER: it adds its own line to the page (no app behaviour is shown). */
export const SYNTHETIC_PAGE_SCRIPT = `(text) => {
	const line = document.createElement("p");
	line.textContent = "Helper line: " + text;
	document.querySelector("main").append(line);
	return { added: line.textContent };
}
`;

/** The interaction entry the synthetic helper is approved under. */
export function syntheticInteraction(mode = "ok", overrides = {}) {
	return {
		id: "int.synthetic",
		purpose: "SYNTHETIC test helper: adds a line to the page and plays a test tone (plumbing only)",
		executable: "node",
		argv: ["{workspace}/helpers/synthetic-helper.mjs", mode],
		cwd: ".",
		env: [],
		envPassthrough: [],
		needs: ["browser-page"],
		pageScripts: [{ id: "say", file: "helpers/say.js" }],
		media: [{ role: "simulated-user", label: "Simulated user (synthetic test tone)", provenance: "generated" }],
		...overrides,
	};
}

/**
 * Static-web chain plus one helper action run by the synthetic helper.
 * Writes the helper files next to the plan (dir/helpers) and returns the
 * demo-plan helper entries that approve them.
 * @param {{dir: string, discover: Function, mode?: string, expectNew?: string, value?: string}} options
 */
export function helperWebScenario({ dir, discover, mode = "ok", expectNew = "Helper line: hello", value = "hello", interaction = {} }) {
	const scenario = staticWebScenario({ dir, discover });
	const scene = scenario.storyboard.scenes[0];
	scene.actions.push({ id: "act.helper", op: "helper", ref: "int.synthetic", value });
	scene.expect.push({ id: "exp.helper.line", action: "act.helper", check: "pageIncludesNew", value: expectNew });
	scenario.authorization.interactions = [syntheticInteraction(mode, interaction)];
	rechain(scenario);
	fs.mkdirSync(path.join(dir, "helpers"), { recursive: true });
	const files = { "static-server.mjs": fs.readFileSync(path.join(SKILL_ROOT, "scripts", "helpers", "static-server.mjs")), "synthetic-helper.mjs": Buffer.from(SYNTHETIC_HELPER), "say.js": Buffer.from(SYNTHETIC_PAGE_SCRIPT) };
	const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
	fs.writeFileSync(path.join(dir, "helpers", "synthetic-helper.mjs"), files["synthetic-helper.mjs"]);
	fs.writeFileSync(path.join(dir, "helpers", "say.js"), files["say.js"]);
	scenario.planHelpers = [
		{ id: "helper.static", source: "skill", file: "static-server.mjs", sha256: sha(files["static-server.mjs"]), purpose: "serve the page; the repo has no server of its own" },
		{ id: "helper.synthetic", source: "plan-dir", file: "synthetic-helper.mjs", sha256: sha(files["synthetic-helper.mjs"]), purpose: "SYNTHETIC test interaction helper (plumbing only)" },
		{ id: "helper.say", source: "plan-dir", file: "say.js", sha256: sha(files["say.js"]), purpose: "SYNTHETIC page script the test helper asks the run to evaluate" },
	];
	return scenario;
}

/**
 * Builds a static-web chain served by the skill's bundled static-server
 * helper (the fixture's own package scripts must never run).
 * @param {{dir: string, discover: Function}} options
 */
export function staticWebScenario({ dir, discover }) {
	const targetRoot = path.join(dir, "target");
	const runDir = path.join(dir, "runs");
	copyDir(path.join(FIXTURE_REPOS, "static-web"), targetRoot);
	fs.mkdirSync(runDir);
	const catalog = discover(targetRoot, { label: "static-web fixture" });
	const page = catalog.capabilities.find((capability) => capability.id === "cap.entry.html-page-recipe-cards");
	const storyboard = {
		schema: "storyboard.v1",
		catalogSha256: contentSha256(catalog),
		title: "Recipe cards",
		goal: "Show the recipe card page",
		audiences: ["business"],
		confidentiality: { onScreen: "synthetic-only", exportAudience: "internal" },
		clarifications: [],
		dataProvenance: [{ id: "data.synthetic", kind: "synthetic", description: "three fixed recipe names", rightsConfirmed: true }],
		claims: [{ id: "claim.cards", text: "The page lists the recipe cards", class: "observed", evidence: [page.evidence[0]], demonstratedBy: ["act.open"], capability: page.id }],
		scenes: [
			{
				id: "scene.cards",
				title: "The recipe cards",
				adapter: "browser",
				capabilities: [page.id],
				dataProvenance: ["data.synthetic"],
				actions: [{ id: "act.open", op: "goto", target: "/index.html" }],
				expect: [{ id: "exp.cards", action: "act.open", check: "pageIncludes", value: "Lemon rice" }],
				narration: [{ id: "nar.cards.business", audience: "business", text: "The page shows every recipe as a card.", claims: ["claim.cards"], caption: { source: "narration-text", provenance: "agent-drafted" } }],
			},
		],
	};
	const authorization = {
		schema: "run-authorization.v1",
		storyboardSha256: contentSha256(storyboard),
		subject: "target",
		bindings: { targetRoot, runDir, executables: [{ id: "node", path: process.execPath }] },
		commands: [],
		workspace: { dirs: [] },
		browser: { service: { id: "svc.static", executable: "node", argv: ["{workspace}/helpers/static-server.mjs"], cwd: ".", env: [], envPassthrough: [], readyTimeoutMs: 10000 }, settleMs: 300 },
		network: "loopback",
		http: { requests: [] },
		limits: { timeoutMs: 15000, maxOutputBytes: 65536, maxResponseBytes: 65536, maxRequestBytes: 4096, killGraceMs: 500, retries: 0 },
		stopConditions: ["first-failure", "cancellation", "limit-exceeded"],
	};
	return { targetRoot, runDir, catalog, storyboard, authorization };
}

/**
 * Turns a catalog -> storyboard -> authorization chain into a demo plan:
 * every user-visible capability is shown where a scene lists it, otherwise
 * left out with a reason.
 */
export function demoPlanFrom({ catalog, storyboard, authorization }, extra = {}) {
	const { schema, storyboardSha256, approvalRecord, ...runtime } = authorization;
	const features = catalog.capabilities
		.filter((capability) => capability.userVisible)
		.map((capability) => {
			const scenes = storyboard.scenes.filter((scene) => scene.capabilities.includes(capability.id)).map((scene) => scene.id);
			return scenes.length ? { capability: capability.id, scenes } : { capability: capability.id, omitted: { reason: "not part of this short demo" } };
		});
	return {
		schema: "demo-plan.v1",
		catalogSha256: contentSha256(catalog),
		// Every demo has the narrator; helper media are labelled by their authorization entries.
		voices: { narrator: "Narrator (generated voice)" },
		features,
		helpers: [],
		externalDestinations: [],
		estimate: { cloud: false, amountUsd: null, basis: "everything runs on this machine", maxRunSeconds: 120 },
		allowArchitectureCards: false,
		storyboard,
		runtime,
		...extra,
	};
}

/** Recomputes the storyboard -> authorization hash chain after edits. */
export function rechain(scenario) {
	scenario.storyboard.catalogSha256 = contentSha256(scenario.catalog);
	scenario.authorization.storyboardSha256 = contentSha256(scenario.storyboard);
	return scenario;
}

/**
 * Runs the sdp CLI with the current Node binary and parses its JSON output.
 * options.onStderr(textSoFar, child) is called on each stderr chunk (for example to interrupt at a step).
 * @returns {Promise<{code: number, json: any, stdout: string, stderr: string}>}
 */
export function runSdp(args, options = {}) {
	return new Promise((resolve, reject) => {
		const env = options.env ?? {};
		const runtimeOverride = process.env.SDP_RUNTIME_DIR;
		const child = spawn(process.execPath, [SDP, ...args], {
			cwd: options.cwd ?? SKILL_ROOT,
			stdio: ["ignore", "pipe", "pipe"],
			env: runtimeOverride ? { SDP_RUNTIME_DIR: runtimeOverride, ...env } : env,
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
			options.onStderr?.(stderr, child);
		});
		child.once("error", reject);
		child.once("close", (code) => {
			let json = null;
			try {
				json = JSON.parse(stdout);
			} catch {
				json = null;
			}
			resolve({ code, json, stdout, stderr });
		});
	});
}

export function writeJson(file, value) {
	fs.writeFileSync(file, `${JSON.stringify(value, null, "\t")}\n`);
	return file;
}
