// Project-local, hash-pinned media/browser toolchain.
//
// Everything is installed below one runtime directory (default
// <skill>/.runtime, override SDP_RUNTIME_DIR) from the exact sources in
// runtime/tool-lock.json. Downloads are verified before use, package
// lifecycle scripts never run, and nothing is installed system-wide.
// `check` re-hashes every installed artifact; `requireTools` (used by
// runs) verifies the cheaper size/mtime fingerprint recorded at install
// and refuses to run on any drift.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { createHash } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execCapture } from "./proc-registry.mjs";

export const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const RUNTIME_SOURCES = path.join(SKILL_ROOT, "runtime");

export function runtimeDir(env = process.env) {
	return path.resolve(env.SDP_RUNTIME_DIR || path.join(SKILL_ROOT, ".runtime"));
}

export function loadLock() {
	return JSON.parse(fs.readFileSync(path.join(RUNTIME_SOURCES, "tool-lock.json"), "utf8"));
}

export function sha256File(file) {
	const hash = createHash("sha256");
	const fd = fs.openSync(file, "r");
	try {
		const buffer = Buffer.allocUnsafe(1 << 20);
		let read;
		while ((read = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
			hash.update(buffer.subarray(0, read));
		}
	} finally {
		fs.closeSync(fd);
	}
	return hash.digest("hex");
}

export function gitBlobSha1(bytes) {
	return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

function sha256Text(text) {
	return createHash("sha256").update(text).digest("hex");
}

/** Host facts that decide whether the pinned toolchain can apply here. */
export function platformStatus() {
	let osRelease = "";
	try {
		osRelease = fs.readFileSync("/etc/os-release", "utf8");
	} catch {
		osRelease = "";
	}
	const field = (name) => new RegExp(`^${name}="?([^"\\n]*)"?$`, "m").exec(osRelease)?.[1] ?? null;
	const facts = { os: process.platform, arch: process.arch, distroId: field("ID"), distroVersion: field("VERSION_ID") };
	const supported = facts.os === "linux" && facts.arch === "x64" && facts.distroId === "ubuntu" && facts.distroVersion === "22.04";
	return {
		...facts,
		supported,
		reason: supported ? "linux x64 Ubuntu 22.04 matches the pinned toolchain" : "the pinned toolchain is only verified on linux x64 Ubuntu 22.04; this platform is blocked rather than assumed to work",
	};
}

function which(name, envPath) {
	for (const dir of (envPath ?? "").split(":").filter(Boolean)) {
		const file = path.join(dir, name);
		try {
			fs.accessSync(file, fs.constants.X_OK);
			return file;
		} catch {
			// keep looking
		}
	}
	return null;
}

/**
 * Host commands the toolchain relies on but does not pin; all are needed by
 * `setup install` only, never by a demo run.
 */
export function hostPrerequisites(env = process.env) {
	const searchPath = env.PATH ?? "/usr/bin:/bin";
	const items = [
		{ id: "dpkg-deb", need: "install", purpose: "extracts pinned Ubuntu packages into the private sysroot (install only)" },
		{ id: "uv", need: "install", purpose: "creates the hash-locked Piper virtual environment (install only)", env: "SDP_UV" },
	];
	return items.map((item) => {
		const found = (item.env && env[item.env]) || which(item.id, searchPath);
		return { ...item, path: found, status: found ? "present" : "missing" };
	});
}

/** Absolute paths of every installed tool. */
export function toolPaths(root = runtimeDir()) {
	const sysroot = path.join(root, "sysroot");
	const libDir = path.join(sysroot, "usr", "lib", "x86_64-linux-gnu");
	return {
		root,
		nodeModules: path.join(root, "node", "node_modules"),
		playwrightCore: path.join(root, "node", "node_modules", "playwright-core", "index.mjs"),
		browsersPath: path.join(root, "ms-playwright"),
		ffmpeg: path.join(root, "node", "node_modules", "ffmpeg-static", "ffmpeg"),
		ffprobe: path.join(root, "node", "node_modules", "@ffprobe-installer", "linux-x64", "ffprobe"),
		python: path.join(root, "piper-venv", "bin", "python"),
		voiceModel: path.join(root, "voices", "en_US-ljspeech-high.onnx"),
		voiceConfig: path.join(root, "voices", "en_US-ljspeech-high.onnx.json"),
		sysroot,
		ldLibraryPath: libDir,
		installed: path.join(root, "installed.json"),
		home: path.join(root, "home"),
		tmp: path.join(root, "tmp"),
	};
}

function readInstalled(paths) {
	try {
		return JSON.parse(fs.readFileSync(paths.installed, "utf8"));
	} catch {
		return {};
	}
}

function writeInstalled(paths, data) {
	fs.writeFileSync(paths.installed, `${JSON.stringify(data, null, "\t")}\n`);
}

function fingerprint(file) {
	const stat = fs.statSync(file);
	return { size: stat.size, mtimeMs: Math.round(stat.mtimeMs), ino: stat.ino };
}

function fingerprintMatches(file, recorded) {
	try {
		const now = fingerprint(file);
		return recorded && now.size === recorded.size && now.mtimeMs === recorded.mtimeMs && now.ino === recorded.ino;
	} catch {
		return false;
	}
}

/** True when the npm install directory holds exactly the current npm sources. */
function npmSourcesInstalled(nodeDir) {
	try {
		return ["package.json", "package-lock.json"].every((name) => fs.readFileSync(path.join(nodeDir, name), "utf8") === fs.readFileSync(path.join(RUNTIME_SOURCES, name), "utf8"));
	} catch {
		return false;
	}
}

function lockSha256() {
	return sha256Text(["tool-lock.json", "package.json", "package-lock.json", "piper-requirements.txt"].map((name) => fs.readFileSync(path.join(RUNTIME_SOURCES, name), "utf8")).join("\0"));
}

/**
 * Full verification: re-hashes every pinned artifact.
 * @returns {{platform: object, host: object[], items: {id: string, status: "verified"|"missing"|"mismatch", detail: string}[], ready: boolean}}
 */
export function checkToolchain(root = runtimeDir(), env = process.env) {
	const lock = loadLock();
	const paths = toolPaths(root);
	const installed = readInstalled(paths);
	const items = [];
	const add = (id, status, detail) => items.push({ id, status, detail });

	if (installed.lockSha256 && installed.lockSha256 !== lockSha256()) {
		add("lock", "mismatch", "runtime sources changed since install; rerun `sdp setup install`");
	}
	for (const pkg of lock.npm.packages) {
		const manifest = path.join(paths.nodeModules, ...pkg.name.split("/"), "package.json");
		try {
			const version = JSON.parse(fs.readFileSync(manifest, "utf8")).version;
			add(`npm:${pkg.name}`, version === pkg.version ? "verified" : "mismatch", `installed ${version}, pinned ${pkg.version}`);
		} catch {
			add(`npm:${pkg.name}`, "missing", "not installed");
		}
	}
	for (const file of lock.files) {
		const dest = path.join(root, file.dest);
		if (!fs.existsSync(dest)) {
			add(`file:${file.id}`, "missing", "not downloaded");
			continue;
		}
		let ok;
		if (file.gunzip) {
			ok = sha256File(dest) === file.gunzip.sha256;
		} else if (file.gitBlob) {
			ok = gitBlobSha1(fs.readFileSync(dest)) === file.gitBlob;
		} else {
			ok = sha256File(dest) === file.sha256;
		}
		add(`file:${file.id}`, ok ? "verified" : "mismatch", ok ? "content hash matches the lock" : "content hash differs from the lock");
	}
	const ffprobeOk = fs.existsSync(paths.ffprobe) && (fs.statSync(paths.ffprobe).mode & 0o111) !== 0;
	add("ffprobe-executable", ffprobeOk ? "verified" : "missing", ffprobeOk ? "ffprobe from the pinned npm package is executable" : "ffprobe missing or not executable");

	const python = installed.python;
	if (!fs.existsSync(paths.python) || !python) {
		add("python:piper", "missing", "Piper virtual environment not created");
	} else {
		const reqSha = sha256File(path.join(RUNTIME_SOURCES, "piper-requirements.txt"));
		add("python:piper", python.requirementsSha256 === reqSha ? "verified" : "mismatch", `requirements ${python.requirementsSha256 === reqSha ? "match" : "differ from"} the hash-locked install`);
	}
	for (const deb of lock.debs.packages) {
		const record = installed.debs?.[deb.package];
		add(`deb:${deb.package}`, record?.sha256 === deb.sha256 && record?.version === deb.version ? "verified" : record ? "mismatch" : "missing", record ? `extracted ${record.version}` : "not extracted");
	}
	const browser = installed.browser;
	if (!browser) {
		add("browser:chromium", "missing", "not installed");
	} else {
		let ok = true;
		for (const executable of Object.values(browser.executables)) {
			const file = path.join(root, executable.path);
			ok &&= fs.existsSync(file) && sha256File(file) === executable.sha256;
		}
		add("browser:chromium", ok ? "verified" : "mismatch", `revision ${browser.revision}; executable hashes ${ok ? "match" : "differ from"} first install (trust on first use)`);
	}
	const host = hostPrerequisites(env);
	const platform = platformStatus();
	// ready covers narration, browser and export: everything the packaged core needs.
	const ready = platform.supported && items.every((item) => item.status === "verified");
	return { platform, host, items, ready };
}

// Transient network failures are retried; identity mismatches are not.
export async function download(url, dest, pinned, attempts = 4) {
	for (let attempt = 1; ; attempt += 1) {
		try {
			return await downloadOnce(url, dest, pinned);
		} catch (error) {
			if (attempt >= attempts || /pinned|identity/.test(error.message)) {
				throw error;
			}
			await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
		}
	}
}

async function downloadOnce(url, dest, { size, sha256 }) {
	fs.mkdirSync(path.dirname(dest), { recursive: true });
	const part = `${dest}.part`;
	const response = await fetch(url, { redirect: "follow" });
	if (!response.ok || !response.body) {
		throw new Error(`download failed: HTTP ${response.status}`);
	}
	const hash = createHash("sha256");
	let bytes = 0;
	const out = fs.createWriteStream(part);
	await pipeline(
		Readable.fromWeb(response.body),
		async function* (source) {
			for await (const chunk of source) {
				bytes += chunk.length;
				if (size !== undefined && bytes > size) {
					throw new Error("download larger than the pinned size");
				}
				hash.update(chunk);
				yield chunk;
			}
		},
		out,
	);
	const digest = hash.digest("hex");
	if ((size !== undefined && bytes !== size) || (sha256 !== undefined && digest !== sha256)) {
		fs.rmSync(part, { force: true });
		throw new Error(`pinned identity mismatch for ${path.basename(dest)}: ${bytes} bytes sha256 ${digest}`);
	}
	return part;
}

function toolEnv(paths, extra = {}) {
	return {
		PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
		HOME: paths.home,
		TMPDIR: paths.tmp,
		LANG: "C.UTF-8",
		...extra,
	};
}

async function mustRun(label, command, args, options) {
	const result = await execCapture(command, args, { timeoutMs: 30 * 60 * 1000, ...options });
	if (result.code !== 0) {
		const tail = `${result.stderr}\n${result.stdout}`.trim().split("\n").slice(-8).join("\n");
		throw new Error(`${label} failed (exit ${result.code}${result.timedOut ? ", timed out" : ""}):\n${tail}`);
	}
	return result;
}

/**
 * Installs every missing or mismatching item. Idempotent.
 * @param {{root?: string, env?: object, log?: (line: string) => void}} [options]
 */
export async function installToolchain({ root = runtimeDir(), env = process.env, log = () => {} } = {}) {
	const platform = platformStatus();
	if (!platform.supported) {
		return { installed: false, blocked: platform.reason };
	}
	const host = hostPrerequisites(env);
	const missingHost = host.filter((item) => item.status === "missing");
	if (missingHost.length) {
		return { installed: false, blocked: `missing host commands: ${missingHost.map((item) => item.id).join(", ")}` };
	}
	const hostPath = Object.fromEntries(host.map((item) => [item.id, item.path]));
	const lock = loadLock();
	const paths = toolPaths(root);
	for (const dir of [root, paths.home, paths.tmp]) {
		fs.mkdirSync(dir, { recursive: true });
	}
	const installed = readInstalled(paths);
	const before = checkToolchain(root, env);
	const status = new Map(before.items.map((item) => [item.id, item.status]));
	const needs = (prefix) => before.items.some((item) => item.id.startsWith(prefix) && item.status !== "verified");

	// 1. npm packages, lifecycle scripts disabled. A lock change elsewhere
	// (for example pruned debs) does not reinstall unchanged npm sources.
	const nodeDir = path.join(root, "node");
	if (needs("npm:") || needs("ffprobe-executable") || !npmSourcesInstalled(nodeDir)) {
		fs.mkdirSync(nodeDir, { recursive: true });
		for (const name of ["package.json", "package-lock.json"]) {
			fs.copyFileSync(path.join(RUNTIME_SOURCES, name), path.join(nodeDir, name));
		}
		const npmCli = path.join(path.dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js");
		log("npm ci --ignore-scripts (pinned lock)");
		await mustRun("npm ci", process.execPath, [npmCli, "ci", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error"], {
			cwd: nodeDir,
			env: toolEnv(paths, { npm_config_cache: path.join(root, "npm-cache"), npm_config_update_notifier: "false" }),
		});
		// Replaces @ffprobe-installer/linux-x64's postinstall (chmod u+x ffprobe).
		fs.chmodSync(paths.ffprobe, 0o755);
		// npm ci replaced node_modules, so files placed inside it must be refetched.
		for (const file of lock.files) {
			if (file.dest.startsWith("node/")) {
				status.set(`file:${file.id}`, "missing");
			}
		}
	}

	// 2. Pinned files (ffmpeg binary that ffmpeg-static would fetch, voice).
	for (const file of lock.files) {
		if (status.get(`file:${file.id}`) === "verified") {
			continue;
		}
		const dest = path.join(root, file.dest);
		log(`download ${file.id}`);
		const part = await download(file.url, dest, { size: file.size, sha256: file.sha256 });
		if (file.gunzip) {
			const unpacked = `${dest}.unpacked`;
			await pipeline(fs.createReadStream(part), zlib.createGunzip(), fs.createWriteStream(unpacked));
			fs.rmSync(part);
			if (sha256File(unpacked) !== file.gunzip.sha256) {
				fs.rmSync(unpacked);
				throw new Error(`${file.id}: decompressed content does not match the lock`);
			}
			fs.renameSync(unpacked, dest);
		} else {
			if (file.gitBlob && gitBlobSha1(fs.readFileSync(part)) !== file.gitBlob) {
				fs.rmSync(part);
				throw new Error(`${file.id}: git blob identity does not match the lock`);
			}
			fs.renameSync(part, dest);
		}
		if (file.mode) {
			fs.chmodSync(dest, file.mode);
		}
	}

	// 3. Piper in a hash-locked virtual environment.
	if (needs("python:")) {
		const venv = path.join(root, "piper-venv");
		const uvEnv = toolEnv(paths, { UV_CACHE_DIR: path.join(root, "uv-cache"), UV_PYTHON_DOWNLOADS: "never", UV_NO_CONFIG: "1" });
		fs.rmSync(venv, { recursive: true, force: true });
		log("uv venv + pip install --require-hashes (piper)");
		await mustRun("uv venv", hostPath.uv, ["venv", venv, "--python", "3.12", "--no-project"], { env: uvEnv });
		await mustRun("uv pip install", hostPath.uv, ["pip", "install", "--python", path.join(venv, "bin", "python"), "--require-hashes", "--no-deps", "-r", path.join(RUNTIME_SOURCES, "piper-requirements.txt")], { env: uvEnv });
		installed.python = { requirementsSha256: sha256File(path.join(RUNTIME_SOURCES, "piper-requirements.txt")) };
		writeInstalled(paths, installed);
	}

	// 4. Ubuntu packages extracted into the private sysroot.
	installed.debs ??= {};
	for (const deb of lock.debs.packages) {
		if (status.get(`deb:${deb.package}`) === "verified") {
			continue;
		}
		log(`deb ${deb.package} ${deb.version}`);
		const file = path.join(root, "debs", path.basename(deb.path));
		const part = await download(new URL(deb.path, lock.debs.archive).href, file, { size: deb.size, sha256: deb.sha256 });
		fs.renameSync(part, file);
		await mustRun("dpkg-deb -x", hostPath["dpkg-deb"], ["-x", file, paths.sysroot], { env: toolEnv(paths) });
		fs.rmSync(file);
		installed.debs[deb.package] = { version: deb.version, sha256: deb.sha256 };
		writeInstalled(paths, installed);
	}
	fs.rmSync(path.join(root, "debs"), { recursive: true, force: true });

	// 5. Chromium for playwright-core 1.64.1.
	if (needs("browser:")) {
		log("playwright-core install chromium");
		const env2 = toolEnv(paths, { PLAYWRIGHT_BROWSERS_PATH: paths.browsersPath, PLAYWRIGHT_SKIP_BROWSER_GC: "1" });
		await mustRun("playwright install", process.execPath, [path.join(paths.nodeModules, "playwright-core", "cli.js"), "install", "chromium"], { env: env2 });
		const browsers = JSON.parse(fs.readFileSync(path.join(paths.nodeModules, "playwright-core", "browsers.json"), "utf8")).browsers;
		const executables = {};
		for (const dir of fs.readdirSync(paths.browsersPath)) {
			for (const candidate of ["chrome-linux64/chrome", "chrome-linux/chrome", "chrome-linux/headless_shell", "chrome-headless-shell-linux64/chrome-headless-shell", "ffmpeg-linux"]) {
				const file = path.join(paths.browsersPath, dir, candidate);
				if (fs.existsSync(file)) {
					executables[`${dir}/${candidate}`] = { path: path.relative(root, file), sha256: sha256File(file) };
				}
			}
		}
		installed.browser = { revision: browsers.find((item) => item.name === "chromium")?.revision ?? null, executables };
	}

	installed.lockSha256 = lockSha256();
	installed.fingerprints = {};
	for (const key of ["ffmpeg", "ffprobe", "python", "voiceModel"]) {
		installed.fingerprints[key] = fingerprint(paths[key]);
	}
	writeInstalled(paths, installed);
	return { installed: true, check: checkToolchain(root, env) };
}

/**
 * Cheap verification for runs: install-time fingerprints must still match.
 * @param {string[]} keys subset of toolPaths keys
 */
export function requireTools(keys, root = runtimeDir()) {
	const paths = toolPaths(root);
	const platform = platformStatus();
	if (!platform.supported) {
		return { ok: false, reason: platform.reason, paths };
	}
	const installed = readInstalled(paths);
	if (installed.lockSha256 !== lockSha256()) {
		return { ok: false, reason: "the toolchain is not installed for the current lock; run `sdp setup install`", paths };
	}
	const drift = keys.filter((key) => !fingerprintMatches(paths[key], installed.fingerprints?.[key]));
	if (drift.length) {
		return { ok: false, reason: `installed tools changed since setup (${drift.join(", ")}); run \`sdp setup check\``, paths };
	}
	return { ok: true, paths, installed };
}

/** Imports playwright-core from the runtime with a private browsers path. */
export async function loadPlaywright(paths) {
	process.env.PLAYWRIGHT_BROWSERS_PATH = paths.browsersPath;
	return import(pathToFileURL(paths.playwrightCore).href);
}
