import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { discover } from "../scripts/lib/discover.mjs";
import { preflight, PREFLIGHT_NOTE } from "../scripts/lib/preflight.mjs";
import { validateContract } from "../scripts/lib/contracts.mjs";
import { cliApiScenario, clone, makeTempDir, rechain } from "./helpers.mjs";

function setup(t) {
	const temp = makeTempDir();
	t.after(temp.cleanup);
	return { temp, scenario: cliApiScenario({ dir: temp.dir, discover }) };
}

const statusOf = (result, id) => result.checks.find((check) => check.id === id)?.status;

test("ready preflight is passive: no executable is started and no target script runs", (t) => {
	const { temp, scenario } = setup(t);
	// An approved "executable" that would leave a marker if it were ever started.
	const marker = path.join(temp.dir, "STARTED-MARKER");
	const fake = path.join(temp.dir, "fake-exe.cjs");
	fs.writeFileSync(fake, `#!/usr/bin/env node\nrequire("fs").writeFileSync(${JSON.stringify(marker)}, "x");\n`, { mode: 0o755 });
	scenario.authorization.bindings.executables[0].path = fake;

	const result = preflight(scenario);
	assert.equal(result.verdict, "ready", JSON.stringify(result.checks));
	assert.equal(result.note, PREFLIGHT_NOTE);
	assert.deepEqual(validateContract("preflight", result), []);
	assert.equal(fs.existsSync(marker), false);
	assert.equal(fs.existsSync(path.join(scenario.targetRoot, "EXECUTED-MARKER")), false);
	assert.deepEqual(fs.readdirSync(scenario.runDir), []);
	assert.match(result.checks.find((check) => check.id === "executables").detail, /none were started/);
});

test("a ready preflight needs a reachable target, runDir and executables", (t) => {
	const { scenario } = setup(t);
	const missingExe = clone(scenario);
	missingExe.authorization.bindings.executables[0].path = path.join(scenario.runDir, "..", "no-such-node");
	let result = preflight(missingExe);
	assert.equal(result.verdict, "blocked");
	assert.equal(statusOf(result, "executables"), "blocked");

	const missingRunDir = clone(scenario);
	missingRunDir.authorization.bindings.runDir = path.join(scenario.runDir, "..", "no-such-runs");
	result = preflight(missingRunDir);
	assert.equal(result.verdict, "blocked");
	assert.equal(statusOf(result, "run-dir"), "blocked");

	const nested = clone(scenario);
	nested.authorization.bindings.runDir = scenario.targetRoot;
	result = preflight(nested);
	assert.equal(statusOf(result, "run-dir-separate"), "fail");
});

test("a changed target is detected against the catalog digest", (t) => {
	const { scenario } = setup(t);
	fs.writeFileSync(path.join(scenario.targetRoot, "README.md"), "# changed after discovery\n");
	const result = preflight(scenario);
	assert.equal(result.verdict, "blocked");
	assert.equal(statusOf(result, "target-content"), "fail");
});

test("broken hash chains fail the contract checks", (t) => {
	const { scenario } = setup(t);
	scenario.storyboard.title = "edited after approval";
	const result = preflight(scenario);
	assert.equal(result.verdict, "blocked");
	assert.equal(statusOf(result, "storyboard-contract"), "pass");
	assert.equal(statusOf(result, "authorization-contract"), "fail");
});

test("unauthorized browser scenes block readiness with reasons; voice scenes no longer exist in the package", (t) => {
	const { scenario } = setup(t);
	scenario.storyboard.claims.push({ id: "claim.readme", text: "The project documents its commands", class: "documented", evidence: ["ev.readme.md"], demonstratedBy: [] });
	const narration = (id) => ["business", "engineering"].map((audience) => ({
		id: `nar.${id}.${audience}`,
		audience,
		text: "The readme describes the commands.",
		claims: ["claim.readme"],
		caption: { source: "narration-text", provenance: "agent-drafted" },
	}));
	scenario.storyboard.scenes.push(
		{ id: "scene.page", title: "Page", adapter: "browser", capabilities: [], dataProvenance: ["data.synthetic"], actions: [{ id: "act.open", op: "goto", target: "/" }], expect: [], narration: narration("page") },
	);
	rechain(scenario);
	const result = preflight(scenario);
	assert.equal(result.verdict, "blocked");
	assert.deepEqual(
		result.adapters.map((adapter) => [adapter.adapter, adapter.status]),
		[["process", "supported"], ["browser", "blocked"]],
	);
	assert.ok(result.adapters.filter((adapter) => adapter.status !== "supported").every((adapter) => adapter.reason.length > 0));

	// The former built-in voice adapter is gone: such a storyboard is invalid, not silently run.
	scenario.storyboard.scenes.push({ id: "scene.voice", title: "Voice", adapter: "voice", capabilities: [], dataProvenance: ["data.synthetic"], actions: [{ id: "act.talk", op: "converse", target: "reply", value: "hello" }], expect: [], narration: narration("voice") });
	rechain(scenario);
	const voice = preflight(scenario);
	assert.equal(voice.verdict, "blocked");
	assert.equal(statusOf(voice, "storyboard-contract"), "fail");
});


test("cited catalog evidence must exist in the target and match its recorded SHA-256", (t) => {
	const { scenario } = setup(t);
	const variants = [
		(item) => {
			item.ref.path = "does-not-exist.mjs";
			item.sha256 = "0".repeat(64);
		},
		(item) => {
			item.sha256 = "0".repeat(64);
		},
	];
	for (const change of variants) {
		const edited = clone(scenario);
		change(edited.catalog.evidence.find((item) => item.id === "ev.bin-tally.mjs"));
		rechain(edited);
		assert.deepEqual(validateContract("capability-catalog", edited.catalog), []);
		const result = preflight(edited);
		assert.equal(result.verdict, "blocked");
		assert.equal(statusOf(result, "catalog-evidence"), "fail");
		assert.match(result.checks.find((check) => check.id === "catalog-evidence").detail, /ev\.bin-tally\.mjs/);
	}
	assert.equal(statusOf(preflight(scenario), "catalog-evidence"), "pass");
});

test("header values with control characters are refused before the run", (t) => {
	const temp = makeTempDir();
	t.after(temp.cleanup);
	const scenario = cliApiScenario({ dir: temp.dir, discover, origin: "http://127.0.0.1:1" });
	scenario.authorization.http.requests[0].headers = [{ name: "x-label", value: "invalid\nheader" }];
	const errors = validateContract("run-authorization", scenario.authorization);
	assert.ok(errors.some((error) => error.path === "/http/requests/0/headers/0/value"), JSON.stringify(errors));
	const result = preflight(scenario);
	assert.equal(result.verdict, "blocked");
	assert.equal(statusOf(result, "authorization-contract"), "fail");
});
