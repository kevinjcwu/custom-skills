// End-to-end dispatcher workflow on both synthetic fixture repos:
// discover -> storyboard -> authorization -> preflight -> confirmed run ->
// manifest -> structural QA, for business and engineering audiences.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { contentSha256 } from "../scripts/lib/canonical.mjs";
import { discover } from "../scripts/lib/discover.mjs";
import { cliApiScenario, copyDir, FIXTURE_REPOS, makeTempDir, runSdp, startFixtureServer, writeJson } from "./helpers.mjs";

async function flow(temp, { targetRoot, runDir, storyboardFor, authorizationFor }) {
	const file = (name) => path.join(temp.dir, name);
	const discovered = await runSdp(["discover", "--root", targetRoot, "--label", path.basename(targetRoot), "--out", file("catalog.json")]);
	assert.equal(discovered.code, 0, discovered.stdout);
	const catalogSha256 = (await runSdp(["hash", file("catalog.json")])).json.sha256;

	const storyboard = storyboardFor(discovered.json);
	assert.equal(storyboard.catalogSha256, catalogSha256);
	writeJson(file("storyboard.json"), storyboard);
	const storyboardCheck = await runSdp(["validate", file("storyboard.json"), "--catalog", file("catalog.json")]);
	assert.equal(storyboardCheck.code, 0, JSON.stringify(storyboardCheck.json.errors));

	const authorization = authorizationFor(storyboardCheck.json.sha256);
	writeJson(file("authorization.json"), authorization);
	const authorizationCheck = await runSdp(["validate", file("authorization.json"), "--storyboard", file("storyboard.json")]);
	assert.equal(authorizationCheck.code, 0, JSON.stringify(authorizationCheck.json.errors));

	const triple = ["--catalog", file("catalog.json"), "--storyboard", file("storyboard.json"), "--authorization", file("authorization.json")];
	const preflight = await runSdp(["preflight", ...triple, "--out", file("preflight.json")]);
	return { triple, preflight, authorizationSha256: authorizationCheck.json.sha256, runDir };
}

async function runAndQa(context) {
	const run = await runSdp(["run", ...context.triple, "--confirm-authorization-sha256", context.authorizationSha256, "--run-id", "demo"]);
	assert.equal(run.code, 0, run.stdout);
	assert.equal(run.json.status, "completed");
	assert.equal(run.json.run, "<binding:runDir>/demo");
	const runPath = path.join(context.runDir, "demo");
	const manifest = await runSdp(["manifest", "--run", runPath]);
	assert.equal(manifest.code, 0, manifest.stdout);
	assert.equal(manifest.json.manifestSha256, run.json.manifestSha256);
	const qa = await runSdp(["qa", "--run", runPath]);
	assert.equal(qa.code, 3, "structural QA without an export is blocked");
	assert.equal(qa.json.verdict, "blocked");
	assert.ok(qa.json.checks.filter((check) => check.id !== "audiovisual-export").every((check) => check.status === "pass"), qa.stdout);
	const ledger = JSON.parse(fs.readFileSync(path.join(runPath, "claim-ledger.json"), "utf8"));
	return { runPath, qa: qa.json, ledger };
}

test("cli-api fixture: process and loopback HTTP scenes for both audiences", async (t) => {
	const temp = makeTempDir();
	t.after(temp.cleanup);
	const { origin } = await startFixtureServer(t);
	const template = cliApiScenario({ dir: temp.dir, discover, origin });
	const context = await flow(temp, {
		targetRoot: template.targetRoot,
		runDir: template.runDir,
		storyboardFor: (catalog) => ({ ...template.storyboard, catalogSha256: contentSha256(catalog) }),
		authorizationFor: (storyboardSha256) => ({ ...template.authorization, storyboardSha256 }),
	});
	assert.equal(context.preflight.code, 0, context.preflight.stdout);
	const { ledger, qa } = await runAndQa(context);
	assert.deepEqual(
		ledger.claims.map((claim) => [claim.id, claim.verdict]),
		[["claim.tally", "supported"], ["claim.tests", "not-asserted"], ["claim.items", "supported"]],
	);
	assert.match(qa.checks.find((check) => check.id === "audiences").detail, /business, engineering/);
});

test("static-web fixture: unauthorized browser scenes are blocked; a process-only storyboard runs", async (t) => {
	const temp = makeTempDir();
	t.after(temp.cleanup);
	const targetRoot = path.join(temp.dir, "static-web");
	const runDir = path.join(temp.dir, "runs");
	copyDir(path.join(FIXTURE_REPOS, "static-web"), targetRoot);
	fs.mkdirSync(runDir);

	const narration = (scene, claim, business, engineering) => [
		{ id: `nar.${scene}.business`, audience: "business", text: business, claims: [claim], caption: { source: "narration-text", provenance: "agent-drafted" } },
		{ id: `nar.${scene}.engineering`, audience: "engineering", text: engineering, claims: [claim], caption: { source: "narration-text", provenance: "agent-drafted" } },
	];
	const checkScene = {
		id: "scene.check",
		title: "The page script is well formed",
		adapter: "process",
		capabilities: ["cap.entry.html-page-recipe-cards"],
		dataProvenance: ["data.synthetic"],
		actions: [{ id: "act.check", op: "run", ref: "cmd.check" }],
		expect: [{ id: "exp.check.exit", action: "act.check", check: "exitCode", value: 0 }],
		narration: narration(
			"check",
			"claim.parses",
			"The recipe page ships a script that loads cleanly.",
			"node --check app.mjs parses the page module without executing it.",
		),
	};
	const browserScene = {
		id: "scene.page",
		title: "Browsing the cards",
		adapter: "browser",
		capabilities: ["cap.entry.html-page-recipe-cards"],
		dataProvenance: ["data.synthetic"],
		actions: [{ id: "act.open", op: "goto", target: "/index.html" }],
		expect: [],
		narration: narration("page", "claim.page", "Recipes appear as cards.", "index.html declares the Recipe Cards page."),
	};
	const storyboardFor = (scenes) => (catalog) => ({
		schema: "storyboard.v1",
		catalogSha256: contentSha256(catalog),
		title: "Recipe cards",
		goal: "Show the recipe page",
		audiences: ["business", "engineering"],
		confidentiality: { onScreen: "synthetic-only", exportAudience: "internal" },
		clarifications: [],
		dataProvenance: [{ id: "data.synthetic", kind: "synthetic", description: "fixture recipes", rightsConfirmed: true }],
		claims: [
			{ id: "claim.parses", text: "The page script parses", class: "observed", evidence: ["ev.app.mjs"], demonstratedBy: ["act.check"], capability: "cap.entry.html-page-recipe-cards" },
			{ id: "claim.page", text: "The project has a Recipe Cards page", class: "fact", evidence: ["ev.index.html"], demonstratedBy: [] },
		],
		scenes,
	});
	const authorizationFor = (storyboardSha256) => ({
		schema: "run-authorization.v1",
		storyboardSha256,
		subject: "target",
		bindings: { targetRoot, runDir, executables: [{ id: "node", path: process.execPath }] },
		commands: [{ id: "cmd.check", executable: "node", argv: ["--check", "app.mjs"], cwd: ".", env: [], envPassthrough: [] }],
		network: "none",
		http: { requests: [] },
		limits: { timeoutMs: 10000, maxOutputBytes: 65536, maxResponseBytes: 65536, maxRequestBytes: 4096, killGraceMs: 500, retries: 0 },
		stopConditions: ["first-failure", "cancellation", "limit-exceeded"],
	});

	const withBrowser = await flow(temp, { targetRoot, runDir, storyboardFor: storyboardFor([checkScene, browserScene]), authorizationFor });
	assert.equal(withBrowser.preflight.code, 3);
	assert.equal(withBrowser.preflight.json.adapters.find((adapter) => adapter.adapter === "browser").status, "blocked");
	const refused = await runSdp(["run", ...withBrowser.triple, "--confirm-authorization-sha256", withBrowser.authorizationSha256]);
	assert.equal(refused.code, 3);
	assert.deepEqual(fs.readdirSync(runDir), []);

	for (const name of ["catalog.json", "storyboard.json", "authorization.json", "preflight.json"]) {
		fs.rmSync(path.join(temp.dir, name));
	}
	const processOnly = await flow(temp, { targetRoot, runDir, storyboardFor: storyboardFor([checkScene]), authorizationFor });
	assert.equal(processOnly.preflight.code, 0, processOnly.preflight.stdout);
	const { ledger } = await runAndQa(processOnly);
	assert.equal(ledger.claims.find((claim) => claim.id === "claim.parses").verdict, "supported");
	assert.equal(fs.existsSync(path.join(targetRoot, "EXECUTED-MARKER")), false, "package scripts are never run");
});
