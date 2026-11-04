import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { contentSha256 } from "../scripts/lib/canonical.mjs";
import { validateContract } from "../scripts/lib/contracts.mjs";
import { discover, METRIC_PATTERN } from "../scripts/lib/discover.mjs";
import { buildClaimLedger } from "../scripts/lib/claims.mjs";
import { readEvents } from "../scripts/lib/events.mjs";
import { structuralQa, writeStructuralQa } from "../scripts/lib/qa.mjs";
import { runDemo } from "../scripts/lib/run.mjs";
import { cliApiScenario, clone, makeTempDir, rechain } from "./helpers.mjs";

async function completedRun(t, options = {}) {
	const temp = makeTempDir();
	t.after(temp.cleanup);
	const scenario = cliApiScenario({ dir: temp.dir, discover, ...options });
	const result = await runDemo({ ...scenario, confirmAuthorizationSha256: contentSha256(scenario.authorization), runId: "qa-run" });
	return { scenario, result };
}

const statusOf = (report, id) => report.checks.find((check) => check.id === id)?.status;

test("structural QA of a clean run is blocked on the missing export and never releases", async (t) => {
	const { result } = await completedRun(t);
	const { ledger, report } = writeStructuralQa(result.runPath);
	assert.equal(report.verdict, "blocked");
	assert.equal(report.reviewer.kind, "structural-tool");
	assert.equal(statusOf(report, "audiovisual-export"), "blocked");
	assert.ok(report.checks.filter((check) => check.id !== "audiovisual-export").every((check) => check.status === "pass"), JSON.stringify(report.checks));
	assert.deepEqual(validateContract("claim-ledger", ledger), []);
	assert.deepEqual(validateContract("qa-report", report, { manifest: result.manifest }), []);
	assert.equal(ledger.manifestSha256, result.manifestSha256);
	assert.equal(report.claimLedgerSha256, contentSha256(ledger));

	const byId = Object.fromEntries(ledger.claims.map((claim) => [claim.id, claim]));
	assert.equal(byId["claim.tally"].verdict, "supported");
	assert.deepEqual(byId["claim.tally"].evidence.map((item) => item.type).sort(), ["catalog-evidence", "run-action"]);
	assert.deepEqual(byId["claim.tally"].narration.sort(), ["nar.tally.business", "nar.tally.engineering"]);
	assert.equal(byId["claim.tests"].verdict, "not-asserted");
	assert.deepEqual(byId["claim.tests"].narration, []);

	// QA records are written once and are not artifacts of the run.
	assert.throws(() => writeStructuralQa(result.runPath), (error) => error.code === "qa-exists");
	assert.equal(statusOf(structuralQa(result.runPath).report, "unlisted-files"), "pass");
});

test("a structural-tool report can never carry a release verdict", async (t) => {
	const { result } = await completedRun(t);
	const { report } = structuralQa(result.runPath);
	const forged = clone(report);
	forged.verdict = "release";
	forged.checks = forged.checks.map((check) => ({ ...check, status: "pass" }));
	assert.notDeepEqual(validateContract("qa-report", forged, { manifest: result.manifest }), []);
	forged.verdict = "structural-pass";
	forged.checks[0].status = "fail";
	assert.notDeepEqual(validateContract("qa-report", forged, { manifest: result.manifest }), []);
});

test("tampered, missing or extra run files fail QA", async (t) => {
	const { result } = await completedRun(t);
	const stdout = path.join(result.runPath, "scenes", "scene.tally", "act.tally.attempt-1.stdout");
	fs.writeFileSync(stdout, "3 items: alpha, beta, gamma\n");
	fs.writeFileSync(path.join(result.runPath, "extra.txt"), "not in the manifest\n");
	const { report } = structuralQa(result.runPath);
	assert.equal(report.verdict, "fail");
	assert.equal(statusOf(report, "artifact-hashes"), "fail");
	assert.equal(statusOf(report, "unlisted-files"), "fail");
	assert.match(report.checks.find((check) => check.id === "unlisted-files").detail, /extra\.txt/);
});

test("an edited contract copy breaks the hash chain", async (t) => {
	const { result } = await completedRun(t);
	const file = path.join(result.runPath, "contracts", "storyboard.json");
	const storyboard = JSON.parse(fs.readFileSync(file, "utf8"));
	storyboard.title = "rewritten";
	fs.writeFileSync(file, JSON.stringify(storyboard));
	const { report, ledger } = structuralQa(result.runPath);
	assert.equal(report.verdict, "fail");
	assert.equal(statusOf(report, "hash-chain"), "fail");
	assert.equal(ledger, null, "no claim ledger is built from an unverified chain");
});

test("a synthetic-fixture run cannot support target claims through run actions", async (t) => {
	const { result } = await completedRun(t, { subject: "synthetic-fixture" });
	assert.equal(result.status, "completed");
	const { report, ledger } = structuralQa(result.runPath);
	const tally = ledger.claims.find((claim) => claim.id === "claim.tally");
	assert.equal(tally.verdict, "unsupported");
	assert.match(tally.reason, /synthetic-fixture/);
	assert.ok(tally.evidence.every((item) => item.type !== "run-action"));
	assert.equal(statusOf(report, "claims"), "fail");
	assert.equal(report.verdict, "fail");
});

test("a failed run fails QA and leaves its demonstrated claims unsupported", async (t) => {
	const temp = makeTempDir();
	t.after(temp.cleanup);
	const scenario = cliApiScenario({ dir: temp.dir, discover });
	scenario.storyboard.scenes[0].expect[1].value = "something the CLI never prints";
	rechain(scenario);
	const result = await runDemo({ ...scenario, confirmAuthorizationSha256: contentSha256(scenario.authorization), runId: "failed" });
	assert.equal(result.status, "failed");
	const { report, ledger } = structuralQa(result.runPath);
	assert.equal(report.verdict, "fail");
	assert.equal(statusOf(report, "run-status"), "fail");
	assert.equal(ledger.claims.find((claim) => claim.id === "claim.tally").verdict, "unsupported");
});

test("discovered catalogs forbid unevidenced metrics and absolute quality claims in narration", (t) => {
	const temp = makeTempDir();
	t.after(temp.cleanup);
	const scenario = cliApiScenario({ dir: temp.dir, discover });
	for (const text of ["Counts items in 3 ms.", "A production-ready counter."]) {
		const storyboard = clone(scenario.storyboard);
		storyboard.scenes[0].narration[0].text = text;
		const errors = validateContract("storyboard", storyboard, { catalog: scenario.catalog });
		assert.ok(errors.some((error) => /forbidden/i.test(error.message)), `${text}: ${JSON.stringify(errors)}`);
	}
});

test("catalog evidence supports a claim only when this run verified the cited file", async (t) => {
	const { scenario, result } = await completedRun(t);
	const events = readEvents(path.join(result.runPath, "events.jsonl"));
	const ledgerFor = (list) =>
		buildClaimLedger({ catalog: scenario.catalog, storyboard: scenario.storyboard, events: list, manifest: result.manifest, manifestSha256: "0".repeat(64) });
	const verdict = (ledger) => ledger.claims.find((claim) => claim.id === "claim.tally");
	assert.equal(verdict(ledgerFor(events)).verdict, "supported");
	const unverified = verdict(ledgerFor(events.filter((event) => event.data?.contract !== "catalog-evidence")));
	assert.equal(unverified.verdict, "unsupported");
	assert.match(unverified.reason, /not verified.*ev\.bin-tally\.mjs/);

	// A run against evidence that no longer matches the target never starts.
	const temp = makeTempDir();
	t.after(temp.cleanup);
	const tampered = cliApiScenario({ dir: temp.dir, discover });
	const item = tampered.catalog.evidence.find((entry) => entry.id === "ev.bin-tally.mjs");
	item.ref.path = "does-not-exist.mjs";
	item.sha256 = "0".repeat(64);
	rechain(tampered);
	await assert.rejects(
		runDemo({ ...tampered, confirmAuthorizationSha256: contentSha256(tampered.authorization), runId: "bad-evidence" }),
		{ code: "preflight-blocked" },
	);
	assert.deepEqual(fs.readdirSync(tampered.runDir), []);
});

test("percentages and other unmeasured figures are caught by the default rule and by QA", async (t) => {
	const text = "This reduces costs by 90%.";
	for (const sample of [text, "costs fall 90% overall", "90%"]) {
		assert.match(sample, new RegExp(METRIC_PATTERN, "i"), sample);
	}
	const temp = makeTempDir();
	t.after(temp.cleanup);
	const scenario = cliApiScenario({ dir: temp.dir, discover });
	scenario.storyboard.scenes[0].narration[0].text = text;
	const errors = validateContract("storyboard", scenario.storyboard, { catalog: scenario.catalog });
	assert.ok(errors.some((error) => /forbidden/i.test(error.message)), JSON.stringify(errors));

	// Even with the forbidden-claim rule removed, structural QA fails the metric.
	scenario.catalog.forbiddenClaims = [];
	rechain(scenario);
	const result = await runDemo({ ...scenario, confirmAuthorizationSha256: contentSha256(scenario.authorization), runId: "metric" });
	assert.equal(result.status, "completed");
	const { report } = structuralQa(result.runPath);
	assert.equal(statusOf(report, "unevidenced-metrics"), "fail");
});
