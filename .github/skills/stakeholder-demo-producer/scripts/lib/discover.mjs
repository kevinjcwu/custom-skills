// Passive repository discovery.
//
// Walks a target root without executing anything, without invoking git and
// without following symlinks. Denied and ignored paths are recorded by name
// only and never read. The output is a capability-catalog draft: helper
// facts (inventory) with content-hashed evidence, platform signals labelled
// inferred, and no semantic capability claims. The agent adds components,
// edges and semantic capabilities afterwards, with their own evidence class.
import fs from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";
import { sha256Hex } from "./canonical.mjs";
import { hasControlCharacter } from "./paths.mjs";
import { SdpError } from "./errors.mjs";

export const DEFAULT_LIMITS = Object.freeze({
	maxFiles: 5000,
	maxFileBytes: 1024 * 1024,
	maxTotalBytes: 64 * 1024 * 1024,
});

const MAX_SKIPPED_RECORDS = 1000;
const MAX_SIGNALS_PER_FILE = 20;
const MAX_SIGNALS = 500;
const MAX_LIST = 500;

const DENIED_DIRS = new Set([
	".git",
	".hg",
	".svn",
	"node_modules",
	".pnpm-store",
	".venv",
	"venv",
	"__pycache__",
	".ssh",
	".gnupg",
	".aws",
	".azure",
	".gcloud",
	".kube",
	".docker",
]);

// The installed skill describes the demo tooling, not the target app; a
// target that contains it is inventoried without it.
const SKILL_ROOT = path.resolve(import.meta.dirname, "..", "..");

const CONFIG_EXAMPLES = new Set([".env.example", ".env.sample", ".env.template"]);

const DENIED_FILE_PATTERNS = [
	/^\.env(\..*)?$/i,
	/\.(pem|key|p12|pfx|jks|keystore|crt|cer|der|kdbx|ppk)$/i,
	/^id_(rsa|dsa|ecdsa|ed25519)/i,
	/^(credentials|secrets?)(\..*)?$/i,
	/^\.(npmrc|netrc|pypirc|git-credentials)$/i,
	/^local\.settings\.json$/i,
];

const MANIFESTS = new Map([
	["package.json", "package.json"],
	["pyproject.toml", "pyproject.toml"],
	["requirements.txt", "requirements.txt"],
	["go.mod", "go.mod"],
	["Cargo.toml", "Cargo.toml"],
	["pom.xml", "pom.xml"],
	["build.gradle", "build.gradle"],
	["Gemfile", "Gemfile"],
	["composer.json", "composer.json"],
	["Dockerfile", "Dockerfile"],
	["docker-compose.yml", "docker-compose"],
	["docker-compose.yaml", "docker-compose"],
	["compose.yml", "docker-compose"],
	["compose.yaml", "docker-compose"],
]);

const SOURCE_EXTENSIONS = new Set([
	".js",
	".mjs",
	".cjs",
	".ts",
	".tsx",
	".jsx",
	".vue",
	".py",
	".cs",
	".go",
	".html",
	".htm",
]);

// Fixed, documented signal table. A signal is a literal source pattern; the
// platform it suggests is an inference and is labelled as such.
const SIGNALS = [
	{ signal: "process-argv", regex: /\bprocess\.argv\b/, platform: "terminal" },
	{ signal: "python-argparse", regex: /\bargparse\b/, platform: "terminal" },
	{ signal: "http-server", regex: /\b(createServer|express\(\)|fastify\(|app\.listen\(|FastAPI\(|Flask\()/, platform: "http-service" },
	{ signal: "browser-dom", regex: /\b(document\.querySelector|document\.getElementById|window\.addEventListener)\b/, platform: "browser" },
	{ signal: "browser-fetch", regex: /\bfetch\(/, platform: "browser" },
	{ signal: "websocket", regex: /\bWebSocket\b/, platform: "live-network" },
	{ signal: "webrtc", regex: /\bRTCPeerConnection\b/, platform: "live-network" },
	{ signal: "microphone", regex: /\bgetUserMedia\b/, platform: "audio" },
	{ signal: "web-audio", regex: /\bAudioContext\b/, platform: "audio" },
	{ signal: "speech-synthesis", regex: /\bspeechSynthesis\b/, platform: "audio" },
];

const PLATFORM_NAMES = {
	terminal: "Terminal / command line",
	"http-service": "HTTP service",
	browser: "Web browser",
	"live-network": "Live network connection (WebSocket or WebRTC)",
	audio: "Audio input or output",
};

// "%" is not a word character, so it must not be followed by \b: that would
// miss "90%." and "90% ". Units that are words keep their trailing \b.
export const METRIC_PATTERN =
	"\\d+(?:[.,]\\d+)?\\s?(?:%|(?:ms|milliseconds|seconds|minutes|hours|percent|per cent|x|times (?:faster|cheaper|more|less)|users|requests per second|rps|uptime)\\b)";

const DEFAULT_FORBIDDEN = [
	{
		id: "unevidenced-metric",
		pattern: METRIC_PATTERN,
		reason: "Quantitative claims need a recorded measurement in this run's evidence.",
	},
	{
		id: "absolute-quality",
		pattern: "\\b(production[- ]ready|enterprise[- ]grade|secure by default|guaranteed|bug[- ]free|fully compliant)\\b",
		reason: "Absolute quality claims cannot be demonstrated by a demo run.",
	},
];

const DEFAULT_UNKNOWNS = [
	{
		id: "unknown.audience",
		question: "Who is the audience (business, engineering or both) and what decision should the demo support?",
		impact: "Determines narration mode and which journey to show.",
	},
	{
		id: "unknown.confidentiality",
		question: "May repository content appear on screen, or must every visible value be synthetic?",
		impact: "Determines storyboard confidentiality and data provenance.",
	},
	{
		id: "unknown.execution-authority",
		question: "Who may approve running commands or contacting services, and which ones?",
		impact: "Nothing runs until a human confirms the run authorization hash.",
	},
];

function isDeniedFile(name) {
	if (CONFIG_EXAMPLES.has(name)) {
		return false;
	}
	return DENIED_FILE_PATTERNS.some((pattern) => pattern.test(name));
}

// --- .gitignore subset -----------------------------------------------------

function unsupported(reason) {
	return new Error(reason);
}

function globToRegex(glob) {
	let out = "";
	for (let index = 0; index < glob.length; index += 1) {
		const char = glob[index];
		if (char === "*") {
			if (glob[index + 1] === "*") {
				const slashAfter = glob[index + 2] === "/";
				out += slashAfter ? "(?:.*/)?" : ".*";
				index += slashAfter ? 2 : 1;
			} else {
				out += "[^/]*";
			}
		} else if (char === "?") {
			out += "[^/]";
		} else if (char === "[") {
			const negated = glob[index + 1] === "!" || glob[index + 1] === "^";
			const start = index + 1 + (negated ? 1 : 0);
			const close = glob.indexOf("]", start);
			if (close === -1) {
				throw unsupported("unclosed character class");
			}
			const body = glob.slice(start, close);
			// Forms whose git meaning differs from a plain regex class are refused
			// rather than approximated: an empty or "]"-leading class, POSIX
			// classes such as [[:digit:]], escapes and nested brackets.
			if (body === "" || body.includes("[") || body.includes("\\")) {
				throw unsupported("unsupported character class");
			}
			for (let at = body.indexOf("-", 1); at !== -1 && at < body.length - 1; at = body.indexOf("-", at + 2)) {
				if (body.charCodeAt(at - 1) > body.charCodeAt(at + 1)) {
					throw unsupported("reversed character range");
				}
			}
			out += `[${negated ? "^" : ""}${body.replace(/\^/g, "\\^")}]`;
			index = close;
		} else if (char === "\\") {
			if (index + 1 >= glob.length) {
				throw unsupported("trailing backslash");
			}
			out += glob[index + 1].replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
			index += 1;
		} else {
			out += char.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
		}
	}
	return out;
}

/**
 * Compiles the supported .gitignore subset: comments, blank lines, "!"
 * negation, trailing "/" for directories, leading or inner "/" anchoring,
 * "*", "?", "**" and simple character classes ([abc], [a-z], [!a]).
 * Anything else (POSIX classes, escapes inside classes, reversed ranges,
 * unclosed classes, a trailing backslash) throws: discovery fails closed
 * rather than read files the repository meant to ignore.
 * @param {string} text
 * @param {string} base Directory of the .gitignore, relative to the root ("" for root).
 */
export function compileGitignore(text, base) {
	const rules = [];
	// Git skips one leading UTF-8 BOM; keeping it would hide the first rule.
	const body = text.startsWith("\uFEFF") ? text.slice(1) : text;
	for (const [lineIndex, rawLine] of body.split(/\r?\n/).entries()) {
		const lineNumber = lineIndex + 1;
		let line = trimTrailingSpaces(rawLine);
		if (line === "" || line.startsWith("#")) {
			continue;
		}
		let negate = false;
		if (line.startsWith("!")) {
			negate = true;
			line = line.slice(1);
		}
		let dirOnly = false;
		if (line.endsWith("/")) {
			dirOnly = true;
			line = line.slice(0, -1);
		}
		if (line === "") {
			continue;
		}
		const anchored = line.includes("/");
		if (line.startsWith("/")) {
			line = line.slice(1);
		}
		let regex;
		try {
			const body = globToRegex(line);
			regex = new RegExp(anchored ? `^${body}$` : `^(?:.*/)?${body}$`);
		} catch (error) {
			throw gitignoreError("gitignore-unsupported", base, `line ${lineNumber}: ${error.message}; discovery stops instead of guessing what is ignored`);
		}
		rules.push({ base, negate, dirOnly, regex });
	}
	return rules;
}

/**
 * Git's rule: drop trailing unescaped spaces (U+0020 only). Tabs, NBSP and other
 * whitespace stay part of the pattern; a backslash escapes the next character.
 */
function trimTrailingSpaces(line) {
	let end = 0;
	for (let index = 0; index < line.length; index += 1) {
		if (line[index] === "\\" && index + 1 < line.length) {
			index += 1;
			end = index + 1;
		} else if (line[index] !== " ") {
			end = index + 1;
		}
	}
	return line.slice(0, end);
}

function gitignoreError(code, base, message) {
	const file = base ? `${base}/.gitignore` : ".gitignore";
	return new SdpError(code, `${file}: ${message}`, { details: { path: file } });
}

function isIgnored(rules, relPath, isDir) {
	let ignored = false;
	for (const rule of rules) {
		let candidate = relPath;
		if (rule.base !== "") {
			if (!relPath.startsWith(`${rule.base}/`)) {
				continue;
			}
			candidate = relPath.slice(rule.base.length + 1);
		}
		if (rule.dirOnly && !isDir) {
			continue;
		}
		if (rule.regex.test(candidate)) {
			ignored = !rule.negate;
		}
	}
	return ignored;
}

// --- walk ------------------------------------------------------------------

function walk(rootReal, limits, excludeDirs) {
	const files = [];
	const skipped = [];
	let skippedCount = 0;
	let totalBytes = 0;
	const skip = (relPath, reason) => {
		skippedCount += 1;
		if (relPath !== null && skipped.length < MAX_SKIPPED_RECORDS) {
			skipped.push({ path: relPath, reason });
		}
	};

	const visitDir = (absDir, relDir, inheritedRules) => {
		let rules = inheritedRules;
		const gitignore = path.join(absDir, ".gitignore");
		let stat = null;
		try {
			stat = fs.lstatSync(gitignore);
		} catch (error) {
			if (error.code !== "ENOENT") {
				throw gitignoreError("gitignore-unreadable", relDir, "cannot be read; discovery stops instead of guessing what is ignored");
			}
		}
		// Ignore rules that cannot be applied exactly stop discovery (fail closed).
		if (stat) {
			if (!stat.isFile()) {
				throw gitignoreError("gitignore-unsupported", relDir, "is not a regular file; discovery stops instead of guessing what is ignored");
			}
			if (stat.size > limits.maxFileBytes) {
				throw gitignoreError("gitignore-too-large", relDir, "exceeds maxFileBytes; discovery stops instead of skipping its rules");
			}
			let bytes;
			try {
				bytes = fs.readFileSync(gitignore);
			} catch {
				throw gitignoreError("gitignore-unreadable", relDir, "cannot be read; discovery stops instead of guessing what is ignored");
			}
			let text;
			try {
				// Git matches raw bytes; decoding invalid UTF-8 to U+FFFD could change a rule.
				text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
			} catch {
				throw gitignoreError("gitignore-unsupported", relDir, "is not valid UTF-8; discovery stops instead of guessing what is ignored");
			}
			rules = rules.concat(compileGitignore(text, relDir));
		}
		let entries;
		try {
			entries = fs.readdirSync(absDir, { withFileTypes: true });
		} catch {
			skip(relDir || null, "unreadable");
			return;
		}
		entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
		for (const entry of entries) {
			const name = entry.name;
			if (hasControlCharacter(name) || name.includes("\\")) {
				skip(null, "unsupported-name");
				continue;
			}
			const relPath = relDir ? `${relDir}/${name}` : name;
			const absPath = path.join(absDir, name);
			if (entry.isSymbolicLink()) {
				skip(relPath, "symlink");
				continue;
			}
			const isDir = entry.isDirectory();
			if (isDir ? DENIED_DIRS.has(name) : entry.isFile() && isDeniedFile(name)) {
				skip(relPath, "denied");
				continue;
			}
			if (isDir && excludeDirs.has(absPath)) {
				skip(relPath, "demo-skill");
				continue;
			}
			if (isIgnored(rules, relPath, isDir)) {
				skip(relPath, "ignored");
				continue;
			}
			if (isDir) {
				visitDir(absPath, relPath, rules);
				continue;
			}
			if (!entry.isFile()) {
				skip(relPath, "special");
				continue;
			}
			let stat;
			try {
				stat = fs.lstatSync(absPath);
			} catch {
				skip(relPath, "unreadable");
				continue;
			}
			if (stat.size > limits.maxFileBytes) {
				skip(relPath, "too-large");
				continue;
			}
			if (files.length >= limits.maxFiles || totalBytes + stat.size > limits.maxTotalBytes) {
				skip(relPath, "limit");
				continue;
			}
			let bytes;
			try {
				bytes = fs.readFileSync(absPath);
			} catch {
				skip(relPath, "unreadable");
				continue;
			}
			totalBytes += bytes.length;
			files.push({ path: relPath, name, bytes, sha256: sha256Hex(bytes) });
		}
	};

	visitDir(rootReal, "", []);
	return { files, skipped, skippedCount };
}

// --- extraction --------------------------------------------------------------

function textOf(file) {
	if (file.bytes.includes(0)) {
		return null;
	}
	return file.bytes.toString("utf8");
}

function trimText(value) {
	const text = String(value).replace(/\s+/g, " ").trim();
	return text.length > 4000 ? text.slice(0, 4000) : text;
}

function isTestFile(relPath, name) {
	return (
		/\.(test|spec)\.[a-z]+$/i.test(name) ||
		/^test_.*\.py$/.test(name) ||
		/(^|\/)(__tests__)\//.test(relPath)
	);
}

function testTitles(text) {
	const titles = [];
	const js = /\b(?:test|it|describe)\s*\(\s*(["'`])((?:(?!\1).){1,300})\1/g;
	const py = /^\s*def\s+(test_[A-Za-z0-9_]+)/gm;
	for (const match of text.matchAll(js)) {
		titles.push(trimText(match[2]));
	}
	for (const match of text.matchAll(py)) {
		titles.push(match[1]);
	}
	return titles.filter((title) => title.length > 0).slice(0, MAX_LIST);
}

function markdownHeadings(text) {
	const headings = [];
	let fenced = false;
	for (const line of text.split(/\r?\n/)) {
		if (/^\s*(```|~~~)/.test(line)) {
			fenced = !fenced;
			continue;
		}
		const match = !fenced && /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
		if (match) {
			headings.push(trimText(match[1]));
		}
	}
	return headings.filter((heading) => heading.length > 0).slice(0, MAX_LIST);
}

function exampleKeyNames(text) {
	const names = [];
	for (const line of text.split(/\r?\n/)) {
		const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
		if (match && !names.includes(match[1])) {
			names.push(match[1]);
		}
	}
	return names.slice(0, MAX_LIST);
}

function slug(relPath) {
	return relPath
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^[^a-z0-9]+/, "")
		.slice(0, 64);
}

/**
 * Discovers a target root and returns a capability-catalog.v1 draft.
 * @param {string} root Absolute or cwd-relative path of the target root.
 * @param {{label?: string, limits?: Partial<typeof DEFAULT_LIMITS>}} [options]
 */
export function discover(root, options = {}) {
	const limits = { ...DEFAULT_LIMITS, ...(options.limits ?? {}) };
	for (const [key, value] of Object.entries(limits)) {
		if (!Number.isInteger(value) || value < 1) {
			throw new SdpError("invalid-limit", `${key} must be a positive integer`);
		}
	}
	let rootReal;
	try {
		rootReal = fs.realpathSync(root);
	} catch {
		throw new SdpError("read-failed", "target root does not exist");
	}
	if (!fs.statSync(rootReal).isDirectory()) {
		throw new SdpError("read-failed", "target root is not a directory");
	}
	const excludeDirs = new Set();
	for (const dir of options.excludeDirs ?? [SKILL_ROOT]) {
		try {
			excludeDirs.add(fs.realpathSync(dir));
		} catch {
			// A directory that does not exist cannot be inside the target.
		}
	}
	const { files, skipped, skippedCount } = walk(rootReal, limits, excludeDirs);

	const evidence = [];
	const evidenceByPath = new Map();
	const usedIds = new Set();
	const evidenceFor = (file, kind) => {
		if (evidenceByPath.has(file.path)) {
			return evidenceByPath.get(file.path);
		}
		let id = `ev.${slug(file.path)}`;
		if (id === "ev." || usedIds.has(id)) {
			id = `ev.${slug(file.path).slice(0, 55)}.${file.sha256.slice(0, 8)}`;
		}
		let counter = 1;
		while (usedIds.has(id)) {
			id = `ev.${file.sha256.slice(0, 12)}.${counter}`;
			counter += 1;
		}
		usedIds.add(id);
		evidence.push({ id, kind, ref: { path: file.path }, sha256: file.sha256 });
		evidenceByPath.set(file.path, id);
		return id;
	};

	const inventory = {
		manifests: [],
		entryPoints: [],
		tests: [],
		docs: [],
		configExampleKeys: [],
		signals: [],
	};
	const runCommands = [];
	const usedCommandIds = new Set();
	const platformEvidence = new Map();
	const notePlatform = (platform, evidenceId, why) => {
		if (!platformEvidence.has(platform)) {
			platformEvidence.set(platform, { evidence: new Set(), why: new Set() });
		}
		platformEvidence.get(platform).evidence.add(evidenceId);
		platformEvidence.get(platform).why.add(why);
	};

	for (const file of files) {
		const text = textOf(file);
		const ext = path.extname(file.name).toLowerCase();

		if (MANIFESTS.has(file.name)) {
			const id = evidenceFor(file, "manifest");
			inventory.manifests.push({ evidence: id, kind: MANIFESTS.get(file.name) });
			if (file.name === "package.json" && text !== null) {
				let pkg = null;
				try {
					pkg = JSON.parse(text);
				} catch {
					pkg = null;
				}
				if (pkg && typeof pkg === "object") {
					for (const [name, command] of Object.entries(pkg.scripts ?? {})) {
						if (typeof command !== "string" || trimText(name) === "" || trimText(command) === "") {
							continue;
						}
						let commandId = `cmd.${slug(name)}` || "cmd";
						let counter = 1;
						while (usedCommandIds.has(commandId)) {
							commandId = `cmd.${slug(name).slice(0, 60)}.${counter}`;
							counter += 1;
						}
						usedCommandIds.add(commandId);
						runCommands.push({
							id: commandId,
							evidence: id,
							name: trimText(name),
							command: trimText(command),
							executed: false,
						});
					}
					const bins = typeof pkg.bin === "string" ? { [pkg.name ?? "bin"]: pkg.bin } : (pkg.bin ?? {});
					for (const name of Object.keys(bins)) {
						if (trimText(name) !== "") {
							inventory.entryPoints.push({ evidence: id, kind: "bin", name: trimText(name) });
							notePlatform("terminal", id, "package bin entry");
						}
					}
					if (typeof pkg.main === "string" && trimText(pkg.main) !== "") {
						inventory.entryPoints.push({ evidence: id, kind: "main", name: trimText(pkg.main) });
					}
				}
			}
		} else if (CONFIG_EXAMPLES.has(file.name) && text !== null) {
			// Only key names are read; values are never copied.
			const id = evidenceFor(file, "config-example");
			inventory.configExampleKeys.push({ evidence: id, names: exampleKeyNames(text) });
		} else if (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(file.path)) {
			evidenceFor(file, "ci");
		} else if (isTestFile(file.path, file.name) && text !== null) {
			const id = evidenceFor(file, "test");
			inventory.tests.push({ evidence: id, titles: testTitles(text) });
		} else if (/\.(md|markdown)$/i.test(file.name) && text !== null) {
			const id = evidenceFor(file, "doc");
			inventory.docs.push({ evidence: id, headings: markdownHeadings(text) });
		}

		if (!SOURCE_EXTENSIONS.has(ext) || text === null || isTestFile(file.path, file.name)) {
			continue;
		}
		if (ext === ".html" || ext === ".htm") {
			const id = evidenceFor(file, "source");
			const title = /<title[^>]*>([^<]{1,300})<\/title>/i.exec(text);
			inventory.entryPoints.push({
				evidence: id,
				kind: "html-page",
				name: trimText(title?.[1] ?? "") || file.path,
			});
			notePlatform("browser", id, "HTML page");
		}
		if (text.startsWith("#!")) {
			const id = evidenceFor(file, "source");
			inventory.entryPoints.push({ evidence: id, kind: "cli-candidate", name: file.path });
			notePlatform("terminal", id, "executable script shebang");
		}
		let perFile = 0;
		const lines = text.split(/\r?\n/);
		for (let index = 0; index < lines.length; index += 1) {
			if (perFile >= MAX_SIGNALS_PER_FILE || inventory.signals.length >= MAX_SIGNALS) {
				break;
			}
			for (const rule of SIGNALS) {
				if (rule.regex.test(lines[index])) {
					const id = evidenceFor(file, "source");
					inventory.signals.push({ evidence: id, signal: rule.signal, line: index + 1 });
					notePlatform(rule.platform, id, `signal ${rule.signal}`);
					if (rule.signal === "http-server" && perFile === 0) {
						inventory.entryPoints.push({ evidence: id, kind: "server-candidate", name: file.path });
					}
					perFile += 1;
				}
			}
		}
	}

	const platforms = [...platformEvidence.entries()]
		.sort(([a], [b]) => (a < b ? -1 : 1))
		.map(([id, value]) => ({
			id,
			name: PLATFORM_NAMES[id],
			class: "inferred",
			evidence: [...value.evidence].sort(),
			reason: trimText(`Suggested by: ${[...value.why].sort().join(", ")}. A signal is not a demonstrated capability.`),
		}));

	const capabilities = [];
	const usedCapabilityIds = new Set();
	for (const entry of inventory.entryPoints) {
		let id = `cap.entry.${slug(`${entry.kind}-${entry.name}`)}`.slice(0, 72);
		let counter = 1;
		while (usedCapabilityIds.has(id)) {
			id = `${id.slice(0, 70)}.${counter}`;
			counter += 1;
		}
		usedCapabilityIds.add(id);
		capabilities.push({
			id,
			title: trimText(`Entry point (${entry.kind}): ${entry.name}`),
			class: "fact",
			provenance: "inventory",
			evidence: [entry.evidence],
			userVisible: entry.kind === "html-page" || entry.kind === "bin" || entry.kind === "cli-candidate",
		});
	}

	const unknowns = DEFAULT_UNKNOWNS.map((item) => ({ ...item }));
	if (inventory.tests.length === 0) {
		unknowns.push({
			id: "unknown.tests",
			question: "No test files were found. Which behaviour is known to work?",
			impact: "Claims must rely on a demonstrated run, not on tests.",
		});
	}

	const contentLines = files.map((file) => `${file.path}\0${file.sha256}\n`).join("");
	return {
		schema: "capability-catalog.v1",
		generatedBy: { tool: "sdp-discover", contractVersion: "1" },
		repo: {
			label: options.label ?? "target",
			contentSha256: sha256Hex(contentLines),
			fileCount: files.length,
			skippedCount,
		},
		evidence,
		inventory,
		runCommands,
		platforms,
		capabilities,
		components: [],
		edges: [],
		forbiddenClaims: DEFAULT_FORBIDDEN.map((item) => ({ ...item })),
		unknowns,
		skipped,
	};
}

/** Content digest of a root, computed exactly as discover() does. */
export function targetContentSha256(root, options = {}) {
	return discover(root, options).repo.contentSha256;
}
