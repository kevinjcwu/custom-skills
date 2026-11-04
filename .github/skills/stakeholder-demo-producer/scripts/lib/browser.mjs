// Owned, muted Chromium session.
//
// The pinned full Chromium runs headless with the run's own HOME, TMPDIR and
// profile. It is muted, and its audio client can reach only a nonexistent
// owned socket, never a shared sound server. No fake media device or fake
// permission-UI switch is passed and no device permission is granted. Every
// page HTTP request outside the approved loopback origins is aborted.
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { dirAlias } from "./proc-registry.mjs";
import { loadPlaywright, sha256File } from "./toolchain.mjs";

export const VIEWPORT = Object.freeze({ width: 1280, height: 720 });
export const FORBIDDEN_SWITCHES = [
	"--use-fake-device-for-media-stream",
	"--use-fake-ui-for-media-stream",
	"--use-file-for-fake-audio-capture",
	"--use-file-for-fake-video-capture",
	"--mute-audio",
	"--no-sandbox",
];

/** Absolute path of the installed full Chromium, verified against its install-time hash. */
export function chromiumExecutable(paths) {
	const installed = JSON.parse(fs.readFileSync(paths.installed, "utf8"));
	const entry = Object.values(installed.browser?.executables ?? {}).find((item) => item.path.endsWith("chrome-linux64/chrome"));
	if (!entry) {
		throw new Error("the pinned Chromium is not installed; run `sdp setup install`");
	}
	const file = path.join(paths.root, entry.path);
	if (sha256File(file) !== entry.sha256) {
		throw new Error("the Chromium executable differs from its install-time hash");
	}
	return { file, sha256: entry.sha256 };
}

function isLoopbackOrigin(origin) {
	try {
		const url = new URL(origin);
		return url.protocol === "http:" && url.hostname === "127.0.0.1" && url.origin === origin;
	} catch {
		return false;
	}
}

/**
 * The HTTP origin a WebSocket URL is allowed under: ws: maps to http: and wss: to https:.
 * @param {string} url
 * @returns {string | null} null for anything that is not a ws: or wss: URL.
 */
export function webSocketOrigin(url) {
	try {
		const parsed = new URL(url);
		const scheme = { "ws:": "http:", "wss:": "https:" }[parsed.protocol];
		return scheme ? new URL(`${scheme}//${parsed.host}`).origin : null;
	} catch {
		return null;
	}
}

/**
 * @param {{paths: object, dir: string, registry: import("./proc-registry.mjs").ProcRegistry,
 *   origins: string[], recordVideo?: boolean, id?: string, signal?: AbortSignal}} options
 *   signal: when it aborts the browser's process group is stopped at once, so
 *   any page operation still in flight fails instead of running on. This holds
 *   from start-up (the launch is refused with a "cancelled" error) through
 *   close() (nothing is saved and the kill result is returned).
 */
export async function launchBrowser({ paths, dir, registry, origins, recordVideo = true, id = "browser", signal }) {
	if (signal?.aborted) {
		throw new Error("cancelled before the browser was started");
	}
	// An empty origin list is allowed: every page request is then blocked
	// (used for rendering local content with setContent).
	if (!origins.every(isLoopbackOrigin)) {
		throw new Error("browser origins must be exact loopback origins (http scheme, host 127.0.0.1, explicit port)");
	}
	const home = path.join(dir, "browser-home");
	const tmp = path.join(dir, "browser-tmp");
	const videoDir = path.join(dir, "raw-video");
	for (const item of [home, tmp, videoDir]) {
		fs.mkdirSync(item, { recursive: true, mode: 0o700 });
	}
	const executable = chromiumExecutable(paths);
	// Playwright places its temporary profile under os.tmpdir().
	process.env.TMPDIR = tmp;
	const playwright = await loadPlaywright(paths);
	const libDir = path.join(paths.sysroot, "usr", "lib", "x86_64-linux-gnu");
	// Chromium creates its singleton socket under TMPDIR; keep that path short.
	const tmpAlias = dirAlias(tmp);
	const clientConf = path.join(home, "pulse-client.conf");
	fs.writeFileSync(clientConf, "autospawn = no\n");
	const audioEnv = { PULSE_SERVER: `unix:${path.join(tmpAlias.path, "no-audio-server")}`, PULSE_CLIENTCONFIG: clientConf };
	const env = {
		PATH: "/usr/bin:/bin",
		HOME: home,
		TMPDIR: tmpAlias.path,
		LANG: "C.UTF-8",
		LD_LIBRARY_PATH: libDir,
		...audioEnv,
	};
	// The listener is installed before the launch so that cancellation covers
	// start-up too. Until the browser is owned it only records the request;
	// afterwards it stops the owned process group.
	let cancelled = false;
	let owned = false;
	let killing = null;
	let notifyCancelled;
	const cancelRequested = new Promise((resolve) => {
		notifyCancelled = resolve;
	});
	const onAbort = () => {
		cancelled = true;
		if (owned) {
			killing ??= registry.stop(id, 500);
		}
		notifyCancelled();
	};
	signal?.addEventListener("abort", onAbort, { once: true });
	const refuseCancelled = async () => {
		signal?.removeEventListener("abort", onAbort);
		if (killing) {
			await killing;
		}
		tmpAlias.close();
		throw new Error("cancelled while the browser was starting");
	};
	if (signal?.aborted) {
		onAbort();
	}
	// launchServer (not launch) because only BrowserServer exposes the
	// browser ChildProcess; its control endpoint binds loopback only, on a
	// random port and path, and this process is its only client.
	const launching = playwright.chromium.launchServer({
		host: "127.0.0.1",
		port: 0,
		wsPath: `/${randomBytes(16).toString("hex")}`,
		executablePath: executable.file,
		headless: true,
		chromiumSandbox: true,
		env,
		ignoreDefaultArgs: [],
		args: [],
		handleSIGINT: false,
		handleSIGTERM: false,
		handleSIGHUP: false,
	});
	launching.catch(() => {});
	const first = await Promise.race([launching.then(() => "launched", () => "failed"), cancelRequested.then(() => "cancelled")]);
	if (first === "cancelled") {
		// Playwright's own signal handling is off, so the browser it is still
		// starting is found and stopped here; the launch then fails on its own.
		await stopStartingBrowser({ launching, registry, id, executable: executable.file, profileRoot: tmp });
		await refuseCancelled();
	}
	let server;
	try {
		server = await launching;
	} catch (error) {
		signal?.removeEventListener("abort", onAbort);
		tmpAlias.close();
		throw error;
	}
	if (cancelled) {
		await server.kill().catch(() => {});
		await refuseCancelled();
	}
	const child = server.process();
	const fail = async (message) => {
		signal?.removeEventListener("abort", onAbort);
		await server.kill();
		tmpAlias.close();
		throw new Error(message);
	};
	const endpoint = new URL(server.wsEndpoint());
	if (endpoint.hostname !== "127.0.0.1") {
		await fail("the browser control endpoint is not bound to loopback");
	}
	if (!child || child.pid === undefined) {
		await fail("the browser process could not be identified; refusing to continue without ownership");
	}
	try {
		registry.adopt(id, child, executable.file);
	} catch (error) {
		await fail(`the browser process could not be owned: ${error.message}`);
	}
	// From here the caller's cancellation stops the owned browser.
	owned = true;
	if (cancelled) {
		killing ??= registry.stop(id, 500);
		await refuseCancelled();
	}
	const cmdline = fs.readFileSync(`/proc/${child.pid}/cmdline`, "utf8").split("\0").filter(Boolean);
	if (cmdline[0] !== executable.file) {
		await fail("the owned process is not the pinned Chromium executable");
	}
	// The browser stays muted, so --mute-audio is expected here.
	const forbiddenNow = FORBIDDEN_SWITCHES.filter((name) => name !== "--mute-audio");
	const forbidden = cmdline.filter((arg) => forbiddenNow.some((name) => arg === name || arg.startsWith(`${name}=`)));
	if (forbidden.length) {
		await fail(`refusing a browser launched with forbidden switches: ${forbidden.join(" ")}`);
	}
	// A cancellation during the rest of the set-up kills the browser, which
	// makes the pending Playwright call fail; that is reported as cancelled.
	const setUp = async (operation) => {
		try {
			return await operation();
		} catch (error) {
			if (cancelled) {
				await refuseCancelled();
			}
			throw error;
		}
	};
	const browser = await setUp(() => playwright.chromium.connect(endpoint.href));
	const context = await setUp(() => browser.newContext({
		viewport: VIEWPORT,
		deviceScaleFactor: 1,
		...(recordVideo ? { recordVideo: { dir: videoDir, size: VIEWPORT } } : {}),
	}));
	const blocked = [];
	await setUp(() => context.route("**/*", (request) => {
		const url = request.request().url();
		let origin = null;
		try {
			origin = new URL(url).origin;
		} catch {
			origin = null;
		}
		if (origins.includes(origin)) {
			return request.continue();
		}
		blocked.push(url.slice(0, 200));
		return request.abort("blockedbyclient");
	}));
	// Playwright intercepts WebSockets separately from ordinary requests, and an
	// unrouted WebSocket connects directly. Every socket is therefore routed and
	// only connected to its server when its origin is on the same allowlist.
	await setUp(() => context.routeWebSocket(() => true, (socket) => {
		const url = socket.url();
		if (origins.includes(webSocketOrigin(url))) {
			socket.connectToServer();
			return;
		}
		blocked.push(url.slice(0, 200));
		socket.close({ code: 1008, reason: "blocked by the run's origin allowlist" });
	}));
	if (cancelled) {
		await refuseCancelled();
	}
	return {
		browser,
		pid: child.pid,
		controlEndpoint: `ws://127.0.0.1:${endpoint.port}/<random>`,
		context,
		executable,
		launchArgs: cmdline.slice(1).filter((arg) => !arg.startsWith("--user-data-dir")),
		videoDir,
		blocked,
		/**
		 * Closes the context (finishing the video), then the browser, then
		 * verifies the group is gone. A cancellation, also one arriving while
		 * this graceful close is still under way, stops the browser at once
		 * and nothing is saved.
		 */
		async close() {
			const cancelledClose = async () => {
				signal?.removeEventListener("abort", onAbort);
				// The browser is being stopped; nothing can be saved from it.
				const stopped = await killing;
				// Playwright encodes each page's video in a detached ffmpeg child of
				// this process, writing under this browser's private tmp folder; it
				// is stopped too.
				await stopOwnedChildren({ registry, id: `${id}-video`, match: (cmdline) => cmdline.some((arg) => arg.startsWith(`${tmp}${path.sep}`)) });
				tmpAlias.close();
				return { videos: [], stopped };
			};
			const CANCELLED = Symbol("cancelled");
			// Each graceful step is abandoned as soon as the browser is being killed.
			const orKilled = async (operation) => {
				const pending = Promise.resolve().then(operation);
				pending.catch(() => {});
				const outcome = await Promise.race([pending.then(() => null, (error) => ({ error })), cancelRequested.then(() => CANCELLED)]);
				if (outcome === CANCELLED || killing) {
					throw CANCELLED;
				}
				if (outcome) {
					throw outcome.error;
				}
			};
			if (killing) {
				return cancelledClose();
			}
			try {
				const videos = [];
				for (const page of context.pages()) {
					const video = page.video();
					if (video) {
						videos.push(video);
					}
				}
				await orKilled(() => context.close());
				const files = [];
				for (const [index, video] of videos.entries()) {
					const file = path.join(videoDir, `page-${index}.webm`);
					await orKilled(() => video.saveAs(file));
					files.push(file);
				}
				await orKilled(() => browser.close());
				await orKilled(() => server.close());
				signal?.removeEventListener("abort", onAbort);
				tmpAlias.close();
				const stopped = child ? await registry.stop(id, 3000) : { id, result: "exited", detail: "no child handle" };
				return { videos: files, stopped };
			} catch (error) {
				if (error === CANCELLED) {
					return cancelledClose();
				}
				throw error;
			}
		},
	};
}

/**
 * Stops a Chromium that Playwright is still starting. It is recognised as
 * this process's child running the pinned executable with a profile under
 * this browser's private temporary folder, so no other process is touched.
 * Playwright starts it as its own process-group leader, so its whole group is
 * stopped. Repeats until the launch has settled (bounded).
 */
async function stopStartingBrowser({ launching, registry, id, executable, profileRoot }) {
	const profilePrefix = `--user-data-dir=${profileRoot}${path.sep}`;
	const isStarting = (cmdline) => cmdline[0] === executable && cmdline.some((arg) => arg.startsWith(profilePrefix));
	let settled = false;
	const outcome = launching.then((server) => server, () => null).finally(() => {
		settled = true;
	});
	const stops = [];
	const seen = new Set();
	const sweep = () => {
		for (const pid of ownedChildren(isStarting)) {
			if (seen.has(pid)) {
				continue;
			}
			seen.add(pid);
			const entryId = `${id}-starting-${pid}`;
			registry.trackDescendant(entryId, pid);
			stops.push(registry.stop(entryId, 500));
		}
	};
	const deadline = Date.now() + 10000;
	while (!settled && Date.now() < deadline) {
		sweep();
		await Promise.race([outcome, new Promise((resolve) => setTimeout(resolve, 20))]);
	}
	const server = settled ? await outcome : null;
	if (server) {
		await server.kill().catch(() => {});
	}
	sweep();
	await Promise.all(stops);
}

/**
 * Stops this process's live children whose command line matches; each is
 * stopped with its process group when it leads one.
 */
async function stopOwnedChildren({ registry, id, match }) {
	await Promise.all(ownedChildren(match).map((pid) => {
		const entryId = `${id}-${pid}`;
		registry.trackDescendant(entryId, pid);
		return registry.stop(entryId, 500);
	}));
}

/** Live direct children of this process whose argv satisfies match. */
function ownedChildren(match) {
	const found = [];
	let names = [];
	try {
		names = fs.readdirSync("/proc");
	} catch {
		return found;
	}
	for (const name of names) {
		if (!/^\d+$/.test(name)) {
			continue;
		}
		try {
			// Fields after the command name's last ")" are fixed: state, ppid.
			const fields = fs.readFileSync(`/proc/${name}/stat`, "utf8");
			const [state, parent] = fields.slice(fields.lastIndexOf(")") + 2).split(" ");
			if (Number(parent) !== process.pid || state === "Z") {
				continue;
			}
			const cmdline = fs.readFileSync(`/proc/${name}/cmdline`, "utf8").split("\0");
			if (match(cmdline)) {
				found.push(Number(name));
			}
		} catch {
			// exited meanwhile
		}
	}
	return found;
}