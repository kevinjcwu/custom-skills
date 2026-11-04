// Owned child processes.
//
// Every long-lived helper (audio server, recorders, browser, fixture
// services) is spawned through a registry that remembers its pid, its
// /proc start time and its command. Teardown signals only entries whose
// start time still matches, so a recycled pid or somebody else's process
// is never touched. Children get their own process group so a whole
// helper tree can be stopped together. Nothing is ever killed by name.
import fs from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

/** Start time (clock ticks since boot) of a live pid, or null. */
export function procStartTime(pid) {
	try {
		const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
		// The command name is parenthesised and may contain spaces.
		const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		return fields[19] ?? null;
	} catch {
		return null;
	}
}

/** Process group id of a live pid, or null. */
export function getpgid(pid) {
	try {
		const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
		return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2]);
	} catch {
		return null;
	}
}

/**
 * Short alias for an owned directory whose path is too long for Unix
 * sockets (108 bytes). /proc/<pid>/fd/<n> names the directory while this
 * process holds the descriptor open; close() releases it.
 * @param {string} dir
 * @param {number} [limit] longest socket path the caller will create inside it
 */
export function dirAlias(dir, limit = 60) {
	if (Buffer.byteLength(dir) <= limit) {
		return { path: dir, via: "path", close() {} };
	}
	let fd = fs.openSync(dir, "r");
	return {
		path: `/proc/${process.pid}/fd/${fd}`,
		via: "directory-descriptor",
		close() {
			if (fd !== null) {
				fs.closeSync(fd);
				fd = null;
			}
		},
	};
}

/**
 * Members of a process group with their /proc state letter.
 * @param {number} pgid
 * @returns {{pid: number, state: string}[]}
 */
export function groupMembers(pgid) {
	const members = [];
	let names = [];
	try {
		names = fs.readdirSync("/proc");
	} catch {
		return members;
	}
	for (const name of names) {
		if (!/^\d+$/.test(name)) {
			continue;
		}
		try {
			const stat = fs.readFileSync(`/proc/${name}/stat`, "utf8");
			const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
			if (Number(fields[2]) === pgid) {
				members.push({ pid: Number(name), state: fields[0] });
			}
		} catch {
			// raced with exit
		}
	}
	return members;
}

// A zombie (Z) or dead (X) member has already exited and holds no
// resources; it waits only for its parent (or a namespace init that does
// not reap orphans) to collect it, so it does not keep a group "alive".
export function groupAlive(pgid, { probe = probeGroup, members: scan = groupMembers } = {}) {
	if (!probe(pgid)) {
		return false;
	}
	const members = scan(pgid);
	if (members.length) {
		return members.some((m) => m.state !== "Z" && m.state !== "X");
	}
	// /proc shows nothing: either another pid namespace, or the last member (a
	// zombie) was reaped between the probe and the scan. Only a group that
	// still answers a second probe is alive.
	return probe(pgid);
}

/** Whether signal 0 reaches any process of the group (EPERM still means it exists). */
function probeGroup(pgid) {
	try {
		process.kill(-pgid, 0);
		return true;
	} catch (error) {
		return error.code === "EPERM";
	}
}

// A tracked descendant is alive while its start time matches and it is not a zombie.
function descendantAlive(entry) {
	if (entry.startTime === null || procStartTime(entry.pid) !== entry.startTime) {
		return false;
	}
	try {
		const stat = fs.readFileSync(`/proc/${entry.pid}/stat`, "utf8");
		const state = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0];
		return state !== "Z" && state !== "X";
	} catch {
		return false;
	}
}

function zombieNote(pgid) {
	const zombies = groupMembers(pgid).filter((m) => m.state === "Z" || m.state === "X");
	return zombies.length > 0 ? `; ${zombies.length} exited member(s) awaiting reaping (state Z)` : "";
}

export class ProcRegistry {
	/** @param {{logFile?: string}} [options] */
	constructor(options = {}) {
		this.entries = new Map();
		this.logFile = options.logFile ?? null;
		this.records = [];
	}

	#log(record) {
		this.records.push(record);
		if (this.logFile) {
			fs.appendFileSync(this.logFile, `${JSON.stringify(record)}\n`);
		}
	}

	/**
	 * Spawns and registers a child in its own process group.
	 * @param {string} id unique registry id
	 * @param {string} command absolute executable path
	 * @param {string[]} args
	 * @param {{env: Record<string,string>, cwd?: string, stdio?: any}} options env is complete; nothing is inherited
	 */
	spawn(id, command, args, options) {
		if (this.entries.has(id)) {
			throw new Error(`process id ${id} already registered`);
		}
		const child = spawn(command, args, {
			env: options.env,
			cwd: options.cwd,
			stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
			detached: true,
		});
		return this.#track(id, child, command, "spawn");
	}

	/**
	 * Registers a child started by a library (for example the browser
	 * Playwright launches). It must lead its own process group.
	 * @param {string} id
	 * @param {import("node:child_process").ChildProcess} child
	 * @param {string} command
	 */
	adopt(id, child, command) {
		if (this.entries.has(id)) {
			throw new Error(`process id ${id} already registered`);
		}
		if (child.pid === undefined || getpgid(child.pid) !== child.pid) {
			throw new Error("only a process-group leader can be adopted");
		}
		return this.#track(id, child, command, "adopt");
	}

	/**
	 * Registers a process the run caused but did not spawn: a descendant that
	 * left its parent's process group (for example a server a wrapper started
	 * detached). Stopping the parent's group would miss it, so it gets its own
	 * entry; it is signalled only while its /proc start time still matches.
	 * One that leads its own process group is recorded as its leader: that
	 * group is stopped even after the leader has exited (Linux keeps a group's
	 * id from reuse while any member lives).
	 * @param {string} id
	 * @param {number} pid
	 */
	trackDescendant(id, pid) {
		if (this.entries.has(id)) {
			throw new Error(`process id ${id} already registered`);
		}
		const startTime = procStartTime(pid);
		const processGroup = getpgid(pid);
		const leader = startTime !== null && processGroup === pid;
		const entry = { id, child: null, pid, startTime, command: "descendant", exited: startTime === null, exit: null, descendant: true, leader, done: Promise.resolve(null) };
		this.entries.set(id, entry);
		this.#log({ event: "track-descendant", id, pid, startTime, processGroup, leader });
		return entry;
	}

	async #stopDescendant(entry, graceMs) {
		const alive = () => descendantAlive(entry);
		const groupUp = () => entry.leader && groupAlive(entry.pid);
		if (!alive() && !groupUp()) {
			return { id: entry.id, result: "exited", detail: "the descendant had already exited" };
		}
		// A group leader takes its group with it, also once the leader itself is
		// gone; otherwise only the process itself.
		const target = entry.leader ? -entry.pid : entry.pid;
		for (const [signal, wait] of [["SIGTERM", graceMs], ["SIGKILL", 2000]]) {
			const now = procStartTime(entry.pid);
			if (entry.leader ? now !== null && now !== entry.startTime : now !== entry.startTime) {
				break;
			}
			try {
				process.kill(target, signal);
			} catch {
				// raced with exit
			}
			const deadline = Date.now() + wait;
			while ((alive() || groupUp()) && Date.now() < deadline) {
				await delay(20);
			}
			if (!alive() && !groupUp()) {
				return { id: entry.id, result: signal === "SIGTERM" ? "terminated" : "killed", detail: `${signal} to the detached descendant${target < 0 ? "'s process group" : ""}` };
			}
		}
		return { id: entry.id, result: "failed", detail: "the detached descendant survived SIGKILL" };
	}

	#track(id, child, command, event) {
		const entry = { id, child, pid: child.pid, startTime: null, command, exited: false, exit: null };
		if (child.pid !== undefined) {
			entry.startTime = procStartTime(child.pid);
		}
		entry.done = new Promise((resolve) => {
			child.once("exit", (code, signal) => {
				entry.exited = true;
				entry.exit = { code, signal };
				resolve(entry.exit);
			});
			child.once("error", (error) => {
				entry.exited = true;
				entry.exit = { code: null, signal: null, error: error.code ?? "spawn-error" };
				resolve(entry.exit);
			});
		});
		this.entries.set(id, entry);
		this.#log({ event, id, pid: child.pid ?? null, startTime: entry.startTime, command: command.split("/").pop() });
		return entry;
	}

	/** True while the registered pid is alive and is still the process we started. */
	isOwnedAlive(id) {
		const entry = this.entries.get(id);
		if (!entry || entry.exited || entry.pid === undefined) {
			return false;
		}
		return entry.startTime !== null && procStartTime(entry.pid) === entry.startTime;
	}

	/**
	 * Stops one owned process group: SIGTERM, then SIGKILL after graceMs.
	 * @returns {Promise<{id: string, result: "exited"|"terminated"|"killed"|"not-owned"|"failed", detail: string}>}
	 */
	async stop(id, graceMs = 3000) {
		const entry = this.entries.get(id);
		if (!entry) {
			return { id, result: "not-owned", detail: "no such registry entry" };
		}
		let result;
		if (entry.descendant) {
			result = await this.#stopDescendant(entry, graceMs);
		} else if (entry.exited) {
			// The leader is gone; children in its group may remain.
			if (entry.pid !== undefined && groupAlive(entry.pid)) {
				try {
					process.kill(-entry.pid, "SIGKILL");
				} catch {
					// already gone
				}
				const deadline = Date.now() + graceMs;
				while (groupAlive(entry.pid) && Date.now() < deadline) {
					await delay(20);
				}
				result = groupAlive(entry.pid)
					? {
							id,
							result: "failed",
							detail: `leader had exited; leftover group members survived SIGKILL: ${JSON.stringify(groupMembers(entry.pid))}`,
						}
					: { id, result: "killed", detail: `leader had exited; leftover group members killed${zombieNote(entry.pid)}` };
			} else {
				result = { id, result: "exited", detail: `exited on its own (${JSON.stringify(entry.exit)})` };
			}
		} else if (procStartTime(entry.pid) !== entry.startTime) {
			result = { id, result: "not-owned", detail: "pid no longer belongs to the started process; not signalled" };
		} else {
			try {
				process.kill(-entry.pid, "SIGTERM");
			} catch {
				// raced with exit
			}
			// Wait for the whole group (not just the leader) within the grace period.
			const deadline = Date.now() + graceMs;
			while (groupAlive(entry.pid) && Date.now() < deadline) {
				await delay(20);
			}
			if (!groupAlive(entry.pid)) {
				// Our own leader may be a zombie until libuv reaps it.
				await Promise.race([entry.done, delay(graceMs)]);
				result = { id, result: "terminated", detail: `SIGTERM to its process group${zombieNote(entry.pid)}` };
			} else {
				try {
					process.kill(-entry.pid, "SIGKILL");
				} catch {
					// raced with exit
				}
				await Promise.race([entry.done, delay(2000)]);
				result = { id, result: groupAlive(entry.pid) ? "failed" : "killed", detail: `SIGKILL after ${graceMs} ms grace` };
			}
		}
		this.#log({ event: "stop", ...result });
		return result;
	}

	/** Stops every registered entry in reverse start order. */
	async stopAll(graceMs = 3000) {
		const results = [];
		for (const id of [...this.entries.keys()].reverse()) {
			results.push(await this.stop(id, graceMs));
		}
		return results;
	}

	/** Ids whose owned leader, or a member of its process group, is still alive. */
	survivors() {
		return [...this.entries.values()]
			.filter((entry) => entry.pid !== undefined && (entry.descendant ? descendantAlive(entry) || (entry.leader && groupAlive(entry.pid)) : this.isOwnedAlive(entry.id) || groupAlive(entry.pid)))
			.map((entry) => entry.id);
	}
}

/**
 * Runs a short command to completion with a complete env, a timeout and an
 * output cap. The whole process group is killed on timeout.
 * @returns {Promise<{code: number|null, signal: string|null, stdout: string, stderr: string, timedOut: boolean, error?: string}>}
 */
// Media production (calibration and export) runs many short tools through
// execCapture. Rather than thread one signal through every media function,
// the caller scopes it once: every execCapture started inside
// withCancellation stops its process group when that signal aborts.
const cancellation = new AsyncLocalStorage();

/**
 * Runs fn with signal as the cancellation for every execCapture it starts.
 * @template T
 * @param {AbortSignal} signal
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export function withCancellation(signal, fn) {
	return cancellation.run(signal, fn);
}

/** The surrounding withCancellation signal, for work that is not an execCapture (the card browser). */
export function currentCancellation() {
	return cancellation.getStore();
}

/** Throws a "cancelled" error when the surrounding withCancellation signal has aborted. */
export function throwIfCancelled() {
	if (cancellation.getStore()?.aborted) {
		throw Object.assign(new Error("cancelled"), { code: "cancelled" });
	}
}

export function execCapture(command, args, { env, cwd, timeoutMs = 60000, maxOutputBytes = 8 * 1024 * 1024, input } = {}) {
	const signal = cancellation.getStore();
	if (signal?.aborted) {
		return Promise.resolve({ code: null, signal: null, stdout: "", stderr: "", timedOut: false, cancelled: true, error: "cancelled" });
	}
	return new Promise((resolve) => {
		const child = spawn(command, args, { env, cwd, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"], detached: true });
		const out = [];
		const err = [];
		let size = 0;
		let timedOut = false;
		const take = (list) => (chunk) => {
			size += chunk.length;
			if (size <= maxOutputBytes) {
				list.push(chunk);
			}
		};
		child.stdout.on("data", take(out));
		child.stderr.on("data", take(err));
		if (input !== undefined) {
			child.stdin.on("error", () => {});
			child.stdin.end(input);
		}
		const timer = setTimeout(() => {
			timedOut = true;
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch {
				// gone
			}
		}, timeoutMs);
		let cancelled = false;
		const onAbort = () => {
			cancelled = true;
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch {
				// gone
			}
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		child.once("error", (error) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolve({ code: null, signal: null, stdout: "", stderr: "", timedOut: false, error: error.code ?? "spawn-error" });
		});
		child.once("close", (code, exitSignal) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolve({ code, signal: exitSignal, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), timedOut, ...(cancelled ? { cancelled } : {}) });
		});
	});
}
