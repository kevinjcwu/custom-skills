// Structural QA of a finished run directory.
//
// Structural QA re-verifies bytes, contracts, the hash chain and claims. It
// never watches or listens to anything, so it never emits "release": with
// no audiovisual export the verdict is "blocked", and an export would still
// need an independent exact-file review before any release.
import fs from "node:fs";
import path from "node:path";
import { contentSha256 } from "./canonical.mjs";
import { ASSERTABLE_CLASSES, validateContract, validateEventStream } from "./contracts.mjs";
import { SdpError } from "./errors.mjs";
import { readEvents } from "./events.mjs";
import { readJsonFile } from "./io.mjs";
import { verifyManifestFiles } from "./manifest.mjs";
import { buildClaimLedger } from "./claims.mjs";
import { METRIC_PATTERN } from "./discover.mjs";

const METRIC = new RegExp(METRIC_PATTERN, "i");

const LIMITATIONS = [
	"Structural QA checks files, hashes, contracts and claim links; it does not watch video or listen to audio.",
	"Release requires an audiovisual export (`sdp produce`, recorded in its own export manifest) and an independent exact-file watch-and-listen review.",
];

function summarize(errors) {
	const first = errors.slice(0, 3).map((error) => `${error.path}: ${error.message}`);
	return `${errors.length} error(s): ${first.join("; ")}`.slice(0, 4000);
}

/**
 * Runs structural QA and returns the ledger and report without writing.
 * @param {string} runPath Absolute run directory (<runDir>/<runId>).
 */
export function structuralQa(runPath) {
	const manifest = readJsonFile(path.join(runPath, "manifest.json"), "manifest");
	const manifestErrors = validateContract("artifact-manifest", manifest);
	if (manifestErrors.length > 0) {
		throw new SdpError("invalid-contract", "manifest.json is not a valid artifact-manifest.v1", { details: manifestErrors });
	}
	const manifestSha256 = contentSha256(manifest);
	const checks = [{ id: "manifest-contract", status: "pass", detail: "valid artifact-manifest.v1" }];
	const add = (id, status, detail) => checks.push({ id, status, detail });
	checks.push(...verifyManifestFiles(runPath, manifest));

	const byRole = (role) => manifest.artifacts.filter((artifact) => artifact.role === role);
	const readArtifact = (artifact) => readJsonFile(path.join(runPath, ...artifact.path.split("/")), artifact.path);

	let events = [];
	const eventArtifacts = byRole("events");
	if (eventArtifacts.length !== 1) {
		add("events", "fail", "the manifest must list exactly one events artifact");
	} else {
		try {
			events = readEvents(path.join(runPath, ...eventArtifacts[0].path.split("/")));
			const errors = validateEventStream(events, manifest.runId);
			const first = events[0]?.type;
			const last = events.at(-1)?.type;
			if (first !== "run.start" || last !== "run.end") {
				errors.push({ path: "/", message: "events must start with run.start and end with run.end" });
			}
			add("events", errors.length ? "fail" : "pass", errors.length ? summarize(errors) : `${events.length} events; seq consecutive and tMs monotonic`);
		} catch (error) {
			add("events", "fail", error.message);
		}
	}

	let catalog = null;
	let storyboard = null;
	try {
		const [catalogArtifact] = byRole("catalog");
		const [storyboardArtifact] = byRole("storyboard");
		catalog = catalogArtifact ? readArtifact(catalogArtifact) : null;
		storyboard = storyboardArtifact ? readArtifact(storyboardArtifact) : null;
	} catch {
		catalog = null;
		storyboard = null;
	}
	if (!catalog || !storyboard) {
		add("hash-chain", "fail", "the run must contain its catalog and storyboard contracts");
	} else {
		const problems = [];
		if (contentSha256(catalog) !== manifest.catalogSha256) {
			problems.push("catalog hash differs from the manifest");
		}
		if (contentSha256(storyboard) !== manifest.storyboardSha256) {
			problems.push("storyboard hash differs from the manifest");
		}
		const catalogErrors = validateContract("capability-catalog", catalog);
		const storyboardErrors = validateContract("storyboard", storyboard, { catalog });
		if (catalogErrors.length) {
			problems.push(`catalog: ${summarize(catalogErrors)}`);
		}
		if (storyboardErrors.length) {
			problems.push(`storyboard: ${summarize(storyboardErrors)}`);
		}
		const verified = new Map(
			events.filter((event) => event.type === "evidence.verified").map((event) => [event.data.contract, event.data.sha256]),
		);
		if (verified.get("run-authorization") !== manifest.authorizationSha256) {
			problems.push("authorization hash in the events differs from the manifest");
		}
		if (verified.get("target-content") !== manifest.targetContentSha256) {
			problems.push("target content hash in the events differs from the manifest");
		}
		add("hash-chain", problems.length ? "fail" : "pass", problems.length ? problems.join("; ").slice(0, 4000) : "catalog -> storyboard -> authorization -> run hashes agree");
	}

	let ledger = null;
	if (catalog && storyboard && checks.find((check) => check.id === "hash-chain").status === "pass") {
		ledger = buildClaimLedger({ catalog, storyboard, events, manifest, manifestSha256 });
		const ledgerErrors = validateContract("claim-ledger", ledger);
		const narrated = ledger.claims.filter((claim) => claim.narration.length > 0);
		const unsupported = narrated.filter((claim) => claim.verdict !== "supported");
		add(
			"claims",
			ledgerErrors.length || unsupported.length ? "fail" : "pass",
			ledgerErrors.length
				? summarize(ledgerErrors)
				: unsupported.length
					? `narrated claim(s) not supported: ${unsupported.map((claim) => `${claim.id} (${claim.reason})`).join("; ")}`.slice(0, 4000)
					: `${narrated.length} narrated claim(s) supported; ${ledger.claims.length - narrated.length} not narrated`,
		);

		// No adapter records measurements yet, so no claim can evidence a number:
		// any quantitative statement in narration or claim text fails, whatever
		// claim it cites (a supported ordinary claim is not a measurement).
		const metricProblems = [];
		for (const scene of storyboard.scenes) {
			for (const narration of scene.narration) {
				if (METRIC.test(narration.text)) {
					metricProblems.push(narration.id);
				}
			}
		}
		for (const claim of storyboard.claims) {
			if (ASSERTABLE_CLASSES.includes(claim.class) && METRIC.test(claim.text)) {
				metricProblems.push(claim.id);
			}
		}
		add(
			"unevidenced-metrics",
			metricProblems.length ? "fail" : "pass",
			metricProblems.length
				? `quantitative statement without a recorded measurement (no adapter records measurements yet): ${metricProblems.join(", ")}`
				: "no unevidenced quantitative statements in narration or claims",
		);

		const syntheticLeak =
			manifest.subject === "synthetic-fixture" &&
			ledger.claims.some((claim) => claim.verdict === "supported" && claim.evidence.some((item) => item.type === "run-action"));
		add(
			"subject",
			syntheticLeak ? "fail" : "pass",
			manifest.subject === "synthetic-fixture"
				? "synthetic-fixture run: run-action evidence supports no target claim"
				: "target run: run-action evidence may support claims",
		);

		const claimsById = new Map(storyboard.claims.map((claim) => [claim.id, claim]));
		const audienceProblems = [];
		for (const scene of storyboard.scenes) {
			const sceneActions = new Set(scene.actions.map((action) => action.id));
			for (const narration of scene.narration) {
				for (const id of narration.claims) {
					const claim = claimsById.get(id);
					if (claim && ASSERTABLE_CLASSES.includes(claim.class) && claim.demonstratedBy.some((action) => !sceneActions.has(action))) {
						audienceProblems.push(`${narration.id} cites ${id} demonstrated outside scene ${scene.id}`);
					}
				}
			}
		}
		add(
			"audiences",
			audienceProblems.length ? "fail" : "pass",
			audienceProblems.length
				? audienceProblems.join("; ").slice(0, 4000)
				: `every audience's narration is grounded in its own scene's actions (${storyboard.audiences.join(", ")})`,
		);
	}

	add(
		"run-status",
		manifest.status === "completed" ? "pass" : "fail",
		manifest.status === "completed" ? "run completed" : `run ${manifest.status}: ${manifest.failures.map((failure) => failure.code).join(", ")}`,
	);
	const exports = manifest.artifacts.filter((artifact) => artifact.role === "export-video" || artifact.role === "export-audio");
	add(
		"audiovisual-export",
		"blocked",
		exports.length
			? "an export exists but only an independent exact-file watch-and-listen review can release it"
			: "the run holds no export; `sdp produce` makes one from this run, and only an independent exact-file watch-and-listen review can release it",
	);

	const verdict = checks.some((check) => check.status === "fail") ? "fail" : "blocked";
	const report = {
		schema: "qa-report.v1",
		runId: manifest.runId,
		manifestSha256,
		claimLedgerSha256: ledger ? contentSha256(ledger) : "0".repeat(64),
		reviewer: { kind: "structural-tool", id: "sdp-qa" },
		checks,
		verdict,
		limitations: LIMITATIONS,
	};
	const reportErrors = validateContract("qa-report", report, { manifest });
	if (reportErrors.length > 0) {
		throw new SdpError("invalid-contract", "internal error: QA report is invalid", { details: reportErrors });
	}
	return { ledger, report };
}

/** Runs structural QA and writes claim-ledger.json and qa-report.json exclusively. */
export function writeStructuralQa(runPath) {
	const { ledger, report } = structuralQa(runPath);
	for (const name of ["claim-ledger.json", "qa-report.json"]) {
		if (fs.existsSync(path.join(runPath, name))) {
			throw new SdpError("qa-exists", `${name} already exists; QA records are never overwritten`);
		}
	}
	if (ledger) {
		fs.writeFileSync(path.join(runPath, "claim-ledger.json"), `${JSON.stringify(ledger, null, "\t")}\n`, { flag: "wx" });
	}
	fs.writeFileSync(path.join(runPath, "qa-report.json"), `${JSON.stringify(report, null, "\t")}\n`, { flag: "wx" });
	return { ledger, report };
}
