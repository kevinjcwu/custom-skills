// Process adapter: runs one approved command attempt under explicit limits.
//
// spawn is called with shell:false, an approved absolute executable, the
// approved argv (shell metacharacters stay literal), a contained cwd, an
// environment built only from approved literals and named pass-through
// variables, and stdin closed. Output is capped per stream; exceeding the
// cap, the timeout or cancellation terminates the process group with
// SIGTERM, then SIGKILL after the grace period.
import { spawn } from "node:child_process";
import process from "node:process";
import { Buffer } from "node:buffer";
import { performance } from "node:perf_hooks";
import { setTimeout, clearTimeout } from "node:timers";

export const PROCESS_DESCRIPTOR = Object.freeze({
	schema: "adapter-descriptor.v1",
	id: "process",
	status: "implemented",
	roles: ["actor"],
	operations: ["run"],
	emits: ["action.start", "action.attempt", "action.end"],
	limits: ["timeoutMs", "maxOutputBytes", "killGraceMs", "retries"],
});

const useProcessGroup = process.platform !== "win32";

/**
 * Builds the child environment: approved literals plus named variables
 * passed through from the parent. Nothing else is inherited.
 * @param {{env: {name: string, value: string}[], envPassthrough: string[]}} command
 * @param {Record<string, string | undefined>} parentEnv
 */
export function buildEnv(command, parentEnv = process.env) {
	const env = Object.create(null);
	for (const name of command.envPassthrough) {
		if (Object.prototype.hasOwnProperty.call(parentEnv, name) && parentEnv[name] !== undefined) {
			env[name] = parentEnv[name];
		}
	}
	for (const item of command.env) {
		env[item.name] = item.value;
	}
	return env;
}

function sendSignal(child, signal) {
	try {
		if (useProcessGroup) {
			process.kill(-child.pid, signal);
		} else {
			child.kill(signal);
		}
		return true;
	} catch {
		return false;
	}
}

/**
 * Runs one attempt.
 * @param {{
 *   executable: string, argv: string[], cwd: string, env: Record<string, string>,
 *   timeoutMs: number, maxOutputBytes: number, killGraceMs: number, signal?: AbortSignal,
 * }} options
 * @returns {Promise<{
 *   outcome: "exited" | "timeout" | "output-limit" | "cancelled" | "spawn-error",
 *   exitCode: number | null, exitSignal: string | null, stdout: Buffer, stderr: Buffer,
 *   outputExceeded: string | null, lateOutputBytes: number, termination: string[],
 *   durationMs: number, error: {code: string, message: string} | null,
 * }>}
 */
export function runProcess(options) {
	const started = performance.now();
	return new Promise((resolve) => {
		const streams = { stdout: [], stderr: [] };
		const sizes = { stdout: 0, stderr: 0 };
		let outcome = null;
		let outputExceeded = null;
		let lateOutputBytes = 0;
		const termination = [];
		let graceTimer = null;
		let settled = false;
		let exitInfo = null;

		if (options.signal?.aborted) {
			resolve({
				outcome: "cancelled",
				exitCode: null,
				exitSignal: null,
				stdout: Buffer.alloc(0),
				stderr: Buffer.alloc(0),
				outputExceeded: null,
				lateOutputBytes: 0,
				termination: [],
				durationMs: 0,
				error: null,
			});
			return;
		}

		let child;
		try {
			child = spawn(options.executable, options.argv, {
				cwd: options.cwd,
				env: options.env,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				detached: useProcessGroup,
				windowsHide: true,
			});
		} catch (error) {
			resolve(spawnFailure(error, started));
			return;
		}

		const finish = () => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timeoutTimer);
			clearTimeout(graceTimer);
			options.signal?.removeEventListener("abort", onAbort);
			resolve({
				outcome: outcome ?? "exited",
				exitCode: exitInfo?.code ?? null,
				exitSignal: exitInfo?.signal ?? null,
				stdout: Buffer.concat(streams.stdout),
				stderr: Buffer.concat(streams.stderr),
				outputExceeded,
				lateOutputBytes,
				termination,
				durationMs: performance.now() - started,
				error: null,
			});
		};

		const terminate = (reason) => {
			if (outcome !== null) {
				return;
			}
			outcome = reason;
			if (exitInfo) {
				return;
			}
			if (sendSignal(child, "SIGTERM")) {
				termination.push("SIGTERM");
			}
			graceTimer = setTimeout(() => {
				if (!exitInfo && sendSignal(child, "SIGKILL")) {
					termination.push("SIGKILL");
				}
			}, options.killGraceMs);
		};

		const onAbort = () => terminate("cancelled");
		options.signal?.addEventListener("abort", onAbort, { once: true });
		const timeoutTimer = setTimeout(() => terminate("timeout"), options.timeoutMs);

		for (const name of ["stdout", "stderr"]) {
			child[name].on("data", (chunk) => {
				if (outcome !== null) {
					lateOutputBytes += chunk.length;
					return;
				}
				const room = options.maxOutputBytes - sizes[name];
				if (chunk.length > room) {
					if (room > 0) {
						streams[name].push(chunk.subarray(0, room));
						sizes[name] += room;
					}
					lateOutputBytes += chunk.length - Math.max(room, 0);
					outputExceeded = name;
					terminate("output-limit");
					return;
				}
				streams[name].push(chunk);
				sizes[name] += chunk.length;
			});
		}

		child.on("error", (error) => {
			if (!child.pid) {
				settled = true;
				clearTimeout(timeoutTimer);
				options.signal?.removeEventListener("abort", onAbort);
				resolve(spawnFailure(error, started));
			}
		});
		child.on("exit", (code, signal) => {
			exitInfo = { code, signal };
			// Reap anything left in the group (for example a grandchild that
			// still holds the pipes) once the direct child has exited.
			if (useProcessGroup && sendSignal(child, "SIGKILL")) {
				termination.push("SIGKILL-group");
			}
		});
		child.on("close", finish);
	});
}

function spawnFailure(error, started) {
	return {
		outcome: "spawn-error",
		exitCode: null,
		exitSignal: null,
		stdout: Buffer.alloc(0),
		stderr: Buffer.alloc(0),
		outputExceeded: null,
		lateOutputBytes: 0,
		termination: [],
		durationMs: performance.now() - started,
		error: { code: String(error.code ?? "spawn-failed").toLowerCase().replace(/[^a-z0-9._-]/g, "-"), message: "the approved executable could not be started" },
	};
}
