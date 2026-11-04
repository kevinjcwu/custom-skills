// Controlled run of an approved storyboard.
//
// The caller must pass the canonical SHA-256 of the run authorization as an
// explicit confirmation; the confirmation is what a human approves. An
// approvalRecord inside the authorization is informational and never
// enables a run. Scenes run sequentially; the first failure, a cancellation
// or an exceeded limit stops the run. Every output is written below
// <runDir>/<runId>/, binding values are redacted from stored bytes and
// recorded as transformations, and the manifest is written last.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import { contentSha256, SHA256_PATTERN } from "./canonical.mjs";
import { assertContract } from "./contracts.mjs";
import { blockedError, SdpError, usageError } from "./errors.mjs";
import { EventLog } from "./events.mjs";
import { buildEnv, runProcess } from "./process-adapter.mjs";
import { httpRequest } from "./http-adapter.mjs";
import { buildManifest } from "./manifest.mjs";
import { citedEvidence, preflight, verifyCatalogEvidence } from "./preflight.mjs";
import { discover } from "./discover.mjs";
import { expandBindingNeedles, findLeakInBytes, findLeaks, redactBytes, resolveContained } from "./paths.mjs";
import { BrowserSession, startService, substituteWorkspace } from "./browser-adapter.mjs";
import { ProcRegistry } from "./proc-registry.mjs";
import { runHelper } from "./helper-adapter.mjs";
import { sha256File } from "./toolchain.mjs";

const RUN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const STOP_OUTCOMES = new Map([
	["timeout", "limit-exceeded"],
	["output-limit", "limit-exceeded"],
	["response-limit", "limit-exceeded"],
	["cancelled", "cancellation"],
]);
// Outcomes that are configuration problems: retrying cannot help.
// Helper actions are never replayed at all: a helper may already have
// changed the app's state (see the action loop).
const NO_RETRY = new Set(["spawn-error", "refused", "redirect-blocked", "adapter-error", "service-exited-before-ready", "service-authority-failed", "helper-failed", "helper-blocked", "helper-unknown", "protocol-error", "media-invalid", "helper-escaped"]);
// A helper that says it could not decide or was blocked is reported as blocked, not failed.
const BLOCKED_OUTCOMES = new Set(["refused", "redirect-blocked", "helper-blocked", "helper-unknown"]);

/** Non-overlapping occurrences of needle in text. */
function occurrences(text, needle) {
	let count = 0;
	for (let at = text.indexOf(needle); needle !== "" && at >= 0; at = text.indexOf(needle, at + needle.length)) {
		count += 1;
	}
	return count;
}

/**
 * Records every file the target wrote into the workspace. Binding values in
 * them are replaced in place and recorded as transformations.
 */
function finalizeWorkspace(runPath, workspacePath, needles, roles, transformations) {
	const visit = (dir) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
			const abs = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				visit(abs);
			} else if (entry.isFile()) {
				const rel = path.relative(runPath, abs).split(path.sep).join("/");
				if (roles.has(rel)) {
					// Seeded by the run (an approved helper), not written by the target.
					continue;
				}
				const redacted = redactBytes(fs.readFileSync(abs), needles);
				if (redacted.replacements > 0) {
					fs.writeFileSync(abs, redacted.bytes);
					transformations.push({ artifact: rel, kind: "redact-bindings", count: redacted.replacements, detail: "approved binding values replaced with <binding:id>" });
				}
				roles.set(rel, { role: "workspace-output", producedBy: "target" });
			}
		}
	};
	visit(workspacePath);
}

export function newRunId() {
	const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").toLowerCase();
	return `run-${stamp}-${randomBytes(3).toString("hex")}`;
}

function evaluate(expectation, observed) {
	switch (expectation.check) {
		case "exitCode":
			return { ok: observed.exitCode === expectation.value, actual: observed.exitCode };
		case "stdoutIncludes":
			return { ok: observed.stdout.includes(expectation.value), actual: `${observed.stdout.length} chars` };
		case "stderrIncludes":
			return { ok: observed.stderr.includes(expectation.value), actual: `${observed.stderr.length} chars` };
		case "status":
			return { ok: observed.status === expectation.value, actual: observed.status };
		case "bodyIncludes":
			return { ok: observed.body.includes(expectation.value), actual: `${observed.body.length} chars` };
		case "pageIncludes":
			return { ok: observed.text.includes(expectation.value), actual: `${observed.text.length} chars of page text` };
		case "pageExcludes":
			return { ok: !observed.text.includes(expectation.value), actual: `${observed.text.length} chars of page text` };
		case "pageIncludesNew": {
			// Text that was already on the page before the action (for example an
			// earlier turn's transcript) does not count. This only shows the text
			// is new; it does not show which reply or action produced it.
			const before = occurrences(observed.before ?? "", expectation.value);
			const after = occurrences(observed.text, expectation.value);
			return { ok: after > before, actual: `${before} occurrence(s) before the action, ${after} after` };
		}
		default:
			return { ok: false, actual: null };
	}
}

/**
 * The success criterion every completed attempt must meet in addition to
 * the storyboard's expectations, unless the storyboard states its own
 * exitCode/status expectation: a process must exit 0 and an HTTP response
 * must be 2xx. Without it, an action with no expectations would pass on
 * any outcome.
 */
function implicitCriteria(adapter, expectations, observed) {
	if (adapter === "process" && !expectations.some((item) => item.check === "exitCode")) {
		return [{ expectation: { id: "implicit.exit-zero", check: "exitCode", value: 0 }, ok: observed.exitCode === 0, actual: observed.exitCode }];
	}
	if (adapter === "http" && !expectations.some((item) => item.check === "status")) {
		const ok = Number.isInteger(observed.status) && observed.status >= 200 && observed.status < 300;
		return [{ expectation: { id: "implicit.status-2xx", check: "status", value: "2xx" }, ok, actual: observed.status }];
	}
	if (adapter === "browser") {
		// The page action itself must have completed; page-text checks are additional.
		return [{ expectation: { id: "implicit.browser-action-done", check: "browserAction", value: "done" }, ok: observed.outcome === "done", actual: observed.outcome }];
	}
	return [];
}

/**
 * Executes a run. Contract or confirmation problems throw before anything
 * is created; once the run directory exists, failures are recorded in the
 * manifest instead of thrown.
 * @param {{catalog: object, storyboard: object, authorization: object,
 *   confirmAuthorizationSha256?: string, runId?: string, signal?: AbortSignal,
 *   parentEnv?: Record<string, string|undefined>,
 *   sceneId?: string, attemptLimit?: number,
 *   browserRuntime?: {ok: boolean, reason?: string, paths?: object}}} input
 *   browserRuntime is required for storyboards with browser scenes.
 *   workspaceSeed: approved, hash-checked helper files written into the run
 *   workspace before the first scene ({rel, bytes, sha256}). Page scripts of
 *   interaction helpers are taken from these in-memory bytes, never re-read
 *   from the writable workspace.
 * @returns {Promise<{runId: string, runPath: string, status: string, manifest: object, manifestSha256: string}>}
 */
export async function runDemo(input) {
	const { catalog, storyboard, authorization } = input;
	if (input.confirmAuthorizationSha256 === undefined) {
		throw usageError("run requires --confirm-authorization-sha256 <sha256 of the approved authorization>");
	}
	if (!SHA256_PATTERN.test(input.confirmAuthorizationSha256)) {
		throw usageError("--confirm-authorization-sha256 must be 64 lowercase hex characters");
	}
	assertContract("capability-catalog", catalog, {}, "catalog");
	assertContract("storyboard", storyboard, { catalog }, "storyboard");
	assertContract("run-authorization", authorization, { storyboard }, "authorization");
	const authorizationSha256 = contentSha256(authorization);
	if (input.confirmAuthorizationSha256 !== authorizationSha256) {
		throw new SdpError(
			"confirmation-mismatch",
			"the confirmed SHA-256 does not match this authorization; review and confirm the exact authorization",
		);
	}
	const check = preflight({ catalog, storyboard, authorization, browserRuntime: input.browserRuntime });
	if (check.verdict !== "ready") {
		throw blockedError("preflight-blocked", "preflight is not ready; run `preflight` for details", check);
	}
	if (input.sceneId !== undefined && !storyboard.scenes.some((scene) => scene.id === input.sceneId)) {
		throw usageError(`scene id ${input.sceneId} is not in the approved storyboard`);
	}
	if (input.attemptLimit !== undefined && (!Number.isInteger(input.attemptLimit) || input.attemptLimit < 1 || input.attemptLimit > authorization.limits.retries + 1)) {
		throw usageError("attempt limit must be a positive integer no greater than the approved retry count plus one");
	}
	const runId = input.runId ?? newRunId();
	if (!RUN_ID_PATTERN.test(runId)) {
		throw usageError("run id must match ^[a-z0-9][a-z0-9-]{0,63}$");
	}

	const { targetRoot, runDir } = authorization.bindings;
	const runPath = path.join(fs.realpathSync(runDir), runId);
	try {
		fs.mkdirSync(runPath);
	} catch (error) {
		if (error.code === "EEXIST") {
			throw new SdpError("run-exists", `run id ${runId} already exists; runs are never overwritten`);
		}
		throw new SdpError("run-dir-failed", "cannot create the run directory");
	}

	const needles = expandBindingNeedles([
		{ id: "runPath", value: runPath },
		{ id: "runDir", value: runDir },
		{ id: "targetRoot", value: targetRoot },
		...authorization.bindings.executables.map((item) => ({ id: `executable:${item.id}`, value: item.path })),
	]);
	const roles = new Map();
	const transformations = [];
	const failures = [];
	const cleanup = [];
	const log = new EventLog(runId, path.join(runPath, "events.jsonl"), needles);
	roles.set("events.jsonl", { role: "events", producedBy: "run" });

	const writeArtifact = (rel, bytes, meta) => {
		const redacted = redactBytes(bytes, needles);
		const parts = rel.split("/");
		fs.mkdirSync(path.join(runPath, ...parts.slice(0, -1)), { recursive: true });
		fs.writeFileSync(path.join(runPath, ...parts), redacted.bytes, { flag: "wx" });
		roles.set(rel, meta);
		if (redacted.replacements > 0) {
			transformations.push({
				artifact: rel,
				kind: "redact-bindings",
				count: redacted.replacements,
				detail: "approved binding values replaced with <binding:id>",
			});
		}
		return redacted.bytes;
	};
	const writeJson = (rel, value, role) => writeArtifact(rel, Buffer.from(`${JSON.stringify(value, null, "\t")}\n`), { role, producedBy: "run" });
	// Binary media are never rewritten; a binding value inside them stops the write.
	const writeBinary = (rel, bytes, meta) => {
		const leak = findLeakInBytes(bytes, needles);
		if (leak) {
			throw new SdpError("binding-leak", `${rel} would contain the value of binding ${leak}`);
		}
		const parts = rel.split("/");
		fs.mkdirSync(path.join(runPath, ...parts.slice(0, -1)), { recursive: true });
		fs.writeFileSync(path.join(runPath, ...parts), bytes, { flag: "wx" });
		roles.set(rel, meta);
	};

	const catalogSha256 = contentSha256(catalog);
	const storyboardSha256 = contentSha256(storyboard);
	const targetContentSha256 = discover(targetRoot).repo.contentSha256;
	let status = "completed";
	let stopped = null;

	log.emit({
		producer: "run",
		type: "run.start",
		disposition: "ok",
		data: {
			subject: authorization.subject,
			scenes: input.sceneId ? 1 : storyboard.scenes.length,
			network: authorization.network,
			...(input.sceneId ? { scope: "selected-scene", selectedSceneId: input.sceneId } : {}),
		},
	});
	writeJson("contracts/catalog.json", catalog, "catalog");
	writeJson("contracts/storyboard.json", storyboard, "storyboard");
	writeJson("contracts/authorization.json", authorization, "authorization");
	for (const [contract, sha256] of [
		["capability-catalog", catalogSha256],
		["storyboard", storyboardSha256],
		["run-authorization", authorizationSha256],
		["target-content", targetContentSha256],
	]) {
		log.emit({ producer: "evidence", type: "evidence.verified", disposition: "ok", data: { contract, sha256 } });
	}
	const evidenceCheck = verifyCatalogEvidence(targetRoot, citedEvidence(catalog, storyboard));
	for (const item of evidenceCheck.verified) {
		log.emit({ producer: "evidence", type: "evidence.verified", disposition: "ok", data: { contract: "catalog-evidence", evidenceId: item.id, sha256: item.sha256 } });
	}
	if (evidenceCheck.problems.length > 0) {
		stopped = "first-failure";
		status = "failed";
		failures.push({ code: "evidence-mismatch", message: evidenceCheck.problems.join("; ").slice(0, 2000) });
	}

	const commands = new Map(authorization.commands.map((item) => [item.id, item]));
	const requests = new Map(authorization.http.requests.map((item) => [item.id, item]));
	const executables = new Map(authorization.bindings.executables.map((item) => [item.id, item.path]));
	const allowedOrigins = [...new Set(authorization.http.requests.map((item) => item.origin))];
	const limits = authorization.limits;
	// A browser service writing past maxOutputBytes aborts the run like a
	// cancellation, but is recorded as an output limit, not as the user's stop.
	const overflow = new AbortController();
	const signal = input.signal ? AbortSignal.any([input.signal, overflow.signal]) : overflow.signal;
	const abortOutcome = () => (overflow.signal.aborted && !input.signal?.aborted ? "output-limit" : "cancelled");
	const workspacePath = authorization.workspace ? path.join(runPath, "workspace") : null;
	if (workspacePath) {
		fs.mkdirSync(workspacePath);
		for (const dir of authorization.workspace.dirs) {
			fs.mkdirSync(resolveContained(workspacePath, dir), { recursive: true });
		}
	}
	for (const seed of input.workspaceSeed ?? []) {
		if (!workspacePath) {
			throw new SdpError("helpers-need-workspace", "helper files need an authorization workspace");
		}
		const file = resolveContained(workspacePath, seed.rel);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, seed.bytes, { flag: "wx", mode: 0o600 });
		roles.set(path.relative(runPath, file).split(path.sep).join("/"), { role: "helper", producedBy: "run" });
		log.emit({ producer: "evidence", type: "evidence.verified", disposition: "ok", data: { contract: "helper", path: seed.rel, sha256: seed.sha256 } });
	}
	const seedSources = new Map((input.workspaceSeed ?? []).map((seed) => [seed.rel, seed.bytes.toString("utf8")]));
	const interactions = new Map((authorization.interactions ?? []).map((item) => [item.id, item]));
	// Browser scenes share one owned service and one recorded session,
	// started at the first browser scene and stopped after the last scene.
	// Interaction helpers run in the same registry, so the same teardown and
	// survivor check covers them.
	const browserState = { registry: null, privateDir: null, service: null, session: null, failed: null };
	const openBrowser = async () => {
		if (browserState.session) {
			return browserState.session;
		}
		if (browserState.failed) {
			throw new SdpError("browser-unavailable", browserState.failed);
		}
		const config = authorization.browser;
		browserState.privateDir = path.join(fs.realpathSync(runDir), `.private-${runId}`);
		fs.mkdirSync(browserState.privateDir, { mode: 0o700 });
		browserState.registry = new ProcRegistry();
		const service = await startService({
			registry: browserState.registry,
			id: "service",
			executable: executables.get(config.service.executable),
			argv: substituteWorkspace(config.service.argv, workspacePath),
			cwd: resolveContained(targetRoot, config.service.cwd, { allowDot: true }),
			env: buildEnv(config.service, input.parentEnv ?? process.env),
			readyTimeoutMs: config.service.readyTimeoutMs,
			maxOutputBytes: limits.maxOutputBytes,
			signal,
			onExceeded: () => overflow.abort(),
		});
		browserState.service = service;
		if (service.cancelled) {
			throw new SdpError("cancelled", "cancelled while the service was starting");
		}
		if (!service.ok) {
			const kind = service.error.startsWith("no readiness line within")
				? "service-timeout"
				: service.error.startsWith("the service exited before it was ready")
					? "service-exited-before-ready"
					: "service-authority-failed";
			browserState.failed = `service ${config.service.id} did not become ready: ${service.error}`;
			throw new SdpError(kind, browserState.failed);
		}
		log.emit({ producer: "browser-adapter", type: "evidence.verified", disposition: "ok", data: { contract: "service-readiness", service: config.service.id, origin: service.origin, listenerOwned: true, listenerOwner: service.listenerPid === service.pid ? "started-process" : "child-of-started-process" } });
		try {
			browserState.session = await BrowserSession.open({ paths: input.browserRuntime.paths, dir: browserState.privateDir, registry: browserState.registry, origin: service.origin, settleMs: config.settleMs });
		} catch (error) {
			browserState.failed = `the browser could not be started: ${String(error?.message ?? error).slice(0, 300)}`;
			throw new SdpError("browser-not-started", browserState.failed);
		}
		if (signal?.aborted) {
			// Not marked failed: the run stops on the cancellation itself.
			throw new SdpError("cancelled", "cancelled while the browser was starting");
		}
		const owned = browserState.session.ownership;
		log.emit({ producer: "browser-adapter", type: "evidence.verified", disposition: "ok", data: { contract: "browser-ownership", executableSha256: owned.executableSha256, launchArgs: owned.launchArgs, processGroupLeader: true } });
		return browserState.session;
	};
	const closeBrowser = async () => {
		const { registry, session, service } = browserState;
		if (session) {
			try {
				const closed = await session.close();
				if (closed.video) {
					writeBinary("browser/session.webm", fs.readFileSync(closed.video), { role: "browser-video", producedBy: "browser-adapter" });
				}
				cleanup.push({ item: "browser", result: ["failed", "not-owned"].includes(closed.stopped.result) ? "failed" : closed.stopped.result === "exited" ? "exited" : "terminated", detail: `recording saved; process group: ${closed.stopped.detail}; ${closed.blocked.length} off-origin request(s) blocked` });
			} catch (error) {
				failures.push({ code: "cleanup-failed", message: `the browser did not close cleanly: ${String(error?.message ?? error).slice(0, 300)}` });
				cleanup.push({ item: "browser", result: "failed", detail: "close failed; the process group was stopped by the registry" });
			}
		}
		if (registry) {
			// Detached service descendants found so far are stopped with the
			// registry; the watcher keeps looking while the service shuts down.
			service?.sweep?.();
			const stops = await registry.stopAll(limits.killGraceMs || 1000);
			service?.stopWatching?.();
			const stoppedIds = new Set(stops.map((stop) => stop.id));
			for (const late of service?.escaped?.() ?? []) {
				if (!stoppedIds.has(late.id)) {
					stops.push(await registry.stop(late.id, limits.killGraceMs || 1000));
				}
			}
			for (const stop of stops) {
				if (stop.id === "service") {
					cleanup.push({ item: "service", result: stop.result === "failed" || stop.result === "not-owned" ? "failed" : stop.result === "exited" ? "exited" : "terminated", detail: stop.detail });
				} else if (stop.id.startsWith("service-escaped-")) {
					cleanup.push({ item: `service descendant ${stop.id.slice("service-escaped-".length)}`, result: stop.result === "failed" || stop.result === "not-owned" ? "failed" : stop.result === "exited" ? "exited" : "terminated", detail: `left the service's process group after readiness; ${stop.detail}` });
				}
			}
			const escapedCount = service?.escaped?.().length ?? 0;
			if (escapedCount) {
				failures.push({ code: "service-escaped", message: `the service started ${escapedCount} process(es) that left its process group after readiness; they were tracked by pid and stopped, but the run could not otherwise have stopped them` });
			}
			const survivors = registry.survivors();
			if (survivors.length) {
				failures.push({ code: "cleanup-failed", message: `owned processes survived teardown: ${survivors.join(", ")}` });
			}
		}
		if (service) {
			const output = service.output();
			writeArtifact("services/service.stdout", output.stdout, { role: "service-log", producedBy: "browser-adapter" });
			writeArtifact("services/service.stderr", output.stderr, { role: "service-log", producedBy: "browser-adapter" });
			if (output.exceeded) {
				failures.push({ code: "service-output-limit", message: `the browser service wrote more than ${limits.maxOutputBytes} bytes; its logs are cut at that limit and the run is not accepted` });
				if (status === "completed") {
					status = "failed";
					stopped = "limit-exceeded";
				}
			}
		}
		if (browserState.privateDir) {
			fs.rmSync(browserState.privateDir, { recursive: true, force: true });
			cleanup.push({ item: "browser private directory", result: "removed", detail: "profile, temporary files, raw recording directory and helper output directories removed" });
		}
	};

	const markSkipped = (scene, fromIndex, reason = stopped ?? "not selected by the approved feasibility check") => {
		for (const action of scene.actions.slice(fromIndex)) {
			log.emit({ producer: "run", type: "action.skipped", disposition: "skipped", sceneId: scene.id, actionId: action.id, data: { reason } });
		}
	};

	try {
		for (const scene of storyboard.scenes) {
			if (input.sceneId && scene.id !== input.sceneId) {
				markSkipped(scene, 0);
				continue;
			}
			if (stopped) {
				markSkipped(scene, 0);
				continue;
			}
			log.emit({ producer: "run", type: "scene.start", disposition: "ok", sceneId: scene.id, data: { adapter: scene.adapter } });
			let sceneOk = true;
			for (const [actionIndex, action] of scene.actions.entries()) {
				if (stopped) {
					markSkipped(scene, actionIndex);
					break;
				}
				const producer = `${scene.adapter}-adapter`;
				const expectations = scene.expect.filter((item) => item.action === action.id);
				log.emit({ producer: "run", type: "action.start", disposition: "ok", sceneId: scene.id, actionId: action.id, data: { op: action.op, ref: action.ref } });
				let actionOk = false;
				let lastOutcome = null;
				let lastError = null;
				const maxAttempts = Math.min(limits.retries + 1, input.attemptLimit ?? Infinity);
				for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
					if (signal?.aborted) {
						lastOutcome = abortOutcome();
						break;
					}
					const base = `scenes/${scene.id}/${action.id}.attempt-${attempt}`;
					let observed;
					let attemptData;
					let evidenceRef;
					try {
						if (scene.adapter === "process") {
							const command = commands.get(action.ref);
							const result = await runProcess({
								executable: executables.get(command.executable),
								argv: substituteWorkspace(command.argv, workspacePath),
								cwd: resolveContained(targetRoot, command.cwd, { allowDot: true }),
								env: buildEnv(command, input.parentEnv ?? process.env),
								timeoutMs: limits.timeoutMs,
								maxOutputBytes: limits.maxOutputBytes,
								killGraceMs: limits.killGraceMs,
								signal,
							});
							const stdout = writeArtifact(`${base}.stdout`, result.stdout, { role: "stdout", producedBy: "process-adapter" });
							const stderr = writeArtifact(`${base}.stderr`, result.stderr, { role: "stderr", producedBy: "process-adapter" });
							evidenceRef = `${base}.stdout`;
							observed = { exitCode: result.exitCode, stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8") };
							lastOutcome = result.outcome;
							lastError = result.error;
							attemptData = {
								command: command.id,
								outcome: result.outcome,
								exitCode: result.exitCode,
								exitSignal: result.exitSignal,
								stdoutBytes: result.stdout.length,
								stderrBytes: result.stderr.length,
								outputExceeded: result.outputExceeded,
								lateOutputBytes: result.lateOutputBytes,
								termination: result.termination.join(",") || null,
								durationMs: Math.round(result.durationMs),
							};
							cleanup.push({
								item: `process ${command.id} ${action.id} attempt ${attempt}`,
								result: result.outcome === "spawn-error" ? "failed" : result.termination.length ? "terminated" : "exited",
								detail: result.termination.length ? `signals: ${result.termination.join(", ")}` : "exited on its own; process group checked",
							});
						} else if (scene.adapter === "browser" && action.op === "helper") {
							const session = await openBrowser();
							const interaction = interactions.get(action.ref);
							const pageScripts = new Map();
							const missing = interaction.pageScripts.filter((script) => !seedSources.has(script.file));
							for (const script of interaction.pageScripts) {
								pageScripts.set(script.id, seedSources.get(script.file));
							}
							const before = await session.snapshot();
							const outDir = path.join(browserState.privateDir, "helper-out", `${scene.id}.${action.id}.attempt-${attempt}`);
							fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
							const videoStartMs = Math.round(session.videoNow());
							const result = missing.length
								? { outcome: "refused", error: { code: "helper-script-missing", message: `page script(s) ${missing.map((script) => script.id).join(", ")} are not approved helper files of this run` }, exitCode: null, exitSignal: null, claimed: null, detail: null, media: [], transcript: [], stderr: Buffer.alloc(0), pageCalls: 0, escaped: [], stops: [], durationMs: 0 }
								: await runHelper({
										registry: browserState.registry,
										id: `helper-${action.id}-${attempt}`,
										executable: executables.get(interaction.executable),
										argv: substituteWorkspace(interaction.argv, workspacePath),
										cwd: resolveContained(targetRoot, interaction.cwd, { allowDot: true }),
										env: buildEnv(interaction, input.parentEnv ?? process.env),
										outDir,
										interaction,
										pageScripts,
										page: interaction.needs.includes("browser-page") ? session.page : null,
										action,
										timeoutMs: limits.timeoutMs,
										killGraceMs: limits.killGraceMs,
										maxOutputBytes: limits.maxOutputBytes,
										signal,
										now: () => session.videoNow(),
									});
							const videoEndMs = Math.round(session.videoNow());
							const snap = signal?.aborted ? { text: Buffer.alloc(0), screenshot: null } : await session.snapshot();
							const text = writeArtifact(`${base}.text`, snap.text, { role: "page-text", producedBy: "helper-adapter" });
							if (snap.screenshot) {
								writeBinary(`${base}.png`, snap.screenshot, { role: "screenshot", producedBy: "helper-adapter" });
							}
							writeArtifact(`${base}.helper.jsonl`, Buffer.from(result.transcript.map((line) => `${JSON.stringify(line)}\n`).join("")), { role: "helper-transcript", producedBy: "helper-adapter" });
							writeArtifact(`${base}.helper.stderr`, result.stderr, { role: "stderr", producedBy: "helper-adapter" });
							const media = result.media.map((item, index) => {
								const rel = `${base}.media-${index + 1}.wav`;
								writeBinary(rel, fs.readFileSync(item.file), { role: "helper-media", producedBy: "helper-adapter" });
								return { artifact: rel, role: item.role, label: item.label, provenance: item.provenance, timingSource: "helper-reported", videoStartMs: videoStartMs + item.startMs, durationMs: item.durationMs, caption: item.caption, sha256: sha256File(path.join(runPath, rel)) };
							});
							writeArtifact(
								`${base}.helper.json`,
								Buffer.from(`${JSON.stringify({
									interaction: interaction.id,
									purpose: interaction.purpose,
									outcome: result.outcome,
									claimedStatus: result.claimed,
									detail: result.detail,
									note: "claimedStatus is the helper's own claim. The run accepted the action only if the helper reported done, exited 0, kept the protocol, every media file was valid and the run's own page-text expectations held. Media timing is reported by the helper, not measured by the run; generated media were made by the helper, not by the app.",
									exitCode: result.exitCode,
									exitSignal: result.exitSignal,
									videoStartMs,
									videoEndMs,
									pageCalls: result.pageCalls,
									escapedDescendants: result.escaped.length,
									media,
								}, null, "\t")}\n`),
								{ role: "helper-result", producedBy: "helper-adapter" },
							);
							evidenceRef = `${base}.helper.json`;
							observed = { text: text.toString("utf8"), before: before.text.toString("utf8"), outcome: result.outcome };
							lastOutcome = result.outcome;
							lastError = result.error;
							attemptData = {
								op: "helper",
								interaction: interaction.id,
								outcome: result.outcome,
								claimedStatus: result.claimed,
								exitCode: result.exitCode,
								exitSignal: result.exitSignal,
								videoStartMs,
								videoEndMs,
								pageCalls: result.pageCalls,
								mediaCount: media.length,
								escapedDescendants: result.escaped.length,
								durationMs: result.durationMs,
								textBytes: snap.text.length,
								baselineTextBytes: before.text.length,
							};
							const stopFailed = result.stops.some((stop) => stop.result === "failed" || stop.result === "not-owned");
							cleanup.push({
								item: `helper ${interaction.id} ${action.id} attempt ${attempt}`,
								result: missing.length ? "failed" : stopFailed ? "failed" : result.stops.every((stop) => stop.result === "exited") ? "exited" : "terminated",
								detail: missing.length ? "not started" : `${result.stops.map((stop) => `${stop.id}: ${stop.result}`).join("; ")}; ${result.escaped.length} escaped descendant(s) tracked and stopped`.slice(0, 1000),
							});
						} else if (scene.adapter === "browser") {
							const session = await openBrowser();
							const before = expectations.some((item) => item.check === "pageIncludesNew") ? (await session.snapshot()).text.toString("utf8") : "";
							const result = await session.perform(action, { timeoutMs: limits.timeoutMs, signal });
							const text = writeArtifact(`${base}.text`, result.text, { role: "page-text", producedBy: "browser-adapter" });
							if (result.screenshot) {
								writeBinary(`${base}.png`, result.screenshot, { role: "screenshot", producedBy: "browser-adapter" });
							}
							evidenceRef = `${base}.text`;
							observed = { text: text.toString("utf8"), before, outcome: result.outcome };
							lastOutcome = result.outcome;
							lastError = result.error ?? null;
							attemptData = {
								op: action.op,
								outcome: result.outcome,
								videoStartMs: result.startMs,
								videoEndMs: result.endMs,
								path: result.path,
								textBytes: result.text.length,
								screenshot: result.screenshot ? `${base}.png` : null,
							};
						} else {
							const request = requests.get(action.ref);
							const result = await httpRequest({
								origin: request.origin,
								method: request.method,
								path: request.path,
								headers: request.headers,
								body: request.body,
								network: authorization.network,
								allowedOrigins,
								timeoutMs: limits.timeoutMs,
								maxRequestBytes: limits.maxRequestBytes,
								maxResponseBytes: limits.maxResponseBytes,
								signal,
							});
							const body = writeArtifact(`${base}.body`, result.body, { role: "http-body", producedBy: "http-adapter" });
							evidenceRef = `${base}.body`;
							observed = { status: result.status, body: body.toString("utf8") };
							lastOutcome = result.outcome;
							lastError = result.error;
							attemptData = {
								request: request.id,
								method: request.method,
								path: request.path,
								outcome: result.outcome,
								status: result.status,
								bodyBytes: result.body.length,
								location: result.location,
								durationMs: Math.round(result.durationMs),
							};
							cleanup.push({
								item: `http ${request.id} ${action.id} attempt ${attempt}`,
								result: "closed",
								detail: "request socket closed (agent disabled; no keep-alive)",
							});
						}
					} catch (error) {
						// An adapter exception is recorded like any other failed attempt so
						// the run still reaches its failure, cleanup and manifest records.
						const code = ["cancelled", "service-timeout", "service-exited-before-ready", "service-authority-failed", "browser-not-started"].includes(error?.code)
							? error.code
							: "adapter-error";
						lastOutcome = code === "service-timeout" ? "timeout" : code === "cancelled" ? "cancelled" : code;
						lastError = {
							code,
							message: code === "adapter-error" ? `adapter threw: ${String(error?.name ?? "error").slice(0, 200)}` : String(error.message).slice(0, 2000),
						};
						attemptData = { outcome: lastOutcome };
						observed = null;
						cleanup.push({ item: `${scene.adapter} ${action.ref} ${action.id} attempt ${attempt}`, result: "failed", detail: "the adapter threw before completing; nothing further was started" });
					}
					if (signal?.aborted && lastOutcome !== abortOutcome()) {
						// A result that arrives after cancellation, the run deadline or a
						// service output overflow is never accepted.
						const outcome = abortOutcome();
						lastError = outcome === "output-limit"
							? { code: "output-limit", message: `the browser service wrote more than ${limits.maxOutputBytes} bytes during this attempt (adapter outcome: ${lastOutcome})` }
							: { code: "cancelled", message: `cancelled or past the run time limit when this attempt ended (adapter outcome: ${lastOutcome})` };
						lastOutcome = outcome;
						attemptData = { ...attemptData, outcome };
					}
					const completed = lastOutcome === "exited" || lastOutcome === "response" || lastOutcome === "done";
					const results = completed
						? [
								...implicitCriteria(scene.adapter, expectations, observed),
								...expectations.map((expectation) => ({ expectation, ...evaluate(expectation, observed) })),
							]
						: [];
					const attemptOk = completed && results.every((item) => item.ok);
					log.emit({
						producer,
						type: "action.attempt",
						disposition: attemptOk ? "ok" : lastOutcome === "timeout" ? "timeout" : lastOutcome === "cancelled" ? "cancelled" : BLOCKED_OUTCOMES.has(lastOutcome) ? "blocked" : "failed",
						sceneId: scene.id,
						actionId: action.id,
						attempt,
						evidenceRef,
						data: attemptData,
						...(lastError ? { error: lastError } : {}),
					});
					if (completed) {
						for (const item of results) {
							log.emit({
								producer: "run",
								type: "expect.result",
								disposition: item.ok ? "ok" : "failed",
								sceneId: scene.id,
								actionId: action.id,
								attempt,
								data: { expect: item.expectation.id, check: item.expectation.check, expected: item.expectation.value, actual: item.actual },
							});
						}
					}
					if (attemptOk) {
						actionOk = true;
						break;
					}
					if (STOP_OUTCOMES.has(lastOutcome) || NO_RETRY.has(lastOutcome) || action.op === "helper") {
						break;
					}
				}
				log.emit({
					producer: "run",
					type: "action.end",
					disposition: actionOk ? "ok" : lastOutcome === "cancelled" ? "cancelled" : BLOCKED_OUTCOMES.has(lastOutcome) ? "blocked" : "failed",
					sceneId: scene.id,
					actionId: action.id,
					data: { outcome: lastOutcome },
				});
				if (!actionOk) {
					sceneOk = false;
					stopped = STOP_OUTCOMES.get(lastOutcome) ?? "first-failure";
					status = stopped === "cancellation" ? "cancelled" : "failed";
					failures.push({
						code: stopped === "cancellation" ? "cancelled" : stopped === "limit-exceeded" ? "limit-exceeded" : "action-failed",
						message: `action ${action.id} ended with outcome ${lastOutcome}; the run stopped (${stopped})`,
						sceneId: scene.id,
						actionId: action.id,
					});
				}
			}
			log.emit({ producer: "run", type: "scene.end", disposition: sceneOk ? "ok" : stopped === "cancellation" ? "cancelled" : "failed", sceneId: scene.id, data: {} });
		}

	} catch {
		// Unexpected errors still end in failure, cleanup and manifest records.
		stopped = stopped ?? "first-failure";
		status = status === "cancelled" ? status : "failed";
		failures.push({ code: "internal-error", message: "the run stopped on an unexpected internal error; see events.jsonl for the last recorded step" });
	}

	try {
		await closeBrowser();
	} catch {
		stopped = stopped ?? "first-failure";
		status = status === "cancelled" ? status : "failed";
		failures.push({ code: "cleanup-failed", message: "browser or service teardown raised an unexpected error" });
	}
	if (workspacePath) {
		finalizeWorkspace(runPath, workspacePath, needles, roles, transformations);
	}
	if (failures.length && status === "completed") {
		status = "failed";
		stopped = "first-failure";
	}

	log.emit({ producer: "run", type: "cleanup", disposition: "ok", data: { records: cleanup.length + 1 } });
	log.emit({ producer: "run", type: "run.end", disposition: status === "completed" ? "ok" : status === "cancelled" ? "cancelled" : "failed", data: { status, stopCondition: stopped } });
	log.close();
	cleanup.push({ item: "event log", result: "closed", detail: "events.jsonl closed after run.end" });

	const manifest = buildManifest(runPath, {
		runId,
		subject: authorization.subject,
		status,
		catalogSha256,
		storyboardSha256,
		authorizationSha256,
		targetContentSha256,
		roles,
		transformations,
		failures,
		cleanup,
	});
	const leaks = findLeaks(manifest, needles);
	if (leaks.length > 0) {
		throw new SdpError("binding-leak", "the manifest would contain a binding value", { details: leaks });
	}
	assertContract("artifact-manifest", manifest, { needles }, "manifest");
	fs.writeFileSync(path.join(runPath, "manifest.json"), `${JSON.stringify(manifest, null, "\t")}\n`, { flag: "wx" });
	return { runId, runPath, status, manifest, manifestSha256: contentSha256(manifest) };
}
