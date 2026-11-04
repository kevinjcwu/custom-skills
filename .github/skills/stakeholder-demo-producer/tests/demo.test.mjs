import assert from "node:assert/strict";
import crypto from "node:crypto";
import { Buffer } from "node:buffer";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { contentSha256 } from "../scripts/lib/canonical.mjs";
import { deriveAuthorization, validateContract } from "../scripts/lib/contracts.mjs";
import { featureCoverage, loadHelpers, planSummary } from "../scripts/lib/demo-plan.mjs";
import { discover } from "../scripts/lib/discover.mjs";
import { requireTools } from "../scripts/lib/toolchain.mjs";
import { panelBody } from "../scripts/lib/produce.mjs";
import { cliApiScenario, demoPlanFrom, helperWebScenario, syntheticInteraction, holdMediaLock, makeTempDir, rechain, runSdp, SKILL_ROOT, startFixtureServer, staticWebScenario, writeJson } from "./helpers.mjs";

const errorsOf = (plan, catalog) => validateContract("demo-plan", plan, { catalog });
const paths = (errors) => errors.map((error) => error.path);

/** Writes plan.json and catalog.json into dir and returns the CLI arguments. */
function planFiles(dir, plan, catalog) {
	const planFile = writeJson(path.join(dir, "plan.json"), plan);
	const catalogFile = writeJson(path.join(dir, "catalog.json"), catalog);
	return { planFile, catalogFile, args: ["--plan", planFile, "--catalog", catalogFile], sha256: contentSha256(plan) };
}

test("a demo plan covers every user-visible feature, requires run evidence for helper actions and derives the run authorization", (t) => {
	const temp = makeTempDir();
	t.after(temp.cleanup);
	const scenario = cliApiScenario({ dir: temp.dir, discover });
	const plan = demoPlanFrom(scenario);
	assert.deepEqual(errorsOf(plan, scenario.catalog), []);
	assert.deepEqual(deriveAuthorization(plan), scenario.authorization, "approving the plan approves exactly this authorization");

	const missing = structuredClone(plan);
	missing.features = missing.features.filter((feature) => feature.capability !== "cap.entry.bin-tally");
	assert.match(errorsOf(missing, scenario.catalog).map((error) => error.message).join("\n"), /user-visible capability "cap.entry.bin-tally".*neither shown nor omitted/);

	const both = structuredClone(plan);
	both.features[0].omitted = { reason: "shown and left out at once" };
	assert.ok(paths(errorsOf(both, scenario.catalog)).includes("/features/0"));

	const wrongScene = structuredClone(plan);
	const binTally = wrongScene.features.find((feature) => feature.capability === "cap.entry.bin-tally");
	delete binTally.omitted;
	binTally.scenes = ["scene.tally"];
	assert.match(errorsOf(wrongScene, scenario.catalog).map((error) => error.message).join("\n"), /does not list capability/);

	const helperScenario = helperWebScenario({ dir: path.join(temp.dir, "helper"), discover });
	const helperPlan = demoPlanFrom(helperScenario, { helpers: helperScenario.planHelpers });
	assert.deepEqual(errorsOf(helperPlan, helperScenario.catalog), []);
	const unconfirmed = structuredClone(helperPlan);
	unconfirmed.storyboard.scenes[0].expect = unconfirmed.storyboard.scenes[0].expect.map((item) => (item.action === "act.helper" ? { ...item, check: "pageIncludes" } : item));
	assert.match(errorsOf(unconfirmed, helperScenario.catalog).map((error) => error.message).join("\n"), /helper action "act.helper" needs a pageIncludesNew expectation/, "a helper's own report never proves the action");
	const undeclared = structuredClone(helperPlan);
	undeclared.helpers = undeclared.helpers.filter((item) => item.file !== "say.js");
	assert.match(errorsOf(undeclared, helperScenario.catalog).map((error) => `${error.path} ${error.message}`).join("\n"), /\/runtime\/interactions\/0\/pageScripts\/0\/file .*not a declared helper/);

	const reserved = structuredClone(plan);
	reserved.runtime.storyboardSha256 = "a".repeat(64);
	assert.ok(paths(errorsOf(reserved, scenario.catalog)).includes("/runtime/storyboardSha256"));

	const badRuntime = structuredClone(plan);
	badRuntime.runtime.commands[0].executable = "python";
	assert.ok(paths(errorsOf(badRuntime, scenario.catalog)).some((at) => at.startsWith("/runtime/commands/0")), "runtime is checked as a run authorization");

	const tamperedCatalog = structuredClone(scenario.catalog);
	tamperedCatalog.capabilities[0].title = "changed";
	assert.ok(paths(errorsOf(plan, tamperedCatalog)).includes("/catalogSha256"));
});

test("a demo plan states cost honestly, bounds the run and keeps architecture cards opt-in", (t) => {
	const temp = makeTempDir();
	t.after(temp.cleanup);
	const scenario = cliApiScenario({ dir: temp.dir, discover });
	const plan = demoPlanFrom(scenario);
	const messages = (changed) => errorsOf(changed, scenario.catalog).map((error) => `${error.path} ${error.message}`).join("\n");

	const cloud = structuredClone(plan);
	cloud.estimate = { cloud: true, amountUsd: null, basis: "a hosted model", maxRunSeconds: 120 };
	assert.match(messages(cloud), /amountUsd a cloud run needs an estimated amount/);
	assert.match(messages(cloud), /externalDestinations a cloud run must declare/);
	cloud.estimate.amountUsd = 2.5;
	cloud.externalDestinations = [{ host: "example-model-host.invalid", purpose: "speech model" }];
	assert.equal(messages(cloud), "");

	const free = structuredClone(plan);
	free.estimate.amountUsd = 3;
	assert.match(messages(free), /must be null or 0 when cloud is false/);

	const short = structuredClone(plan);
	short.estimate.maxRunSeconds = 9;
	assert.notEqual(messages(short), "");
	short.estimate.maxRunSeconds = 10;
	short.runtime.limits.timeoutMs = 11000;
	assert.match(messages(short), /maxRunSeconds must be at least one action's time limit/);

	const diagram = structuredClone(plan);
	diagram.storyboard.scenes[0].diagram = { edges: [], caption: "how it is built" };
	assert.match(messages(diagram), /scenes\/0\/diagram a product demo shows the running app/);

	const helper = structuredClone(plan);
	helper.helpers = [{ id: "helper.server", source: "skill", file: "static-server.mjs", sha256: "a".repeat(64), purpose: "serve the page" }];
	assert.match(messages(helper), /helpers are copied into the run workspace/);

	const undeclared = demoPlanFrom(staticWebScenario({ dir: path.join(temp.dir, "static"), discover }));
	assert.match(errorsOf(undeclared).map((error) => `${error.path} ${error.message}`).join("\n"), /\/runtime\/browser\/service\/argv\/0 .*static-server\.mjs.* not a declared helper/);
});

test("the approval names every outside HTTP destination: an off-machine request must be declared and is shown with its origin", (t) => {
	const temp = makeTempDir();
	t.after(temp.cleanup);
	const scenario = cliApiScenario({ dir: temp.dir, origin: "http://127.0.0.1:9", discover });
	const messages = (plan) => errorsOf(plan, scenario.catalog).map((error) => `${error.path} ${error.message}`).join("\n");
	const summaryOf = (plan) => planSummary(plan, { sha256: "a".repeat(64), catalog: scenario.catalog, planFile: "plan.json" });

	const local = demoPlanFrom(scenario);
	assert.equal(messages(local), "");
	assert.match(summaryOf(local), /send GET http:\/\/127\.0\.0\.1:9\/items/, "the summary shows where a request goes, not only its path");

	// A free plan: no spend, but it still contacts another machine.
	const outside = structuredClone(local);
	outside.runtime.network = "allowlisted-origins";
	outside.runtime.http.requests[0].origin = "https://api.example.test";
	assert.match(messages(outside), /\/runtime\/http\/requests\/0\/origin .*api\.example\.test.*externalDestinations/);

	outside.externalDestinations = [{ host: "api.example.test", purpose: "the public item service" }];
	assert.equal(messages(outside), "");
	const summary = summaryOf(outside);
	assert.match(summary, /send GET https:\/\/api\.example\.test\/items/);
	assert.match(summary, /`api\.example\.test`: the public item service/);
	assert.doesNotMatch(summary, /None expected/);
});

test("a demo plan never carries or passes secrets: apps use the sign-in the human already did", (t) => {
	const temp = makeTempDir();
	t.after(temp.cleanup);
	const cli = cliApiScenario({ dir: path.join(temp.dir, "cli"), discover });
	const helper = helperWebScenario({ dir: path.join(temp.dir, "helper"), discover });
	const messages = (plan, catalog) => errorsOf(plan, catalog).map((error) => `${error.path} ${error.message}`).join("\n");

	const identity = demoPlanFrom(cli);
	identity.runtime.commands[0].envPassthrough = ["HOME", "AZURE_CLIENT_ID", "AZURE_OPENAI_ENDPOINT"];
	assert.equal(messages(identity, cli.catalog), "");

	const passed = demoPlanFrom(cli);
	passed.runtime.commands[0].envPassthrough = ["AZURE_OPENAI_API_KEY"];
	assert.match(messages(passed, cli.catalog), /\/runtime\/commands\/0\/envPassthrough\/0 .*secret/);

	const literal = demoPlanFrom(cli);
	literal.runtime.commands[0].env = [{ name: "DB_PASSWORD", value: "not-a-real-one" }];
	assert.match(messages(literal, cli.catalog), /\/runtime\/commands\/0\/env\/0\/name .*secret/);

	const service = demoPlanFrom(helper, { helpers: helper.planHelpers });
	service.runtime.browser.service.envPassthrough = ["SERVICE_TOKEN"];
	assert.match(messages(service, helper.catalog), /\/runtime\/browser\/service\/envPassthrough\/0 .*secret/);

	const interaction = demoPlanFrom(helper, { helpers: helper.planHelpers });
	interaction.runtime.interactions[0].envPassthrough = ["AZURE_OPENAI_API_KEY"];
	interaction.runtime.interactions[0].env = [{ name: "CLIENT_SECRET", value: "not-a-real-one" }];
	assert.match(messages(interaction, helper.catalog), /\/runtime\/interactions\/0\/envPassthrough\/0 .*secret/);
	assert.match(messages(interaction, helper.catalog), /\/runtime\/interactions\/0\/env\/0\/name .*secret/);
});

test("every demo has the narrator; other audio exists only as approved, provenance-labelled helper media", (t) => {
	const temp = makeTempDir();
	t.after(temp.cleanup);
	const serverBytes = fs.readFileSync(path.join(SKILL_ROOT, "scripts", "helpers", "static-server.mjs"));
	const server = { helpers: [{ id: "helper.static", source: "skill", file: "static-server.mjs", sha256: crypto.createHash("sha256").update(serverBytes).digest("hex"), purpose: "serve the page; the repo has no server of its own" }] };
	for (const [scenario, extra] of [[cliApiScenario({ dir: path.join(temp.dir, "cli"), discover }), {}], [staticWebScenario({ dir: path.join(temp.dir, "web"), discover }), server]]) {
		const plan = demoPlanFrom(scenario, extra);
		assert.deepEqual(plan.voices, { narrator: "Narrator (generated voice)" });
		assert.deepEqual(errorsOf(plan, scenario.catalog), []);
		const summary = planSummary(plan, { sha256: "a".repeat(64), catalog: scenario.catalog, planFile: "plan.json" });
		assert.match(summary, /Narrator \(generated voice\).*explains/);
		assert.match(summary, /No other voices or sounds: only the narrator/);
		if (scenario.storyboard.scenes.some((scene) => scene.adapter === "browser")) {
			assert.match(summary, /A microphone\/device journey is not simulated/);
		} else {
			assert.doesNotMatch(summary, /microphone\/device journey/);
		}
		assert.doesNotMatch(summary, /Demo caller|Run-local interaction helpers/);

		const invented = structuredClone(plan);
		invented.voices.caller = "Demo caller (synthetic voice)";
		invented.voices.app = "App assistant (recorded app audio)";
		const messages = errorsOf(invented, scenario.catalog);
		assert.ok(paths(messages).includes("/voices/caller") && paths(messages).includes("/voices/app"), JSON.stringify(messages));

		const silent = structuredClone(plan);
		silent.storyboard.scenes[0].narration = [];
		assert.match(errorsOf(silent, scenario.catalog).map((error) => error.message).join("\n"), /no narration for declared audience|must have at least 1 items/);

		const unnamed = structuredClone(plan);
		delete unnamed.voices.narrator;
		assert.ok(errorsOf(unnamed, scenario.catalog).length > 0, "the narrator label is required");
	}
	const helper = helperWebScenario({ dir: path.join(temp.dir, "helper"), discover });
	const helperPlan = demoPlanFrom(helper, { helpers: helper.planHelpers });
	const summary = planSummary(helperPlan, { sha256: "a".repeat(64), catalog: helper.catalog, planFile: "plan.json" });
	assert.match(summary, /\*\*Simulated user \(synthetic test tone\)\*\*: made by this demo's run-local helper; it is never the app's own output/);
	assert.match(summary, /Not a sandbox: a helper is a trusted program/);
	assert.match(summary, /A helper's own "done" is a claim/);
	assert.match(summary, /blocked or unknown stops the run as blocked/);
	assert.match(summary, /File `helpers\/synthetic-helper\.mjs` sha256 `[0-9a-f]{64}`/);
	const relabelled = structuredClone(helperPlan);
	relabelled.runtime.interactions[0].media[0].provenance = "app";
	assert.ok(paths(errorsOf(relabelled, helper.catalog)).some((at) => at.startsWith("/runtime/interactions/0/media/0")), "only generated or helper-captured provenance exists");
	const twoLabels = structuredClone(helperPlan);
	twoLabels.runtime.interactions[0].media.push({ ...twoLabels.runtime.interactions[0].media[0], role: "second" });
	assert.ok(paths(errorsOf(twoLabels, helper.catalog)).some((at) => at.startsWith("/runtime/interactions/0/media")), "each media label names one role");
	const asNarrator = structuredClone(helperPlan);
	asNarrator.runtime.interactions[0].media[0].label = asNarrator.voices.narrator;
	assert.ok(paths(errorsOf(asNarrator, helper.catalog)).includes("/runtime/interactions/0/media/0/label"), "helper media is never labelled as the narrator");
});

test("the bundled example demo plans stay valid against their catalogs", () => {
	const read = (example, name) => JSON.parse(fs.readFileSync(path.join(SKILL_ROOT, "examples", example, name), "utf8"));
	for (const example of ["cli"]) {
		assert.deepEqual(errorsOf(read(example, "demo-plan.json"), read(example, "catalog.json")), [], example);
	}
	const cli = read("cli", "demo-plan.json");
	assert.deepEqual(Object.keys(cli.voices), ["narrator"], "the CLI example has the narrator only");
	assert.deepEqual(cli.helpers.map((helper) => helper.source), ["plan-dir"], "its helper was written for that demo");
	assert.deepEqual(loadHelpers(cli, path.join(SKILL_ROOT, "examples", "cli")).reasons, []);
});

test("plan helpers load only from the plan's own helpers folder, never through a linked folder", (t) => {
	const temp = makeTempDir();
	t.after(temp.cleanup);
	const bytes = Buffer.from("console.log('helper');\n");
	const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
	const plan = { helpers: [{ id: "h", file: "h.mjs", source: "plan-dir", sha256 }] };
	const outside = path.join(temp.dir, "outside");
	fs.mkdirSync(outside);
	fs.writeFileSync(path.join(outside, "h.mjs"), bytes);

	const own = path.join(temp.dir, "own");
	fs.mkdirSync(path.join(own, "helpers"), { recursive: true });
	fs.writeFileSync(path.join(own, "helpers", "h.mjs"), bytes);
	assert.deepEqual(loadHelpers(plan, own).reasons, []);

	// Same bytes, but the helpers folder is a link to a directory outside the plan's folder.
	const linked = path.join(temp.dir, "linked");
	fs.mkdirSync(linked);
	fs.symlinkSync(outside, path.join(linked, "helpers"));
	const refused = loadHelpers(plan, linked);
	assert.deepEqual(refused.seed, []);
	assert.match(refused.reasons.join("\n"), /helpers folder is not a real directory/);

	const linkedFile = path.join(temp.dir, "linked-file");
	fs.mkdirSync(path.join(linkedFile, "helpers"), { recursive: true });
	fs.symlinkSync(path.join(outside, "h.mjs"), path.join(linkedFile, "helpers", "h.mjs"));
	assert.match(loadHelpers(plan, linkedFile).reasons.join("\n"), /not a regular file/);
	assert.match(loadHelpers({ helpers: [{ ...plan.helpers[0], file: "../outside/h.mjs" }] }, own).reasons.join("\n"), /not a plain file name/);
});

test("feature coverage reports observed, planned-not-observed and omitted features", (t) => {
	const temp = makeTempDir();
	t.after(temp.cleanup);
	const plan = demoPlanFrom(cliApiScenario({ dir: temp.dir, discover }));
	const ok = [{ type: "action.attempt", actionId: "act.tally", disposition: "ok" }];
	const failed = [{ type: "action.attempt", actionId: "act.tally", disposition: "failed" }];
	const byId = (coverage) => Object.fromEntries(coverage.map((item) => [item.capability, item.status]));
	assert.deepEqual(byId(featureCoverage(plan, ok)), { "cap.entry.cli-candidate-bin-tally.mjs": "observed", "cap.entry.bin-tally": "omitted" });
	assert.equal(byId(featureCoverage(plan, failed))["cap.entry.cli-candidate-bin-tally.mjs"], "planned-not-observed");
});

test("sdp plan prints the plan sha256 and a readable summary to approve", async (t) => {
	const temp = makeTempDir();
	t.after(temp.cleanup);
	const scenario = helperWebScenario({ dir: temp.dir, discover });
	const plan = demoPlanFrom(scenario, { helpers: scenario.planHelpers });
	const files = planFiles(temp.dir, plan, scenario.catalog);
	const out = path.join(temp.dir, "summary.md");
	const result = await runSdp(["plan", ...files.args, "--out", out]);
	assert.equal(result.code, 0, result.stdout);
	assert.equal(result.json.sha256, files.sha256);
	const summary = fs.readFileSync(out, "utf8");
	for (const text of ['run helper int.synthetic', "Simulated user (synthetic test tone)", "Not a sandbox", "not network-sandboxed", "No paid services", `--confirm-plan-sha256 ${files.sha256}`]) {
		assert.ok(summary.includes(text), `summary mentions ${text}`);
	}
	assert.equal((await runSdp(["plan", ...files.args, "--out", out])).code, 1, "an existing summary is never overwritten");

	const invalid = structuredClone(plan);
	invalid.features = [];
	const bad = planFiles(fs.mkdtempSync(path.join(temp.dir, "bad-")), invalid, scenario.catalog);
	const rejected = await runSdp(["plan", ...bad.args]);
	assert.equal(rejected.code, 1);
	assert.equal(rejected.json.valid, false);
});

test("sdp demo is blocked before anything runs without the exact approval, spend bound or approved helpers", async (t) => {
	const temp = makeTempDir();
	t.after(temp.cleanup);
	const scenario = staticWebScenario({ dir: temp.dir, discover });
	const helperBytes = fs.readFileSync(path.join(SKILL_ROOT, "scripts", "helpers", "static-server.mjs"));
	const helper = { id: "helper.static", source: "skill", file: "static-server.mjs", sha256: crypto.createHash("sha256").update(helperBytes).digest("hex"), purpose: "serve the page; the repo has no server of its own" };
	const blockedCode = async (plan, extra = [], label) => {
		const dir = fs.mkdtempSync(path.join(temp.dir, "case-"));
		const files = planFiles(dir, plan, scenario.catalog);
		const result = await runSdp(["demo", ...files.args, "--confirm-plan-sha256", files.sha256, ...extra]);
		assert.equal(result.code, 3, `${label}: ${result.stdout}`);
		return result.json.error.code;
	};

	const plan = demoPlanFrom(scenario, { helpers: [helper] });
	const files = planFiles(fs.mkdtempSync(path.join(temp.dir, "sha-")), plan, scenario.catalog);
	const mismatch = await runSdp(["demo", ...files.args, "--confirm-plan-sha256", "f".repeat(64)]);
	assert.equal(mismatch.code, 3);
	assert.equal(mismatch.json.error.code, "confirmation-mismatch");

	// Approving the plan approves its estimate; --max-spend-usd is only an extra limit the human may choose.
	const cloud = demoPlanFrom(scenario, {
		helpers: [{ ...helper, sha256: "0".repeat(64) }],
		externalDestinations: [{ host: "example-model-host.invalid", purpose: "speech model" }],
		estimate: { cloud: true, amountUsd: 4, basis: "one short session", maxRunSeconds: 120 },
	});
	assert.equal(await blockedCode(cloud, [], "no spend limit is needed"), "helpers-not-approved", "an approved paid plan is not stopped for lack of a spend flag");
	assert.equal(await blockedCode(cloud, ["--max-spend-usd", "3.99"], "own limit below the estimate"), "estimate-over-limit");
	assert.equal((await runSdp(["demo", ...files.args, "--confirm-plan-sha256", files.sha256, "--max-spend-usd", "lots"])).code, 2);

	const changed = demoPlanFrom(scenario, { helpers: [{ ...helper, sha256: "0".repeat(64) }] });
	assert.equal(await blockedCode(changed, [], "changed helper"), "helpers-not-approved");
	const missing = demoPlanFrom(scenario, { helpers: [{ ...helper, source: "plan-dir" }] });
	assert.equal(await blockedCode(missing, [], "missing helper"), "helpers-not-approved");
	assert.deepEqual(fs.readdirSync(scenario.runDir), [], "no run was started");
});

const NEEDS_EXPORT_TOOLS = requireTools(["ffmpeg", "ffprobe", "python", "voiceModel"]).ok ? false : "toolchain not installed (run `sdp setup install`)";

/** Runs `sdp demo` on a plan and returns the parsed report. */
async function demo(dir, scenario, plan, extra = [], options = {}) {
	const files = planFiles(dir, plan, scenario.catalog);
	const result = await runSdp(["demo", ...files.args, "--confirm-plan-sha256", files.sha256, ...extra], options);
	assert.ok(result.json, `demo printed JSON: ${result.stdout}\n${result.stderr.slice(-3000)}`);
	return result;
}

/** A narrator-only export: narration present, no other audio, export-only check. */
function assertNarratorOnly(json) {
	const calibration = JSON.parse(fs.readFileSync(json.calibration, "utf8"));
	assert.equal(calibration.scope, "export-only");
	assert.equal(calibration.route, undefined);
	const runManifest = JSON.parse(fs.readFileSync(path.join(json.runPath, "manifest.json"), "utf8"));
	assert.ok(!runManifest.cleanup.some((item) => /audio daemon|helper/.test(item.item)), JSON.stringify(runManifest.cleanup));
	for (const exported of json.exports) {
		const manifest = JSON.parse(fs.readFileSync(exported.exportManifest, "utf8"));
		assert.equal(manifest.checks.find((check) => check.id === "narration-audible")?.status, "pass");
		assert.equal(manifest.interactionClips, undefined);
		const vtt = fs.readFileSync(exported.files.find((file) => file.role === "captions").path, "utf8");
		assert.match(vtt, /<v Narrator/);
		assert.doesNotMatch(vtt, /Demo caller|App assistant/);
	}
}

test("sdp demo runs an approved run-local helper on the recorded page and exports its media as a labelled interaction clip", { skip: NEEDS_EXPORT_TOOLS }, async (t) => {
	await holdMediaLock(t);
	const temp = makeTempDir();
	t.after(temp.cleanup);
	const scenario = helperWebScenario({ dir: temp.dir, discover });
	const plan = demoPlanFrom(scenario, { helpers: scenario.planHelpers });
	const { code, json, stderr } = await demo(temp.dir, scenario, plan);
	assert.equal(code, 0, `${JSON.stringify(json, null, 1)}\n${stderr.slice(-3000)}`);
	assert.equal(json.verdict, "ready-for-human-review");
	const page = json.coverage.find((item) => item.capability === "cap.entry.html-page-recipe-cards");
	assert.equal(page.status, "observed");
	assert.match(page.basis, /helper reported done.*does not prove the app's reply belonged to the helper's action/);

	const runManifest = JSON.parse(fs.readFileSync(path.join(json.runPath, "manifest.json"), "utf8"));
	const result = runManifest.artifacts.find((artifact) => artifact.role === "helper-result");
	const record = JSON.parse(fs.readFileSync(path.join(json.runPath, result.path), "utf8"));
	assert.equal(record.outcome, "done");
	assert.equal(record.claimedStatus, "done");
	assert.match(record.note, /claimedStatus is the helper's own claim/);
	assert.equal(record.media.length, 1);
	const [media] = record.media;
	assert.deepEqual([media.role, media.label, media.provenance, media.timingSource], ["simulated-user", "Simulated user (synthetic test tone)", "generated", "helper-reported"]);
	assert.ok(runManifest.artifacts.some((artifact) => artifact.path === media.artifact && artifact.role === "helper-media" && artifact.sha256 === media.sha256));
	assert.ok(runManifest.artifacts.some((artifact) => artifact.role === "helper-transcript"));
	assert.ok(runManifest.cleanup.some((item) => item.item.startsWith("helper int.synthetic act.helper") && item.result !== "failed"), JSON.stringify(runManifest.cleanup));
	assert.ok(!fs.readdirSync(json.runPath, { recursive: true }).map(String).some((rel) => rel.includes("helper-out")), "the helper's SDP_OUT_DIR is private and removed; only checked copies are kept");
	const events = fs.readFileSync(path.join(json.runPath, "events.jsonl"), "utf8");
	assert.doesNotMatch(events + JSON.stringify(record), /ws:\/\/|devtools\/browser/, "no browser endpoint is recorded or handed out");

	const [exported] = json.exports;
	const manifest = JSON.parse(fs.readFileSync(exported.exportManifest, "utf8"));
	assert.ok(manifest.segments.some((segment) => segment.kind === "interaction-clip"), JSON.stringify(manifest.segments));
	const checks = Object.fromEntries(manifest.checks.map((check) => [check.id, check.status]));
	for (const id of ["narration-audible", "narration-media-separated", "helper-media-audible", "silence-outside-narration", "captions"]) {
		assert.equal(checks[id], "pass", id);
	}
	assert.equal(manifest.interactionClips.length, 1);
	const vtt = fs.readFileSync(exported.files.find((file) => file.role === "captions").path, "utf8");
	assert.ok(vtt.includes("<v Simulated user (synthetic test tone)>Hello there (synthetic test tone) (generated by the run-local helper, not the app)"), vtt);
	assert.ok(manifest.limitations.some((text) => /helper/.test(text)), JSON.stringify(manifest.limitations));
});

test("a silent helper media file fails the audibility check even when an overlapping file is audible", { skip: NEEDS_EXPORT_TOOLS }, async (t) => {
	await holdMediaLock(t);
	const temp = makeTempDir();
	t.after(temp.cleanup);
	const declared = syntheticInteraction("overlap").media;
	const scenario = helperWebScenario({ dir: temp.dir, discover, mode: "overlap", interaction: { media: [...declared, { role: "second-user", label: "Second user (synthetic, silent)", provenance: "generated" }] } });
	const plan = demoPlanFrom(scenario, { helpers: scenario.planHelpers });
	const { json, stderr } = await demo(temp.dir, scenario, plan);
	assert.equal(json.verdict, "export-failed", `${JSON.stringify(json, null, 1)}\n${stderr.slice(-3000)}`);
	const [exported] = json.exports;
	const manifest = JSON.parse(fs.readFileSync(exported.exportManifest, "utf8"));
	assert.equal(manifest.interactionClips[0].media.length, 2, "both files were placed over the same span");
	const audible = manifest.checks.find((check) => check.id === "helper-media-audible");
	assert.equal(audible.status, "fail");
	assert.match(audible.detail, /second-user \S+media-2\.wav at \d+ ms: own file 0\.00, export 1\.00/, "the mix alone reads as audible; the file on its own is silent");
	assert.doesNotMatch(audible.detail, /simulated-user/, "the audible file still passes on its own");
});

test("a detached worker the service starts after readiness is tracked, stopped and reported", { skip: NEEDS_EXPORT_TOOLS }, async (t) => {
	await holdMediaLock(t);
	const temp = makeTempDir();
	t.after(temp.cleanup);
	const scenario = staticWebScenario({ dir: temp.dir, discover });
	// A wrapper with no cooperative cleanup: it relays the server's ready line,
	// then starts a detached worker that only pid tracking can stop.
	const wrapper = `import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
const server = spawn(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), "static-server.mjs")], { stdio: ["ignore", "pipe", "inherit"] });
let text = "";
server.stdout.on("data", (chunk) => {
	text += chunk;
	if (!text.includes("\\n")) return;
	const doc = JSON.parse(text.split("\\n")[0]);
	delete doc.pid;
	process.stdout.write(JSON.stringify(doc) + "\\n");
	server.stdout.removeAllListeners("data");
	server.stdout.resume();
	setTimeout(() => spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", detached: true }).unref(), 200);
});
setInterval(() => {}, 1000);
`;
	fs.mkdirSync(path.join(temp.dir, "helpers"), { recursive: true });
	fs.writeFileSync(path.join(temp.dir, "helpers", "late-wrapper.mjs"), wrapper);
	scenario.authorization.browser.service.argv = ["{workspace}/helpers/late-wrapper.mjs"];
	rechain(scenario);
	const sha = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
	const helpers = [
		{ id: "helper.static", source: "skill", file: "static-server.mjs", sha256: sha(path.join(SKILL_ROOT, "scripts", "helpers", "static-server.mjs")), purpose: "serve the page" },
		{ id: "helper.wrapper", source: "plan-dir", file: "late-wrapper.mjs", sha256: sha(path.join(temp.dir, "helpers", "late-wrapper.mjs")), purpose: "TEST wrapper that detaches a worker after readiness" },
	];
	const { json, stderr } = await demo(temp.dir, scenario, demoPlanFrom(scenario, { helpers }));
	assert.equal(json.verdict, "run-failed", `${JSON.stringify(json, null, 1)}\n${stderr.slice(-3000)}`);
	const runManifest = JSON.parse(fs.readFileSync(path.join(json.runPath, "manifest.json"), "utf8"));
	assert.ok(runManifest.failures.some((failure) => failure.code === "service-escaped"), JSON.stringify(runManifest.failures));
	assert.ok(!runManifest.failures.some((failure) => failure.code === "cleanup-failed"), JSON.stringify(runManifest.failures));
	const late = runManifest.cleanup.filter((item) => item.item.startsWith("service descendant "));
	assert.ok(late.length >= 1, JSON.stringify(runManifest.cleanup));
	for (const item of late) {
		assert.match(item.result, /terminated|exited/, JSON.stringify(item));
		const pid = Number(item.item.split(" ").at(-1));
		assert.ok(!fs.existsSync(`/proc/${pid}`) || /^\S+ \(.*\) [ZX] /.test(fs.readFileSync(`/proc/${pid}/stat`, "utf8")), `pid ${pid} still running`);
	}
});

test("a helper's claim is not evidence: stale page text, false success and blocked or unknown reports never pass", { skip: NEEDS_EXPORT_TOOLS }, async (t) => {
	await holdMediaLock(t);
	const temp = makeTempDir();
	t.after(temp.cleanup);
	const attempt = (json) =>
		fs
			.readFileSync(path.join(json.runPath, "events.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line))
			.find((event) => event.type === "action.attempt" && event.actionId === "act.helper");
	// "Lemon rice" is already on the page before the helper runs: a helper claiming done must not be credited with it.
	const cases = [
		["false-done", "Lemon rice", "failed", "done"],
		["false-done", "Helper line: hello", "failed", "done"],
		["blocked", "Helper line: hello", "blocked", "helper-blocked"],
		["unknown", "Helper line: hello", "blocked", "helper-unknown"],
	];
	for (const [index, [mode, expectNew, disposition, outcome]] of cases.entries()) {
		const dir = path.join(temp.dir, `case-${index}`);
		const scenario = helperWebScenario({ dir, discover, mode, expectNew });
		const { code, json } = await demo(dir, scenario, demoPlanFrom(scenario, { helpers: scenario.planHelpers }));
		assert.equal(code, 1, `${mode}: ${JSON.stringify(json)}`);
		assert.equal(json.verdict, "run-failed", mode);
		assert.deepEqual(json.exports, [], mode);
		const event = attempt(json);
		assert.equal(event.disposition, disposition, `${mode} ${expectNew}: ${JSON.stringify(event)}`);
		assert.equal(event.data.outcome, outcome, mode);
		assert.ok(json.coverage.every((item) => item.status !== "observed"), JSON.stringify(json.coverage));
	}
});

test("sdp demo serves a static page with the bundled helper, narrated, without running the repo's scripts or any microphone", { skip: NEEDS_EXPORT_TOOLS }, async (t) => {
	await holdMediaLock(t);
	const temp = makeTempDir();
	t.after(temp.cleanup);
	const scenario = staticWebScenario({ dir: temp.dir, discover });
	const bytes = fs.readFileSync(path.join(SKILL_ROOT, "scripts", "helpers", "static-server.mjs"));
	const plan = demoPlanFrom(scenario, { helpers: [{ id: "helper.static", source: "skill", file: "static-server.mjs", sha256: crypto.createHash("sha256").update(bytes).digest("hex"), purpose: "serve the page; the repo has no server of its own" }] });
	const { code, json, stderr } = await demo(temp.dir, scenario, plan);
	assert.equal(code, 0, `${JSON.stringify(json, null, 1)}\n${stderr.slice(-3000)}`);
	assert.equal(json.exports[0].verdict, "structural-pass");
	assert.equal(fs.existsSync(path.join(scenario.targetRoot, "EXECUTED-MARKER")), false, "no package script ran");
	const manifest = JSON.parse(fs.readFileSync(path.join(json.runPath, "manifest.json"), "utf8"));
	assert.ok(manifest.artifacts.some((artifact) => artifact.path === "workspace/helpers/static-server.mjs" && artifact.role === "helper" && artifact.sha256 === plan.helpers[0].sha256));
	assertNarratorOnly(json);
});

test("sdp demo exports an HTTP scene as a narrated recorded request/response panel", { skip: NEEDS_EXPORT_TOOLS }, async (t) => {
	await holdMediaLock(t);
	const temp = makeTempDir();
	t.after(temp.cleanup);
	const { origin } = await startFixtureServer(t);
	const scenario = cliApiScenario({ dir: temp.dir, discover, origin });
	assert.ok(scenario.storyboard.scenes.some((scene) => scene.adapter === "http"));
	const { code, json, stderr } = await demo(temp.dir, scenario, demoPlanFrom(scenario));
	assert.equal(code, 0, `${JSON.stringify(json, null, 1)}\n${stderr.slice(-3000)}`);
	assert.ok(json.exports.length > 0 && json.exports.every((item) => item.verdict === "structural-pass"), JSON.stringify(json.exports));
	for (const exported of json.exports) {
		const manifest = JSON.parse(fs.readFileSync(exported.exportManifest, "utf8"));
		assert.ok(manifest.segments.some((segment) => segment.sceneId === "scene.items" && segment.kind === "recorded-output-panel"), JSON.stringify(manifest.segments));
	}
	const events = fs.readFileSync(path.join(json.runPath, "events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
	const html = panelBody({ runPath: json.runPath, scene: scenario.storyboard.scenes.find((scene) => scene.id === "scene.items"), authorization: scenario.authorization, events });
	assert.match(html, /GET \/items/);
	assert.match(html, /\[HTTP 200\]/);
	assert.match(html, /alpha/);
	assert.doesNotMatch(html, /accept|application\/json"/i, "request headers are not shown");
	assertNarratorOnly(json);
});

test("sdp demo exports narrated process scenes for both audiences, uses a run-local helper and lists left-out features", { skip: NEEDS_EXPORT_TOOLS }, async (t) => {
	await holdMediaLock(t);
	const temp = makeTempDir();
	t.after(temp.cleanup);
	const scenario = cliApiScenario({ dir: temp.dir, discover });
	// A missing capability (the repo has no sample data) met by a helper written for this demo only:
	// it sits next to the plan, is copied into the run workspace, and never joins the skill's bundled helpers.
	const helperSource = "console.log('sample items ready: alpha, beta (synthetic)');\n";
	fs.mkdirSync(path.join(temp.dir, "helpers"));
	fs.writeFileSync(path.join(temp.dir, "helpers", "seed-items.mjs"), helperSource);
	scenario.authorization.commands.unshift({ id: "cmd.seed", executable: "node", argv: ["{workspace}/helpers/seed-items.mjs"], cwd: ".", env: [], envPassthrough: [] });
	scenario.authorization.workspace = { dirs: [] };
	const scene = scenario.storyboard.scenes[0];
	scene.actions.unshift({ id: "act.seed", op: "run", ref: "cmd.seed" });
	scene.expect.push({ id: "exp.seed.out", action: "act.seed", check: "stdoutIncludes", value: "sample items ready" });
	scenario.authorization.storyboardSha256 = contentSha256(scenario.storyboard);
	const helper = { id: "helper.seed", source: "plan-dir", file: "seed-items.mjs", sha256: crypto.createHash("sha256").update(helperSource).digest("hex"), purpose: "print the synthetic sample items for this demo; the repo ships no sample data" };
	const { code, json, stderr } = await demo(temp.dir, scenario, demoPlanFrom(scenario, { helpers: [helper] }));
	assert.equal(code, 0, `${JSON.stringify(json, null, 1)}\n${stderr.slice(-3000)}`);
	assert.deepEqual(json.exports.map((item) => [item.audience, item.verdict]), [["business", "structural-pass"], ["engineering", "structural-pass"]]);
	assert.deepEqual(json.coverage.find((item) => item.capability === "cap.entry.bin-tally"), { capability: "cap.entry.bin-tally", status: "omitted", reason: "not part of this short demo" });
	const manifest = JSON.parse(fs.readFileSync(path.join(json.runPath, "manifest.json"), "utf8"));
	assert.ok(manifest.artifacts.some((artifact) => artifact.path === "workspace/helpers/seed-items.mjs" && artifact.role === "helper" && artifact.sha256 === helper.sha256));
	assert.equal(fs.existsSync(path.join(SKILL_ROOT, "scripts", "helpers", "seed-items.mjs")), false, "a run-local helper is not added to the bundled helpers");
	assert.equal(fs.existsSync(path.join(scenario.targetRoot, "helpers")), false, "nor written into the target repo");
	assertNarratorOnly(json);
});

test("sdp demo stops the whole run at the plan's time limit and cleans up", { skip: NEEDS_EXPORT_TOOLS }, async (t) => {
	await holdMediaLock(t);
	const temp = makeTempDir();
	t.after(temp.cleanup);
	const scenario = cliApiScenario({ dir: temp.dir, discover });
	const sleep = (id) => ({ id, executable: "node", argv: ["-e", "setTimeout(() => console.log('items: alpha, beta'), 7000)"], cwd: ".", env: [], envPassthrough: [] });
	scenario.authorization.commands = [sleep("cmd.tally"), sleep("cmd.again")];
	scenario.authorization.limits.timeoutMs = 10000;
	const scene = scenario.storyboard.scenes[0];
	scene.actions.push({ id: "act.again", op: "run", ref: "cmd.again" });
	scenario.authorization.storyboardSha256 = contentSha256(scenario.storyboard);
	const plan = demoPlanFrom(scenario, { estimate: { cloud: false, amountUsd: null, basis: "local only", maxRunSeconds: 10 } });
	const started = Date.now();
	const { code, json } = await demo(temp.dir, scenario, plan);
	const elapsed = Date.now() - started;
	assert.equal(code, 1, JSON.stringify(json));
	assert.equal(json.verdict, "run-failed");
	assert.notEqual(json.status, "completed");
	assert.ok(elapsed < 14000, `stopped by the 10 s run limit, not the 2 x 7 s actions (${elapsed} ms)`);
	assert.deepEqual(json.exports, []);
});

test("sdp demo cancels in-flight browser work at the run time limit: service start-up and page actions", { skip: NEEDS_EXPORT_TOOLS }, async (t) => {
	await holdMediaLock(t);
	const temp = makeTempDir();
	t.after(temp.cleanup);
	const serverBytes = fs.readFileSync(path.join(SKILL_ROOT, "scripts", "helpers", "static-server.mjs"));
	const helpers = [{ id: "helper.static", source: "skill", file: "static-server.mjs", sha256: crypto.createHash("sha256").update(serverBytes).digest("hex"), purpose: "serve the page; the repo has no server of its own" }];
	const limit = { estimate: { cloud: false, amountUsd: null, basis: "local only", maxRunSeconds: 10 } };
	const attemptOutcomes = (json) =>
		fs
			.readFileSync(path.join(json.runPath, "events.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line))
			.filter((event) => event.type === "action.attempt")
			.map((event) => [event.actionId, event.data.outcome]);

	// 1. A service that never announces readiness: its own 60 s readiness wait must not outlive the 10 s run.
	const silent = staticWebScenario({ dir: path.join(temp.dir, "silent"), discover });
	silent.authorization.limits.timeoutMs = 10000;
	silent.authorization.browser.service = { ...silent.authorization.browser.service, argv: ["-e", "setInterval(() => {}, 1000)"], readyTimeoutMs: 60000 };
	let started = Date.now();
	let { code, json } = await demo(path.join(temp.dir, "silent"), silent, demoPlanFrom(silent, limit));
	assert.equal(code, 1, JSON.stringify(json));
	assert.equal(json.status, "cancelled", JSON.stringify(json.failures));
	assert.ok(Date.now() - started < 20000, `the readiness wait ended at the run limit (${Date.now() - started} ms)`);
	assert.deepEqual(attemptOutcomes(json), [["act.open", "cancelled"]]);
	assert.deepEqual(json.exports, []);

	// 2. A page wait still running at the deadline ends as cancelled, not as a late timeout or success.
	const waiting = staticWebScenario({ dir: path.join(temp.dir, "waiting"), discover });
	waiting.authorization.limits.timeoutMs = 10000;
	waiting.storyboard.scenes[0].actions.push({ id: "act.never", op: "wait", target: "Text this page never shows" });
	waiting.authorization.storyboardSha256 = contentSha256(waiting.storyboard);
	started = Date.now();
	({ code, json } = await demo(path.join(temp.dir, "waiting"), waiting, demoPlanFrom(waiting, { ...limit, helpers })));
	assert.equal(code, 1, JSON.stringify(json));
	assert.equal(json.status, "cancelled", JSON.stringify(json.failures));
	assert.deepEqual(attemptOutcomes(json), [["act.open", "done"], ["act.never", "cancelled"]]);
	const manifest = JSON.parse(fs.readFileSync(path.join(json.runPath, "manifest.json"), "utf8"));
	assert.ok(manifest.cleanup.some((item) => item.item === "browser" && item.result !== "failed"), JSON.stringify(manifest.cleanup));
	assert.deepEqual(json.exports, []);
});

/** Declares a test-written service in the plan directory as an approved plan-dir helper. */
function planDirService(dir, scenario, file, source, purpose) {
	fs.mkdirSync(path.join(dir, "helpers"), { recursive: true });
	fs.writeFileSync(path.join(dir, "helpers", file), source);
	scenario.authorization.browser.service.argv = [`{workspace}/helpers/${file}`];
	rechain(scenario);
	return [{ id: "helper.service", source: "plan-dir", file, sha256: crypto.createHash("sha256").update(source).digest("hex"), purpose }];
}

/** Processes whose command line mentions dir (a check that nothing outlived the command). */
function processesMentioning(dir) {
	return fs
		.readdirSync("/proc")
		.filter((name) => /^\d+$/.test(name) && Number(name) !== process.pid)
		.filter((pid) => {
			try {
				return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(dir);
			} catch {
				return false;
			}
		});
}

test("a browser service that writes more than the output cap stops the run as limit-exceeded, never as a success", { skip: NEEDS_EXPORT_TOOLS }, async (t) => {
	await holdMediaLock(t);
	const temp = makeTempDir();
	t.after(temp.cleanup);
	const scenario = staticWebScenario({ dir: temp.dir, discover });
	// Relays a valid readiness line from the bundled server, then floods its own stdout.
	const flood = `import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
const server = spawn(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), "static-server.mjs")], { stdio: ["ignore", "pipe", "inherit"] });
let text = "";
server.stdout.on("data", (chunk) => {
	text += chunk;
	if (!text.includes("\\n")) return;
	const doc = JSON.parse(text.split("\\n")[0]);
	delete doc.pid;
	process.stdout.write(JSON.stringify(doc) + "\\n");
	server.stdout.removeAllListeners("data");
	server.stdout.resume();
	process.stdout.write("x".repeat(200000) + "\\n");
});
setInterval(() => {}, 1000);
`;
	const helpers = [
		{ id: "helper.static", source: "skill", file: "static-server.mjs", sha256: crypto.createHash("sha256").update(fs.readFileSync(path.join(SKILL_ROOT, "scripts", "helpers", "static-server.mjs"))).digest("hex"), purpose: "serve the page" },
		...planDirService(temp.dir, scenario, "flood-wrapper.mjs", flood, "TEST wrapper that floods its output after readiness"),
	];
	const { code, json, stderr } = await demo(temp.dir, scenario, demoPlanFrom(scenario, { helpers }));
	assert.equal(code, 1, `${JSON.stringify(json)}\n${stderr.slice(-2000)}`);
	assert.equal(json.verdict, "run-failed");
	assert.equal(json.status, "failed", "an exceeded limit is a failure, not a cancellation");
	assert.deepEqual(json.exports, []);
	const runManifest = JSON.parse(fs.readFileSync(path.join(json.runPath, "manifest.json"), "utf8"));
	const end = fs.readFileSync(path.join(json.runPath, "events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line)).find((event) => event.type === "run.end");
	assert.equal(end.data.stopCondition, "limit-exceeded", JSON.stringify(end));
	assert.ok(runManifest.failures.some((failure) => failure.code === "service-output-limit"), JSON.stringify(runManifest.failures));
	assert.ok(fs.statSync(path.join(json.runPath, "services", "service.stdout")).size <= scenario.authorization.limits.maxOutputBytes);
});

test("the recorded page's WebSockets follow the same origin allowlist: same-origin connects, another origin is refused before it is reached", { skip: NEEDS_EXPORT_TOOLS }, async (t) => {
	await holdMediaLock(t);
	const temp = makeTempDir();
	t.after(temp.cleanup);
	// A real WebSocket server on another loopback port: if the browser reached it, the upgrade is recorded.
	const upgrades = [];
	// Answers a WebSocket upgrade and sends one "hello" text frame; also written into the test app below.
	function handshake(request, socket) {
		const accept = crypto.createHash("sha1").update(request.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
		socket.on("error", () => {});
		socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n");
		socket.write(Buffer.concat([Buffer.from([0x81, 5]), Buffer.from("hello")]));
	}
	const other = http.createServer((request, response) => response.end("other"));
	other.on("upgrade", (request, socket) => {
		upgrades.push(request.url);
		handshake(request, socket);
	});
	await new Promise((resolve) => other.listen(0, "127.0.0.1", resolve));
	t.after(() => other.close());
	const otherPort = other.address().port;
	const page = `<!doctype html><title>Sockets</title><p id="same">same-origin socket: waiting</p><p id="off">off-origin socket: waiting</p>
<script>
const same = new WebSocket("ws://" + location.host + "/live");
same.onmessage = (event) => { document.getElementById("same").textContent = "same-origin socket: " + event.data; };
let opened = false;
const off = new WebSocket("ws://127.0.0.1:${otherPort}/live");
off.onopen = () => { opened = true; document.getElementById("off").textContent = "off-origin socket: OPENED"; };
off.onclose = () => { if (!opened) document.getElementById("off").textContent = "off-origin socket: refused"; };
</script>`;
	const app = `import crypto from "node:crypto";
import http from "node:http";
const server = http.createServer((request, response) => {
	response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
	response.end(${JSON.stringify(page)});
});
server.on("upgrade", ${handshake.toString()});
server.listen(0, "127.0.0.1", () => process.stdout.write(JSON.stringify({ ready: true, origin: "http://127.0.0.1:" + server.address().port, pid: process.pid }) + "\\n"));
`;
	const scenario = staticWebScenario({ dir: temp.dir, discover });
	const scene = scenario.storyboard.scenes[0];
	scene.actions = [
		{ id: "act.open", op: "goto", target: "/" },
		{ id: "act.same", op: "wait", target: "same-origin socket: hello" },
		{ id: "act.off", op: "wait", target: "off-origin socket: refused" },
	];
	scene.expect = [{ id: "exp.closed", action: "act.off", check: "pageExcludes", value: "OPENED" }];
	const helpers = planDirService(temp.dir, scenario, "socket-app.mjs", app, "TEST app with a same-origin WebSocket and an off-origin one");
	const { code, json, stderr } = await demo(temp.dir, scenario, demoPlanFrom(scenario, { helpers }));
	assert.deepEqual(upgrades, [], "the off-origin WebSocket server was never reached");
	assert.equal(code, 0, `${JSON.stringify(json)}\n${stderr.slice(-2000)}`);
	assert.equal(json.status, "completed");
	const runManifest = JSON.parse(fs.readFileSync(path.join(json.runPath, "manifest.json"), "utf8"));
	const browser = runManifest.cleanup.find((item) => item.item === "browser");
	assert.match(browser.detail, /[1-9]\d* off-origin request\(s\) blocked/, JSON.stringify(browser));
});

test("Ctrl-C during calibration or export stops media production, keeps no partial export and leaves no process behind", { skip: NEEDS_EXPORT_TOOLS }, async (t) => {
	await holdMediaLock(t);
	const temp = makeTempDir();
	t.after(temp.cleanup);
	for (const [stage, line] of [["calibration", "checking the export profile and narration levels"], ["export", "synthesizing business narration"]]) {
		const dir = path.join(temp.dir, stage);
		const scenario = cliApiScenario({ dir, discover });
		let sent = false;
		const { code, json, stderr } = await demo(dir, scenario, demoPlanFrom(scenario), [], {
			onStderr: (text, child) => {
				if (!sent && text.includes(line)) {
					sent = true;
					child.kill("SIGINT");
				}
			},
		});
		assert.ok(sent, `${stage}: reached "${line}"\n${stderr.slice(-2000)}`);
		assert.equal(code, 1, `${stage}: ${JSON.stringify(json)}`);
		assert.equal(json.verdict, "cancelled", `${stage}: ${JSON.stringify(json)}`);
		assert.deepEqual(json.cancelled, { during: stage, by: "interrupt" }, stage);
		assert.ok(json.exports.every((item) => item.verdict !== "structural-pass" && !item.files), `${stage}: ${JSON.stringify(json.exports)}`);
		const demoDir = path.dirname(json.report);
		assert.equal(fs.existsSync(path.join(demoDir, stage === "calibration" ? "calibration" : "business")), false, `${stage}: the partial output is removed`);
		assert.deepEqual(processesMentioning(dir), [], `${stage}: no Piper or FFmpeg process outlived the command`);
	}
});

test("the plan's whole-run time limit also bounds calibration and export", { skip: NEEDS_EXPORT_TOOLS }, async (t) => {
	await holdMediaLock(t);
	const temp = makeTempDir();
	t.after(temp.cleanup);
	const scenario = cliApiScenario({ dir: temp.dir, discover });
	// The recorded step itself finishes inside the limit; media production cannot.
	scenario.authorization.commands[0] = { ...scenario.authorization.commands[0], argv: ["-e", "setTimeout(() => console.log('items: alpha, beta'), 8000)"] };
	scenario.authorization.limits.timeoutMs = 10000;
	rechain(scenario);
	const plan = demoPlanFrom(scenario, { estimate: { cloud: false, amountUsd: null, basis: "local only", maxRunSeconds: 10 } });
	const started = Date.now();
	const { code, json, stderr } = await demo(temp.dir, scenario, plan);
	const elapsed = Date.now() - started;
	assert.equal(code, 1, `${JSON.stringify(json)}\n${stderr.slice(-2000)}`);
	assert.equal(json.status, "completed", "the recorded run itself finished inside the limit");
	assert.equal(json.verdict, "cancelled", JSON.stringify(json));
	assert.equal(json.cancelled.by, "time-limit");
	assert.ok(["calibration", "export"].includes(json.cancelled.during), JSON.stringify(json.cancelled));
	assert.ok(elapsed < 14000, `stopped near the 10 s limit, not after a full export (${elapsed} ms)`);
	assert.ok(json.exports.every((item) => item.verdict !== "structural-pass"), JSON.stringify(json.exports));
	assert.deepEqual(processesMentioning(temp.dir), []);
});
