// Helper adapter: runs one approved, run-local interaction helper for one
// storyboard action.
//
// The skill ships no interaction helpers. When a target needs an interaction
// the fixed browser vocabulary cannot perform (for example a simulated user
// talking to a voice app), the agent writes a helper for that target, the
// human approves it with the demo plan, and this adapter runs it:
//
// - from an approved executable, with an explicit environment (the
//   authorization's literals and named pass-through variables plus
//   SDP_OUT_DIR; never the whole parent environment), a contained cwd, the
//   action time limit, capped output, cancellation and teardown of its whole
//   process group and of any descendant that left the group;
// - over JSON lines on stdin/stdout. The helper may ask the run to evaluate
//   one of its declared, hash-approved page scripts in this run's recorded
//   page (only with needs browser-page); it never gets a browser endpoint;
// - it ends with one result line: a status and the media files it wrote
//   under SDP_OUT_DIR.
//
// SDP_OUT_DIR is the declared write location, NOT a sandbox: an approved
// helper is a trusted program with the user's filesystem and network access.
// The helper's status is a claim. This adapter only reports "done" when the
// helper said done, exited 0, kept the protocol and every media file is a
// valid, contained, declared PCM WAV inside the action window; the run then
// still requires its own page-text evidence (pageIncludesNew).
import fs from "node:fs";
import path from "node:path";
import { Buffer } from "node:buffer";
import { readWav } from "./audio.mjs";
import { processGroupOf, processTree } from "./browser-adapter.mjs";
import { hasControlCharacter, isInside } from "./paths.mjs";

export const HELPER_LIMITS = Object.freeze({
	maxLineBytes: 64 * 1024,
	maxPageCalls: 64,
	maxPageResultBytes: 64 * 1024,
	maxMediaFiles: 8,
	maxMediaBytes: 16 * 1024 * 1024,
	maxCaptionChars: 300,
	pollMs: 100,
	// Media may end slightly after the action window closes (the last write races the result line).
	windowSlackMs: 250,
});

const STATUS_OUTCOME = Object.freeze({ done: "done", failed: "helper-failed", blocked: "helper-blocked", unknown: "helper-unknown" });

/** Outcomes a helper attempt can end with besides "done". */
export const HELPER_OUTCOMES = Object.freeze(["helper-failed", "helper-blocked", "helper-unknown", "protocol-error", "media-invalid", "helper-escaped", "timeout", "output-limit", "cancelled", "spawn-error"]);

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Checks the media a helper reported. Paths are relative to outDir; each file
 * must be a regular (not symlinked) PCM WAV inside outDir, of a declared role,
 * starting and ending inside the action window.
 *
 * @param {{outDir: string, reported: unknown, interaction: {media: {role: string, label: string, provenance: string}[]}, actionMs: number}} input
 * @returns {{media: {file: string, role: string, label: string, provenance: string, startMs: number, durationMs: number, caption: string|null}[], problems: string[]}}
 */
export function validateHelperMedia({ outDir, reported, interaction, actionMs }) {
	const problems = [];
	const media = [];
	if (reported === undefined) {
		return { media, problems };
	}
	if (!Array.isArray(reported)) {
		return { media, problems: ["media must be an array"] };
	}
	if (reported.length > HELPER_LIMITS.maxMediaFiles) {
		return { media, problems: [`at most ${HELPER_LIMITS.maxMediaFiles} media files may be reported`] };
	}
	const declared = new Map(interaction.media.map((item) => [item.role, item]));
	const outReal = fs.realpathSync(outDir);
	const seen = new Set();
	for (const [index, item] of reported.entries()) {
		const at = `media[${index}]`;
		if (!item || typeof item !== "object" || Array.isArray(item)) {
			problems.push(`${at} must be an object`);
			continue;
		}
		const { file, role, startMs, caption } = item;
		if (typeof file !== "string" || file === "" || path.isAbsolute(file) || hasControlCharacter(file) || file.split(/[\\/]/).includes("..")) {
			problems.push(`${at}.file must be a relative path inside SDP_OUT_DIR`);
			continue;
		}
		if (!declared.has(role)) {
			problems.push(`${at}.role "${String(role).slice(0, 80)}" is not a media role declared for this interaction`);
			continue;
		}
		if (caption !== undefined && (typeof caption !== "string" || caption.length > HELPER_LIMITS.maxCaptionChars || hasControlCharacter(caption))) {
			problems.push(`${at}.caption must be a string of at most ${HELPER_LIMITS.maxCaptionChars} characters without control characters`);
			continue;
		}
		if (!Number.isFinite(startMs) || startMs < 0) {
			problems.push(`${at}.startMs must be a non-negative number of milliseconds after the action started`);
			continue;
		}
		const joined = path.join(outReal, file);
		let stat;
		let real;
		try {
			stat = fs.lstatSync(joined);
			real = fs.realpathSync(joined);
		} catch {
			problems.push(`${at}.file does not exist`);
			continue;
		}
		if (stat.isSymbolicLink() || !stat.isFile() || real !== joined || !isInside(outReal, real)) {
			problems.push(`${at}.file must be a regular file inside SDP_OUT_DIR, not a link`);
			continue;
		}
		if (seen.has(real)) {
			problems.push(`${at}.file is reported twice`);
			continue;
		}
		seen.add(real);
		if (stat.size > HELPER_LIMITS.maxMediaBytes) {
			problems.push(`${at}.file is larger than ${HELPER_LIMITS.maxMediaBytes} bytes`);
			continue;
		}
		let wav;
		try {
			wav = readWav(real);
		} catch (error) {
			problems.push(`${at}.file is not a 16-bit PCM WAV: ${error.message}`);
			continue;
		}
		if (!(wav.sampleRate >= 8000 && wav.sampleRate <= 96000) || wav.samples.length === 0) {
			problems.push(`${at}.file has no audio or an unsupported sample rate`);
			continue;
		}
		const durationMs = (wav.samples.length / wav.sampleRate) * 1000;
		if (startMs + durationMs > actionMs + HELPER_LIMITS.windowSlackMs) {
			problems.push(`${at} (${Math.round(startMs)} ms + ${Math.round(durationMs)} ms) does not fit in the ${Math.round(actionMs)} ms action window`);
			continue;
		}
		const role0 = declared.get(role);
		// Label and provenance come from the approved authorization, never from the helper.
		media.push({ file: real, role, label: role0.label, provenance: role0.provenance, startMs: Math.round(startMs), durationMs: Math.round(durationMs), caption: caption ?? null });
	}
	return { media, problems };
}

/**
 * Runs one helper attempt. Never throws for helper misbehaviour.
 *
 * @param {{registry: import("./proc-registry.mjs").ProcRegistry, id: string, executable: string,
 *   argv: string[], cwd: string, env: Record<string, string>, outDir: string,
 *   interaction: object, pageScripts: Map<string, string>, page: object|null,
 *   action: {id: string, value?: string}, timeoutMs: number, killGraceMs: number,
 *   maxOutputBytes: number, signal?: AbortSignal, now: () => number}} options
 *   env must already be complete (explicit); SDP_OUT_DIR is added here.
 *   pageScripts maps a declared script id to its approved source.
 *   now: milliseconds on the recording clock (for transcript times).
 * @returns {Promise<{outcome: string, error: {code: string, message: string}|null, exitCode: number|null,
 *   exitSignal: string|null, claimed: string|null, detail: string|null, media: object[],
 *   transcript: object[], stderr: Buffer, pageCalls: number, escaped: number[], stops: object[], durationMs: number}>}
 */
export async function runHelper(options) {
	const { registry, id, executable, argv, cwd, env, outDir, interaction, pageScripts, page, action, timeoutMs, killGraceMs, maxOutputBytes, signal, now } = options;
	const startedAt = now();
	const transcript = [];
	const note = (dir, entry) => transcript.push({ t: Math.round(now() - startedAt), dir, ...entry });
	const state = { outcome: null, error: null, result: null, pageCalls: 0, bytes: 0, escaped: new Set(), exit: null };
	const fail = (outcome, code, message) => {
		if (!state.outcome) {
			state.outcome = outcome;
			state.error = { code, message: message.slice(0, 500) };
		}
	};
	const stderr = [];
	const base = { exitCode: null, exitSignal: null, claimed: null, detail: null, media: [], transcript, pageCalls: 0, escaped: [], stops: [] };
	if (signal?.aborted) {
		return { ...base, outcome: "cancelled", error: { code: "cancelled", message: "cancelled before the helper was started" }, stderr: Buffer.alloc(0), durationMs: 0 };
	}
	let entry;
	try {
		entry = registry.spawn(id, executable, argv, { env: { ...env, SDP_OUT_DIR: outDir }, cwd, stdio: ["pipe", "pipe", "pipe"] });
	} catch (error) {
		return { ...base, outcome: "spawn-error", error: { code: "spawn-error", message: `the helper could not be started: ${String(error?.code ?? error?.message ?? "error").slice(0, 200)}` }, stderr: Buffer.alloc(0), durationMs: 0 };
	}
	const child = entry.child;
	const send = (message) => {
		note("to-helper", { message });
		if (child.stdin.writable) {
			child.stdin.write(`${JSON.stringify(message)}\n`);
		}
	};
	child.stdin.on("error", () => {});
	const count = (chunk) => {
		state.bytes += chunk.length;
		if (state.bytes > maxOutputBytes) {
			fail("output-limit", "output-limit", `the helper wrote more than ${maxOutputBytes} bytes`);
			wake();
			return false;
		}
		return true;
	};
	let wake = () => {};
	const changed = () => new Promise((resolve) => {
		wake = resolve;
	});
	child.stderr.on("data", (chunk) => {
		if (count(chunk)) {
			stderr.push(chunk);
		}
	});

	// Page calls run one at a time, in order, inside the helper's deadline.
	let queue = Promise.resolve();
	// Time limits of page calls still pending when the helper ends; cleared so they do not keep the process alive.
	const pageTimers = new Set();
	const deadline = startedAt + timeoutMs;
	const evaluate = async (message) => {
		const reply = (body) => send({ type: "page-result", id: message.id, ...body });
		if (!interaction.needs.includes("browser-page") || !page) {
			reply({ ok: false, error: "this helper was not granted browser-page" });
			return;
		}
		const source = pageScripts.get(message.script);
		if (source === undefined) {
			reply({ ok: false, error: "unknown page script; only declared scripts can be evaluated" });
			return;
		}
		state.pageCalls += 1;
		if (state.pageCalls > HELPER_LIMITS.maxPageCalls) {
			fail("protocol-error", "helper-protocol", `more than ${HELPER_LIMITS.maxPageCalls} page calls in one action`);
			wake();
			return;
		}
		// Reaching the action deadline inside a page call is the action's own
		// time limit, not a page error the helper could turn into another status.
		const reachedDeadline = Symbol("deadline");
		try {
			const evaluation = page.evaluate(`(${source})(${JSON.stringify(message.arg ?? null)})`);
			evaluation.catch(() => {});
			let limit;
			const value = await Promise.race([evaluation, new Promise((resolve) => {
				limit = setTimeout(() => resolve(reachedDeadline), Math.max(0, deadline - now()));
				pageTimers.add(limit);
			})]).finally(() => {
				clearTimeout(limit);
				pageTimers.delete(limit);
			});
			if (value === reachedDeadline) {
				fail("timeout", "timeout", `the helper did not finish within ${timeoutMs} ms: a page script was still running`);
				wake();
				return;
			}
			const encoded = JSON.stringify(value ?? null);
			if (Buffer.byteLength(encoded) > HELPER_LIMITS.maxPageResultBytes) {
				reply({ ok: false, error: `the page script result is larger than ${HELPER_LIMITS.maxPageResultBytes} bytes` });
				return;
			}
			reply({ ok: true, value: value ?? null });
		} catch (error) {
			reply({ ok: false, error: String(error?.message ?? error).split("\n")[0].slice(0, 300) });
		}
	};
	const onMessage = (line) => {
		let message;
		try {
			message = JSON.parse(line);
		} catch {
			note("from-helper", { raw: line.slice(0, 500) });
			fail("protocol-error", "helper-protocol", "the helper wrote a stdout line that is not JSON; stdout is reserved for protocol messages (log to stderr)");
			wake();
			return;
		}
		note("from-helper", { message });
		if (message?.type === "page" && typeof message.id === "string" && typeof message.script === "string") {
			// Decided in line order, when the line is read: a page call the helper
			// sent before its result runs even when both lines arrive in one chunk;
			// one sent after its result is ignored. Only a stop skips queued calls.
			if (!state.result) {
				queue = queue.then(() => (state.outcome ? undefined : evaluate(message)));
			}
			return;
		}
		if (message?.type === "result" && !state.result && Object.prototype.hasOwnProperty.call(STATUS_OUTCOME, message.status)) {
			state.result = message;
			wake();
			return;
		}
		fail("protocol-error", "helper-protocol", state.result ? "the helper sent more than one result" : "unknown or malformed protocol message");
		wake();
	};
	let pending = "";
	child.stdout.on("data", (chunk) => {
		if (!count(chunk)) {
			return;
		}
		pending += chunk.toString("utf8");
		let newline;
		while ((newline = pending.indexOf("\n")) >= 0) {
			const line = pending.slice(0, newline);
			pending = pending.slice(newline + 1);
			if (line.trim() !== "") {
				onMessage(line);
			}
		}
		if (Buffer.byteLength(pending) > HELPER_LIMITS.maxLineBytes) {
			fail("protocol-error", "helper-protocol", `a protocol line is longer than ${HELPER_LIMITS.maxLineBytes} bytes`);
			wake();
		}
	});
	entry.done.then((exit) => {
		state.exit = exit;
		wake();
	});
	const onAbort = () => {
		fail("cancelled", "cancelled", "the run was cancelled or reached its time limit during this helper");
		wake();
	};
	signal?.addEventListener("abort", onAbort, { once: true });
	const timer = setTimeout(() => {
		fail("timeout", "timeout", `the helper did not finish within ${timeoutMs} ms`);
		wake();
	}, Math.max(0, deadline - now()));
	// A descendant that leaves the helper's process group would outlive the
	// group teardown; it is tracked by exact pid identity and stopped.
	const watch = setInterval(() => {
		if (state.exit || child.pid === undefined) {
			return;
		}
		for (const pid of processTree(child.pid)) {
			if (pid !== child.pid && !state.escaped.has(pid) && ![null, child.pid].includes(processGroupOf(pid))) {
				state.escaped.add(pid);
				registry.trackDescendant(`${id}-escaped-${pid}`, pid);
				fail("helper-escaped", "helper-escaped", "a process the helper started left its process group");
				wake();
			}
		}
	}, HELPER_LIMITS.pollMs);

	send({ type: "start", action: { id: action.id, ...(action.value !== undefined ? { value: action.value } : {}) }, deadlineMs: timeoutMs, protocol: "sdp.helper.v1" });
	try {
		// Wait for: a stop condition, or exit after the result (or exit without one).
		while (!state.outcome && !state.exit) {
			await changed();
		}
		if (!state.outcome && state.exit) {
			// Let queued page replies settle so the transcript is complete, but
			// a cancellation or the time limit still ends the wait at once.
			let settled = false;
			queue.then(() => {
				settled = true;
				wake();
			});
			while (!settled && !state.outcome) {
				await changed();
			}
		}
	} finally {
		clearTimeout(timer);
		clearInterval(watch);
		for (const limit of pageTimers) {
			clearTimeout(limit);
		}
		child.stdin.end();
		signal?.removeEventListener("abort", onAbort);
	}
	const stops = [];
	// Stops the helper's group (also leftover members after it exited) and every escapee.
	stops.push(await registry.stop(id, killGraceMs || 1000));
	for (const pid of state.escaped) {
		stops.push(await registry.stop(`${id}-escaped-${pid}`, killGraceMs || 1000));
	}
	const exit = state.exit ?? (await Promise.race([entry.done, delay(2000).then(() => null)]));
	const result = state.result;
	if (!state.outcome) {
		if (exit?.error) {
			fail("spawn-error", "spawn-error", `the helper could not be started (${exit.error})`);
		} else if (!result) {
			fail("protocol-error", "helper-protocol", `the helper exited (${JSON.stringify(exit)}) without a result line`);
		} else if (result.status === "done" && exit?.code !== 0) {
			fail("helper-failed", "helper-exit", `the helper reported done but exited with ${JSON.stringify(exit)}`);
		}
	}
	let media = [];
	if (!state.outcome && result) {
		const checked = validateHelperMedia({ outDir, reported: result.media, interaction, actionMs: now() - startedAt });
		media = checked.media;
		if (checked.problems.length) {
			fail("media-invalid", "helper-media", checked.problems.join("; "));
		} else if (result.status !== "done") {
			const outcome = STATUS_OUTCOME[result.status];
			fail(outcome, outcome, `the helper reported ${result.status}${typeof result.detail === "string" ? `: ${result.detail}` : ""}`);
		}
	}
	return {
		outcome: state.outcome ?? "done",
		error: state.error,
		exitCode: exit?.code ?? null,
		exitSignal: exit?.signal ?? null,
		claimed: result?.status ?? null,
		detail: typeof result?.detail === "string" ? result.detail.slice(0, 500) : null,
		media: state.outcome ? [] : media,
		transcript,
		stderr: Buffer.concat(stderr),
		pageCalls: state.pageCalls,
		escaped: [...state.escaped],
		stops,
		durationMs: Math.round(now() - startedAt),
	};
}
