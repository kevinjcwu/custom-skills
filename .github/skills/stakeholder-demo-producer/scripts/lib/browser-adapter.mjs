// Browser adapter: drives an owned, recorded Chromium session against one
// approved target service.
//
// The service is started from an approved executable in its own process
// group and must print a JSON readiness line naming a loopback origin; the
// listening socket must belong to that process. The browser loads only that
// origin. Actions are a fixed vocabulary (goto, click by role and accessible
// name, fill by label, press a key, wait until text is visible); no page script supplied
// by a storyboard is ever evaluated.
import fs from "node:fs";
import process from "node:process";
import path from "node:path";
import { Buffer } from "node:buffer";
import { launchBrowser } from "./browser.mjs";
import { WORKSPACE_TOKEN } from "./contracts.mjs";
import { resolveContained } from "./paths.mjs";

/** Monotonic milliseconds (the wall clock can step during a run). */
export const monoMs = () => Number(process.hrtime.bigint()) / 1e6;

export const BROWSER_DESCRIPTOR = Object.freeze({
	schema: "adapter-descriptor.v1",
	id: "browser",
	status: "implemented",
	roles: ["actor", "recorder"],
	operations: ["goto", "click", "fill", "press", "wait"],
	emits: ["action.start", "action.attempt", "action.end"],
	limits: ["timeoutMs", "maxOutputBytes", "killGraceMs", "retries"],
});

/** Replaces a leading {workspace} token with the run workspace path. */
export function substituteWorkspace(argv, workspacePath) {
	return argv.map((arg) => {
		if (arg === WORKSPACE_TOKEN) {
			return workspacePath;
		}
		if (arg.startsWith(`${WORKSPACE_TOKEN}/`)) {
			if (!workspacePath) {
				throw new Error("argv refers to {workspace} but the run has no workspace");
			}
			return resolveContained(workspacePath, arg.slice(WORKSPACE_TOKEN.length + 1));
		}
		return arg;
	});
}

function listeningInodes(port) {
	const inodes = new Set();
	for (const table of ["/proc/net/tcp", "/proc/net/tcp6"]) {
		let text = "";
		try {
			text = fs.readFileSync(table, "utf8");
		} catch {
			continue;
		}
		for (const line of text.split("\n").slice(1)) {
			const fields = line.trim().split(/\s+/);
			if (fields.length < 10) {
				continue;
			}
			const localPort = Number.parseInt(fields[1].split(":")[1], 16);
			// State 0A is LISTEN.
			if (localPort === port && fields[3] === "0A") {
				inodes.add(fields[9]);
			}
		}
	}
	return inodes;
}

/**
 * pid and every live process descended from it (read from /proc), so a
 * wrapper that starts the real server as its child still counts as the
 * started service. The service's process group is stopped as a whole.
 * @returns {Set<number>}
 */
export function processTree(pid) {
	const children = new Map();
	let entries = [];
	try {
		entries = fs.readdirSync("/proc");
	} catch {
		return new Set([pid]);
	}
	for (const name of entries) {
		if (!/^\d+$/.test(name)) {
			continue;
		}
		try {
			// The command name may contain spaces or parentheses; fields after the last ")" are fixed.
			const stat = fs.readFileSync(`/proc/${name}/stat`, "utf8");
			const parent = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
			if (!children.has(parent)) {
				children.set(parent, []);
			}
			children.get(parent).push(Number(name));
		} catch {
			// exited meanwhile
		}
	}
	const tree = new Set([pid]);
	const queue = [pid];
	while (queue.length) {
		for (const child of children.get(queue.shift()) ?? []) {
			if (!tree.has(child)) {
				tree.add(child);
				queue.push(child);
			}
		}
	}
	return tree;
}

/** Process group id of pid (read from /proc), or null. */
export function processGroupOf(pid) {
	try {
		const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
		return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2]);
	} catch {
		return null;
	}
}

/** The pid in pids that holds a listening TCP socket on port open (read from /proc), or null. */
export function listenerOwner(pids, port) {
	const inodes = listeningInodes(port);
	if (inodes.size === 0) {
		return null;
	}
	for (const pid of pids) {
		let fds = [];
		try {
			fds = fs.readdirSync(`/proc/${pid}/fd`);
		} catch {
			continue;
		}
		for (const fd of fds) {
			try {
				const match = /^socket:\[(\d+)\]$/.exec(fs.readlinkSync(`/proc/${pid}/fd/${fd}`));
				if (match && inodes.has(match[1])) {
					return pid;
				}
			} catch {
				// fd closed meanwhile
			}
		}
	}
	return null;
}

/** True when a listening TCP socket on port is held open by pid itself. */
export function listenerOwnedBy(pid, port) {
	return listenerOwner([pid], port) === pid;
}

/** Parses a readiness line; returns the loopback origin or throws. */
export function parseReadiness(line) {
	let doc;
	try {
		doc = JSON.parse(line);
	} catch {
		throw new Error("the service readiness line is not JSON");
	}
	if (doc?.ready !== true || typeof doc.origin !== "string") {
		throw new Error("the service readiness line must contain ready: true and an origin");
	}
	let url;
	try {
		url = new URL(doc.origin);
	} catch {
		throw new Error("the service origin is not a URL");
	}
	if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.port === "" || url.origin !== doc.origin) {
		throw new Error("the service origin must be an exact http loopback origin with an explicit port");
	}
	return { origin: url.origin, port: Number(url.port), pid: Number.isInteger(doc.pid) ? doc.pid : null };
}

/**
 * Starts the approved service and waits for its readiness line.
 * @param {{registry: import("./proc-registry.mjs").ProcRegistry, id: string, executable: string,
 *   argv: string[], cwd: string, env: Record<string,string>, readyTimeoutMs: number, maxOutputBytes: number,
 *   signal?: AbortSignal, onExceeded?: () => void}} options
 *   signal: cancellation ends the wait at once and stops the service.
 *   onExceeded: called once when the service first writes past maxOutputBytes,
 *   so the run can stop instead of continuing with incomplete logs.
 */
export async function startService({ registry, id, executable, argv, cwd, env, readyTimeoutMs, maxOutputBytes, signal, onExceeded }) {
	if (signal?.aborted) {
		return { ok: false, cancelled: true, error: "cancelled before the service was started", stopped: null, output: () => ({ stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exceeded: false }) };
	}
	const entry = registry.spawn(id, executable, argv, { env, cwd });
	const child = entry.child;
	const output = { stdout: [], stderr: [], bytes: 0, exceeded: false };
	const keep = (stream) => (chunk) => {
		if (output.exceeded || output.bytes + chunk.length > maxOutputBytes) {
			if (!output.exceeded) {
				output.exceeded = true;
				onExceeded?.();
			}
			return;
		}
		output.bytes += chunk.length;
		output[stream].push(chunk);
	};
	child.stdout.on("data", keep("stdout"));
	child.stderr.on("data", keep("stderr"));
	const ready = await new Promise((resolve) => {
		let settled = false;
		const onAbort = () => finish({ error: "cancelled while waiting for the service to become ready", cancelled: true });
		const finish = (value) => {
			if (!settled) {
				settled = true;
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				resolve(value);
			}
		};
		const timer = setTimeout(() => finish({ error: `no readiness line within ${readyTimeoutMs} ms` }), readyTimeoutMs);
		signal?.addEventListener("abort", onAbort, { once: true });
		const onData = () => {
			const text = Buffer.concat(output.stdout).toString("utf8");
			const newline = text.indexOf("\n");
			if (newline >= 0) {
				child.stdout.off("data", onData);
				try {
					finish({ value: parseReadiness(text.slice(0, newline)) });
				} catch (error) {
					finish({ error: error.message });
				}
			}
		};
		child.stdout.on("data", onData);
		entry.done.then((exit) => finish({ error: `the service exited before it was ready (${JSON.stringify(exit)})` }));
	});
	// Stops the service and any descendant that left its process group (a
	// detached server), which stopping the group alone would leave running.
	// The tree is read before anything is stopped: once the parent exits,
	// an escaped child is reparented and no longer traceable to it.
	const stopAll = async () => {
		const escaped = [...processTree(child.pid)].filter((pid) => pid !== child.pid && ![null, child.pid].includes(processGroupOf(pid)));
		const results = [await registry.stop(id)];
		for (const pid of escaped) {
			registry.trackDescendant(`${id}-escaped-${pid}`, pid);
			results.push(await registry.stop(`${id}-escaped-${pid}`));
		}
		return results.length === 1 ? results[0] : results;
	};
	const collected = () => ({ stdout: Buffer.concat(output.stdout), stderr: Buffer.concat(output.stderr), exceeded: output.exceeded });
	if (ready.error || signal?.aborted) {
		const stopped = await stopAll();
		const cancelled = Boolean(ready.cancelled || signal?.aborted);
		return { ok: false, ...(cancelled ? { cancelled } : {}), error: ready.error ?? "cancelled while the service was starting", stopped, output: collected };
	}
	const { origin, port, pid } = ready.value;
	// The started process or a process it started (an approved wrapper helper) may own the socket.
	const tree = processTree(child.pid);
	if (pid !== null && !tree.has(pid)) {
		const stopped = await stopAll();
		return { ok: false, error: "the readiness line names a pid that is neither the started service nor one of its child processes", stopped, output: collected };
	}
	const owner = listenerOwner(pid !== null ? [pid] : [...tree], port);
	if (owner === null) {
		const stopped = await stopAll();
		return { ok: false, error: "the announced port is not a listening socket owned by the started service or one of its child processes", stopped, output: collected };
	}
	if (processGroupOf(owner) !== child.pid) {
		// Cleanup stops the service's process group; a listener that left it could outlive the run.
		const stopped = await stopAll();
		return { ok: false, error: "the listening process left the service's process group, so the run could not stop it", stopped, output: collected };
	}
	if ([...processTree(child.pid)].some((member) => ![null, child.pid].includes(processGroupOf(member)))) {
		const stopped = await stopAll();
		return { ok: false, error: "a process the service started left its process group, so the run could not stop it", stopped, output: collected };
	}
	// After readiness the service may still start processes (a worker on a
	// later request). One that leaves the group would outlive the group
	// teardown, so the tree (and every tracked escapee's tree) is polled for
	// as long as the service runs; escapees are registered by exact pid
	// identity and stopped with the registry. A process that detaches and
	// whose parent exits between two polls cannot be traced (disclosed).
	const late = [];
	const sweep = () => {
		const roots = [child.pid, ...late.map((item) => item.pid)];
		for (const root of roots) {
			for (const member of processTree(root)) {
				if (member === child.pid || late.some((item) => item.pid === member) || [null, child.pid].includes(processGroupOf(member))) {
					continue;
				}
				// A member of an escapee's own group goes down with that group.
				if (late.some((item) => processGroupOf(member) === item.pid)) {
					continue;
				}
				const entryId = `${id}-escaped-${member}`;
				if (!registry.entries.has(entryId)) {
					registry.trackDescendant(entryId, member);
					late.push({ id: entryId, pid: member });
				}
			}
		}
	};
	const watcher = setInterval(sweep, SERVICE_WATCH_MS);
	watcher.unref();
	const stopWatching = () => {
		sweep();
		clearInterval(watcher);
	};
	return { ok: true, origin, port, pid: child.pid, listenerPid: owner, output: collected, escaped: () => late.map((item) => ({ ...item })), sweep, stopWatching };
}

/** How often a running service's process tree is checked for detached descendants. */
export const SERVICE_WATCH_MS = 100;

/**
 * A recorded browser session limited to one origin.
 */
export class BrowserSession {
	/**
	 * @param {{paths: object, dir: string, registry: import("./proc-registry.mjs").ProcRegistry,
	 *   origin: string, settleMs: number}} options
	 */
	static async open({ paths, dir, registry, origin, settleMs }) {
		const handle = await launchBrowser({ paths, dir, registry, origins: [origin], recordVideo: true, id: "browser" });
		const session = new BrowserSession();
		session.handle = handle;
		session.origin = origin;
		session.settleMs = settleMs;
		try {
			session.page = await handle.context.newPage();
		} catch (error) {
			await handle.close();
			throw error;
		}
		// The recording starts with the page; action times are relative to it, on
		// the monotonic clock (the wall clock can step during a run).
		session.t0Mono = monoMs();
		return session;
	}

	/** Milliseconds into the recording now, or at a monotonic time. */
	videoNow(mono = monoMs()) {
		return Math.max(0, mono - this.t0Mono);
	}

	/** Page text, screenshot and path after an action; never throws. */
	async snapshot() {
		const page = this.page;
		let text = Buffer.alloc(0);
		let screenshot = null;
		let pagePath = null;
		try {
			text = Buffer.from(await page.locator("body").innerText({ timeout: 2000 }), "utf8");
			screenshot = await page.screenshot({ type: "png", timeout: 5000 });
			const url = new URL(page.url());
			pagePath = url.origin === this.origin ? `${url.pathname}${url.search}` : null;
		} catch {
			// The page could not be read; the action outcome still stands.
		}
		return { text, screenshot, path: pagePath };
	}

	get ownership() {
		return { pid: this.handle.pid, executableSha256: this.handle.executable.sha256, launchArgs: this.handle.launchArgs.length };
	}

	/**
	 * Performs one action. Never throws for page-level failures.
	 * signal: cancellation ends the action at once with outcome "cancelled";
	 * an action that finishes after cancellation is also "cancelled", never
	 * "done". The abandoned page operation ends when the browser is closed.
	 * @returns {Promise<{outcome: "done"|"browser-error"|"cancelled", error?: object, startMs: number, endMs: number,
	 *   path: string|null, text: Buffer, screenshot: Buffer|null}>}
	 */
	async perform(action, { timeoutMs, signal } = {}) {
		const startMs = Math.round(this.videoNow());
		const cancelled = () => ({ outcome: "cancelled", error: { code: "cancelled", message: "the run was cancelled or reached its time limit during this browser action" }, startMs, endMs: Math.round(this.videoNow()), path: null, text: Buffer.alloc(0), screenshot: null });
		if (signal?.aborted) {
			return cancelled();
		}
		let onAbort;
		const aborted = new Promise((resolve) => {
			onAbort = () => resolve("aborted");
			signal?.addEventListener("abort", onAbort, { once: true });
		});
		const operation = this.#operate(action, timeoutMs);
		// The losing operation may reject later (for example when the browser closes).
		operation.catch(() => {});
		let result;
		try {
			result = await Promise.race([operation, aborted]);
		} finally {
			signal?.removeEventListener("abort", onAbort);
		}
		if (result === "aborted" || signal?.aborted) {
			return cancelled();
		}
		const endMs = Math.round(this.videoNow());
		const { text, screenshot, path: pagePath } = await this.snapshot();
		if (signal?.aborted) {
			return cancelled();
		}
		return { ...result, startMs, endMs, path: pagePath, text, screenshot };
	}

	/** Runs one page operation and its settle time; resolves to {outcome, error?}. */
	async #operate(action, timeoutMs) {
		const page = this.page;
		let outcome = "done";
		let error;
		try {
			switch (action.op) {
				case "goto":
					await page.goto(new URL(action.target, this.origin).href, { timeout: timeoutMs, waitUntil: "load" });
					break;
				case "click": {
					const colon = action.target.indexOf(":");
					await page.getByRole(action.target.slice(0, colon), { name: action.target.slice(colon + 1) }).click({ timeout: timeoutMs });
					break;
				}
				case "fill":
					await page.getByLabel(action.target).fill(action.value, { timeout: timeoutMs });
					break;
				case "press":
					await page.keyboard.press(action.value);
					break;
				case "wait":
					await page.getByText(action.target).first().waitFor({ state: "visible", timeout: timeoutMs });
					break;
				default:
					throw new Error(`unsupported browser op ${action.op}`);
			}
			if (this.settleMs > 0) {
				await page.waitForTimeout(this.settleMs);
			}
		} catch (thrown) {
			outcome = "browser-error";
			const first = String(thrown?.message ?? "error").split("\n")[0];
			error = { code: thrown?.name === "TimeoutError" ? "browser-timeout" : "browser-error", message: first.slice(0, 500) };
		}
		return { outcome, ...(error ? { error } : {}) };
	}

	/** Ends the recording and stops the browser process group. */
	async close() {
		const result = await this.handle.close();
		return { video: result.videos[0] ?? null, stopped: result.stopped, blocked: [...this.handle.blocked] };
	}
}
