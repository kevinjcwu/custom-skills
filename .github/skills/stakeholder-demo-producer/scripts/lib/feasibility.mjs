import { contentSha256, SHA256_PATTERN } from "./canonical.mjs";
import { deriveAuthorization } from "./contracts.mjs";
import { EXIT } from "./errors.mjs";
import { readEvents } from "./events.mjs";
import { preflight } from "./preflight.mjs";
import { loadHelpers } from "./demo-plan.mjs";
import { runDemo } from "./run.mjs";

export const FEASIBILITY_TIMEOUT_MS = 180_000;
export const FEASIBILITY_MAX_ACTIONS = 5;

const BROWSER_OPS = new Set(["goto", "click", "fill", "press", "wait"]);

function response(status, code, message, extra = {}) {
	const exitCode = status === "feasible" ? EXIT.OK : status === "unsupported" || status === "missing-prerequisite" || status === "blocked" ? EXIT.BLOCKED : EXIT.FAILED;
	return { exitCode, status, code, message, ...extra };
}

/** Identifies the first browser scene as the plan's explicitly early, essential check. */
export function assessBrowserScene(plan) {
	const scene = plan.storyboard.scenes.find((item) => item.adapter === "browser");
	if (!scene) {
		return response("unsupported", "unsupported-interaction", "The approved plan has no browser scene. This fast path supports ordinary browser interactions; choose a browser outcome or use the appropriate existing workflow.");
	}
	if (!scene.actions.length || scene.actions.length > FEASIBILITY_MAX_ACTIONS) {
		return response("unsupported", "unsupported-interaction", `The first browser scene has ${scene.actions.length} actions; the early check supports 1-${FEASIBILITY_MAX_ACTIONS} essential actions. Split or simplify the approved browser scene.`);
	}
	const unsupported = scene.actions.find((action) => !BROWSER_OPS.has(action.op));
	if (unsupported) {
		return response("unsupported", "unsupported-interaction", `Essential action ${unsupported.id} uses ${unsupported.op}; the fast path supports only goto, click, fill, press and wait. If a device or microphone interaction is not essential, choose a real browser-only outcome and list it as omitted; otherwise this path cannot demonstrate it.`);
	}
	return { status: "supported", scene };
}

function skippedScenes(plan, selectedSceneId) {
	return plan.storyboard.scenes.filter((scene) => scene.id !== selectedSceneId).map((scene) => scene.id);
}

function failedOutcome(events, result, timedOut, cancelled) {
	const evidence = {
		runId: result.runId,
		runPath: result.runPath,
		manifest: result.manifest,
		manifestSha256: result.manifestSha256,
		cleanup: result.manifest.cleanup,
	};
	if (timedOut) {
		return response("timeout", "timeout", "The early feasibility deadline expired; the run was cancelled and cleaned up.", evidence);
	}
	if (cancelled || result.status === "cancelled") {
		return response("cancelled", "cancelled", "The feasibility run was cancelled and cleaned up.", evidence);
	}
	const attempts = events.filter((event) => event.type === "action.attempt" && event.disposition !== "ok");
	const failure = attempts.at(-1);
	if (failure?.error?.code === "browser-timeout" || failure?.error?.code === "service-timeout") {
		return response("timeout", "timeout", `The essential browser check timed out (${failure.error.code}); the run was cleaned up.`, evidence);
	}
	if (failure?.error?.code === "browser-not-started") {
		return response("missing-prerequisite", "browser-unavailable", "The pinned browser could not start. Verify the approved local runtime and host prerequisites; no alternate browser was substituted.", evidence);
	}
	if (failure?.error?.code === "service-authority-failed") {
		return response("blocked", "service-authority-failed", "The app service did not satisfy the approved loopback ownership/readiness boundary. Do not retry with a broader network or process allowance; inspect the run evidence.", evidence);
	}
	const failedExpectation = events.find((event) => event.type === "expect.result" && event.disposition === "failed");
	if (failedExpectation) {
		return response("product-error", "expected-outcome-not-observed", `The browser action completed, but expected page outcome ${failedExpectation.data.expect} was not observed. Check the app state and approved expectation before revising the story.`, { ...evidence, expectation: failedExpectation.data.expect });
	}
	if (failure?.error?.code === "service-exited-before-ready") {
		return response("product-error", "service-exited-before-ready", "The approved app service exited before it became ready. Inspect its captured service logs and fix the app start command or app error.", evidence);
	}
	return response("run-failed", "run-failed", "The recorded browser check failed for a reason other than an expected product outcome or timeout. Inspect the run events and cleanup record; no successful result is claimed.", evidence);
}

/**
 * Runs the first approved browser scene as one feasibility attempt. The caller
 * has already validated the full demo-plan; its hash remains the human gate.
 */
export async function runFeasibility({ plan, catalog, planDir, confirmedPlanSha256, browserRuntime, signal, runId, deadlineMs }) {
	const planSha256 = contentSha256(plan);
	if (!SHA256_PATTERN.test(confirmedPlanSha256 ?? "") || confirmedPlanSha256 !== planSha256) {
		return response("blocked", "confirmation-mismatch", "The confirmation does not match the exact approved demo plan; review the plan summary and confirm its SHA-256.");
	}

	const assessment = assessBrowserScene(plan);
	if (assessment.status !== "supported") {
		return { ...assessment, exitCode: EXIT.BLOCKED };
	}
	const { scene } = assessment;
	if (!browserRuntime?.ok) {
		return response("missing-prerequisite", "missing-prerequisite", browserRuntime?.reason ?? "The pinned browser runtime is unavailable; verify the approved local runtime before running.");
	}
	const helpers = loadHelpers(plan, planDir);
	if (helpers.reasons.length) {
		return response("blocked", "helpers-not-approved", "An approved helper is missing or differs from its recorded hash.", { details: helpers.reasons });
	}

	const authorization = deriveAuthorization(plan);
	const check = preflight({ catalog, storyboard: plan.storyboard, authorization, browserRuntime });
	if (check.verdict !== "ready") {
		return response("missing-prerequisite", "preflight-blocked", "The approved browser scene is not ready to run. Resolve the listed preflight prerequisite without widening the approved authority.", { preflight: check });
	}

	const budgetMs = Math.min(FEASIBILITY_TIMEOUT_MS, plan.estimate.maxRunSeconds * 1000, deadlineMs ?? FEASIBILITY_TIMEOUT_MS);
	const deadline = new AbortController();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		deadline.abort();
	}, budgetMs);
	timer.unref?.();
	const runSignal = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
	let result;
	try {
		result = await runDemo({
			catalog,
			storyboard: plan.storyboard,
			authorization,
			browserRuntime,
			confirmAuthorizationSha256: contentSha256(authorization),
			runId,
			sceneId: scene.id,
			attemptLimit: 1,
			workspaceSeed: helpers.seed,
			signal: runSignal,
		});
	} finally {
		clearTimeout(timer);
	}

	const events = readEvents(`${result.runPath}/events.jsonl`);
	const actions = events.filter((event) => event.type === "action.end" && event.sceneId === scene.id);
	if (result.status === "completed" && actions.length === scene.actions.length && actions.every((event) => event.disposition === "ok")) {
		return response("feasible", "feasible", "The essential browser scene was recorded and every approved action and expectation passed. This is feasibility evidence only; it is not the final narrated export.", {
			sceneId: scene.id,
			observedActions: actions.map((event) => event.actionId),
			omittedScenes: skippedScenes(plan, scene.id),
			runId: result.runId,
			runPath: result.runPath,
			manifest: result.manifest,
			manifestSha256: result.manifestSha256,
			cleanup: result.manifest.cleanup,
		});
	}
	return failedOutcome(events, result, timedOut, signal?.aborted);
}
