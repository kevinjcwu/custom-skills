// Passive preflight.
//
// Checks contracts, the hash chain, the target content digest and the
// approved bindings using reads and fs.access only. It never spawns a
// process, opens a port, contacts an origin or authenticates. A ready
// verdict means "nothing is known to be missing"; it is not an approval.
import fs from "node:fs";
import { contentSha256, sha256Hex } from "./canonical.mjs";
import { validateContract } from "./contracts.mjs";
import { discover } from "./discover.mjs";
import { resolveContained, isInside } from "./paths.mjs";

export const PREFLIGHT_NOTE = "Availability is not approval: a ready preflight does not authorize a run.";

const ADAPTER_SUPPORT = {
	process: { status: "supported" },
	http: { status: "supported" },
	browser: { status: "supported" },
};

/**
 * Re-reads each cited catalog evidence file inside the target and compares
 * its bytes with the recorded SHA-256. The whole-tree digest alone does not
 * prove that an individual evidence reference names a real, unchanged file.
 * @param {string} targetRoot
 * @param {{id: string, ref: {path: string}, sha256: string}[]} items
 * @returns {{verified: {id: string, sha256: string}[], problems: string[]}}
 */
export function verifyCatalogEvidence(targetRoot, items) {
	const verified = [];
	const problems = [];
	for (const item of items) {
		let bytes = null;
		try {
			const file = resolveContained(targetRoot, item.ref.path);
			const stat = fs.lstatSync(file);
			if (stat.isFile()) {
				bytes = fs.readFileSync(file);
			}
		} catch {
			bytes = null;
		}
		if (bytes === null) {
			problems.push(`${item.id}: cited file is missing or not a regular file inside targetRoot`);
		} else if (sha256Hex(bytes) !== item.sha256) {
			problems.push(`${item.id}: file bytes do not match the recorded SHA-256`);
		} else {
			verified.push({ id: item.id, sha256: item.sha256 });
		}
	}
	return { verified, problems };
}

/** Catalog evidence items cited by storyboard claims, in catalog order. */
export function citedEvidence(catalog, storyboard) {
	const cited = new Set(storyboard.claims.flatMap((claim) => claim.evidence));
	return catalog.evidence.filter((item) => cited.has(item.id));
}

function summarize(errors) {
	const first = errors.slice(0, 3).map((error) => `${error.path}: ${error.message}`);
	return `${errors.length} error(s): ${first.join("; ")}`.slice(0, 4000);
}

function safeHash(value) {
	try {
		return contentSha256(value);
	} catch {
		return "0".repeat(64);
	}
}

/**
 * @param {{catalog: object, storyboard: object, authorization: object,
 *   browserRuntime?: {ok: boolean, reason?: string}}} input
 *   browserRuntime is the caller's passive check of the pinned browser
 *   toolchain; without it browser scenes are blocked.
 * @returns {object} preflight.v1 document
 */
export function preflight({ catalog, storyboard, authorization, browserRuntime }) {
	const checks = [];
	const add = (id, status, detail) => checks.push({ id, status, detail });

	const catalogErrors = validateContract("capability-catalog", catalog);
	add("catalog-contract", catalogErrors.length ? "fail" : "pass", catalogErrors.length ? summarize(catalogErrors) : "valid capability-catalog.v1");
	const storyboardErrors = catalogErrors.length
		? validateContract("storyboard", storyboard)
		: validateContract("storyboard", storyboard, { catalog });
	add("storyboard-contract", storyboardErrors.length ? "fail" : "pass", storyboardErrors.length ? summarize(storyboardErrors) : "valid storyboard.v1 bound to the catalog hash");
	const authorizationErrors = storyboardErrors.length
		? validateContract("run-authorization", authorization)
		: validateContract("run-authorization", authorization, { storyboard });
	add("authorization-contract", authorizationErrors.length ? "fail" : "pass", authorizationErrors.length ? summarize(authorizationErrors) : "valid run-authorization.v1 bound to the storyboard hash");

	const adapters = [];
	if (storyboardErrors.length === 0) {
		for (const scene of storyboard.scenes) {
			let support = ADAPTER_SUPPORT[scene.adapter];
			if (scene.adapter === "browser") {
				if (authorizationErrors.length === 0 && !authorization.browser) {
					support = { status: "blocked", reason: "The authorization approves no browser service for this scene." };
				} else if (!browserRuntime?.ok) {
					support = { status: "blocked", reason: `The pinned browser runtime is not verified: ${browserRuntime?.reason ?? "no runtime check was supplied"}`.slice(0, 4000) };
				}
			}
			adapters.push({ sceneId: scene.id, adapter: scene.adapter, status: support.status, ...(support.reason ? { reason: support.reason } : {}) });
		}
	}

	if (catalogErrors.length === 0 && authorizationErrors.length === 0) {
		const { targetRoot, runDir, executables } = authorization.bindings;
		let targetOk = false;
		try {
			targetOk = fs.statSync(targetRoot).isDirectory();
		} catch {
			targetOk = false;
		}
		add("target-root", targetOk ? "pass" : "blocked", targetOk ? "binding targetRoot is a directory" : "binding targetRoot is missing or not a directory");

		if (targetOk) {
			let digest = null;
			try {
				digest = discover(targetRoot).repo.contentSha256;
			} catch {
				digest = null;
			}
			const same = digest === catalog.repo.contentSha256;
			add("target-content", same ? "pass" : "fail", same ? "target content digest matches the catalog" : "target content changed since the catalog was produced; rediscover and re-approve");

			if (storyboardErrors.length === 0) {
				const cited = citedEvidence(catalog, storyboard);
				const { problems } = verifyCatalogEvidence(targetRoot, cited);
				add(
					"catalog-evidence",
					problems.length ? "fail" : "pass",
					problems.length ? problems.join("; ").slice(0, 4000) : `${cited.length} cited evidence file(s) exist inside targetRoot and match their SHA-256`,
				);
			}

			let cwdProblems = 0;
			for (const command of [...authorization.commands, ...(authorization.browser ? [authorization.browser.service] : []), ...(authorization.interactions ?? [])]) {
				try {
					const cwd = resolveContained(targetRoot, command.cwd, { allowDot: true });
					if (!fs.statSync(cwd).isDirectory()) {
						cwdProblems += 1;
					}
				} catch {
					cwdProblems += 1;
				}
			}
			add("command-cwd", cwdProblems ? "fail" : "pass", cwdProblems ? `${cwdProblems} command, service or helper cwd(s) missing or outside targetRoot` : "every command, service and helper cwd is a directory inside targetRoot");
		}

		let runDirOk = false;
		try {
			runDirOk = fs.statSync(runDir).isDirectory();
			fs.accessSync(runDir, fs.constants.W_OK);
		} catch {
			runDirOk = false;
		}
		add("run-dir", runDirOk ? "pass" : "blocked", runDirOk ? "binding runDir is a writable directory" : "binding runDir is missing, not a directory or not writable");
		let separate = true;
		try {
			const targetReal = fs.realpathSync(targetRoot);
			const runReal = fs.realpathSync(runDir);
			separate = !isInside(targetReal, runReal) && !isInside(runReal, targetReal);
		} catch {
			separate = !isInside(targetRoot, runDir) && !isInside(runDir, targetRoot);
		}
		add("run-dir-separate", separate ? "pass" : "fail", separate ? "runDir and targetRoot do not contain each other" : "runDir and targetRoot must not contain each other");

		const missing = [];
		for (const executable of executables) {
			try {
				if (!fs.statSync(executable.path).isFile()) {
					throw new Error("not a file");
				}
				fs.accessSync(executable.path, fs.constants.X_OK);
			} catch {
				missing.push(executable.id);
			}
		}
		add("executables", missing.length ? "blocked" : "pass", missing.length ? `not an executable file: ${missing.join(", ")}` : `${executables.length} approved executable(s) present; none were started`);
		const requests = authorization.http.requests.length;
		add("network", "pass", `network ${authorization.network}; ${requests} authorized request(s); no origin was contacted by preflight`);
	}

	const ready =
		checks.every((check) => check.status === "pass") &&
		adapters.length > 0 &&
		adapters.every((adapter) => adapter.status === "supported");
	return {
		schema: "preflight.v1",
		catalogSha256: safeHash(catalog),
		storyboardSha256: safeHash(storyboard),
		authorizationSha256: safeHash(authorization),
		checks,
		adapters,
		verdict: ready ? "ready" : "blocked",
		note: PREFLIGHT_NOTE,
	};
}
