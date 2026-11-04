// Claim ledger: resolves every storyboard claim against catalog evidence
// and the run's observed action outcomes.
import { ASSERTABLE_CLASSES } from "./contracts.mjs";

/**
 * @param {{catalog: object, storyboard: object, events: object[], manifest: object, manifestSha256: string}} input
 * @returns {object} claim-ledger.v1 document
 */
export function buildClaimLedger({ catalog, storyboard, events, manifest, manifestSha256 }) {
	const catalogEvidence = new Set(catalog.evidence.map((item) => item.id));
	const recorded = new Map(catalog.evidence.map((item) => [item.id, item.sha256]));
	// Catalog evidence counts only when this run re-read the cited file and
	// its bytes matched the catalog's SHA-256 (an evidence.verified event).
	const verifiedEvidence = new Set(
		events
			.filter(
				(event) =>
					event.type === "evidence.verified" &&
					event.data.contract === "catalog-evidence" &&
					recorded.get(event.data.evidenceId) === event.data.sha256,
			)
			.map((event) => event.data.evidenceId),
	);
	const passedActions = new Set(
		events.filter((event) => event.type === "action.end" && event.disposition === "ok").map((event) => event.actionId),
	);
	const narrationByClaim = new Map();
	for (const scene of storyboard.scenes) {
		for (const narration of scene.narration) {
			for (const claimId of narration.claims) {
				if (!narrationByClaim.has(claimId)) {
					narrationByClaim.set(claimId, []);
				}
				narrationByClaim.get(claimId).push(narration.id);
			}
		}
	}
	const synthetic = manifest.subject === "synthetic-fixture";

	const claims = storyboard.claims.map((claim) => {
		const narration = narrationByClaim.get(claim.id) ?? [];
		if (!ASSERTABLE_CLASSES.includes(claim.class)) {
			return {
				id: claim.id,
				class: claim.class,
				verdict: "not-asserted",
				reason: `class ${claim.class} is never asserted; it may only be presented as an open question or inference`,
				evidence: [],
				narration: [],
			};
		}
		const staticEvidence = claim.evidence.filter((id) => catalogEvidence.has(id) && verifiedEvidence.has(id));
		const demonstrated = claim.demonstratedBy.filter((id) => passedActions.has(id));
		const notDemonstrated = claim.demonstratedBy.filter((id) => !passedActions.has(id));
		const evidence = [
			...staticEvidence.map((ref) => ({ type: "catalog-evidence", ref })),
			...(synthetic ? [] : demonstrated.map((ref) => ({ type: "run-action", ref }))),
		];
		let verdict = "supported";
		let reason;
		if (staticEvidence.length !== claim.evidence.length) {
			const unresolved = claim.evidence.filter((id) => !staticEvidence.includes(id));
			verdict = "unsupported";
			reason = `catalog evidence not verified against the target in this run: ${unresolved.join(", ")}`;
		} else if (notDemonstrated.length > 0) {
			verdict = "unsupported";
			reason = `demonstrating action(s) did not pass in this run: ${notDemonstrated.join(", ")}`;
		} else if (synthetic && claim.demonstratedBy.length > 0) {
			verdict = "unsupported";
			reason = "a synthetic-fixture run demonstrates the toolchain, not the target; run-action evidence cannot support this claim";
		} else if (claim.class === "observed" && demonstrated.length === 0) {
			verdict = "unsupported";
			reason = "observed claims need a passing action in this run";
		} else if (evidence.length === 0) {
			verdict = "unsupported";
			reason = "no evidence";
		} else {
			reason = demonstrated.length
				? `demonstrated by passing action(s) ${demonstrated.join(", ")}${staticEvidence.length ? " and backed by catalog evidence" : ""}`
				: "backed by hashed catalog evidence (static; not exercised in this run)";
		}
		return { id: claim.id, class: claim.class, verdict, reason, evidence, narration };
	});

	return { schema: "claim-ledger.v1", runId: manifest.runId, manifestSha256, claims };
}
