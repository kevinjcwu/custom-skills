import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { contentSha256 } from "../scripts/lib/canonical.mjs";
import { assessBrowserScene, runFeasibility } from "../scripts/lib/feasibility.mjs";
import { readEvents } from "../scripts/lib/events.mjs";
import { requireTools } from "../scripts/lib/toolchain.mjs";
import { demoPlanFrom, makeTempDir, rechain, runSdp, SKILL_ROOT, staticWebScenario, writeJson } from "./helpers.mjs";
import { discover } from "../scripts/lib/discover.mjs";

const RUNTIME = requireTools([]);

function fixture(t) {
	const temp = makeTempDir();
	t.after(temp.cleanup);
	const scenario = staticWebScenario({ dir: temp.dir, discover });
	const server = fs.readFileSync(path.join(SKILL_ROOT, "scripts", "helpers", "static-server.mjs"));
	const plan = demoPlanFrom(scenario, {
		helpers: [
			{
				id: "helper.static",
				source: "skill",
				file: "static-server.mjs",
				sha256: crypto.createHash("sha256").update(server).digest("hex"),
				purpose: "serve the existing static browser fixture",
			},
		],
	});
	return { temp, scenario, plan };
}

function runOptions(plan, scenario, extra = {}) {
	return {
		plan,
		catalog: scenario.catalog,
		confirmedPlanSha256: contentSha256(plan),
		browserRuntime: RUNTIME,
		runId: extra.runId,
		deadlineMs: extra.deadlineMs,
		...(extra.signal ? { signal: extra.signal } : {}),
	};
}

test("the feasibility assessment refuses an essential browser helper before launch", () => {
	const result = assessBrowserScene({
		storyboard: { scenes: [{ id: "scene.device", adapter: "browser", actions: [{ id: "act.speak", op: "helper" }] }] },
	});
	assert.equal(result.status, "unsupported");
	assert.equal(result.code, "unsupported-interaction");
	assert.match(result.message, /fast path supports only/);
});

test("missing browser prerequisites return an actionable blocked result without creating a run", async (t) => {
	const { scenario, plan } = fixture(t);
	const result = await runFeasibility({
		...runOptions(plan, scenario),
		browserRuntime: { ok: false, reason: "pinned Chromium is missing" },
	});
	assert.equal(result.status, "missing-prerequisite");
	assert.match(result.message, /pinned Chromium is missing/);
	assert.deepEqual(fs.readdirSync(scenario.runDir), []);
});

test("a supported check records only the first browser scene under the full approved plan", { skip: RUNTIME.ok ? false : "pinned runtime unavailable" }, async (t) => {
	const { scenario, plan } = fixture(t);
	scenario.storyboard.scenes.push({
		...structuredClone(scenario.storyboard.scenes[0]),
		id: "scene.later",
		title: "A later browser scene",
		actions: [{ id: "act.later", op: "goto", target: "/index.html" }],
		expect: [],
		narration: scenario.storyboard.scenes[0].narration.map((item) => ({ ...item, id: "nar.later.business" })),
	});
	rechain(scenario);
	const approvedPlan = demoPlanFrom(scenario, { helpers: plan.helpers });
	const result = await runFeasibility({ ...runOptions(approvedPlan, scenario), runId: "feasible" });
	assert.equal(result.status, "feasible", JSON.stringify(result));
	assert.equal(result.sceneId, "scene.cards");
	const events = readEvents(path.join(result.runPath, "events.jsonl"));
	assert.ok(events.some((event) => event.type === "action.attempt" && event.actionId === "act.open" && event.disposition === "ok"));
	assert.ok(events.some((event) => event.type === "action.skipped" && event.actionId === "act.later"));
	assert.ok(result.manifest.cleanup.every((item) => item.result !== "failed"), JSON.stringify(result.manifest.cleanup));
});

test("a completed browser action with a failed expected outcome is a product error", { skip: RUNTIME.ok ? false : "pinned runtime unavailable" }, async (t) => {
	const { scenario, plan } = fixture(t);
	scenario.storyboard.scenes[0].expect[0].value = "A page outcome that is not present";
	rechain(scenario);
	const approvedPlan = demoPlanFrom(scenario, { helpers: plan.helpers });
	const result = await runFeasibility({ ...runOptions(approvedPlan, scenario), runId: "product-error" });
	assert.equal(result.status, "product-error");
	assert.match(result.message, /expected page outcome/);
	assert.ok(result.runPath);
});

test("the feasibility deadline classifies timeout and still cleans up the owned service", { skip: RUNTIME.ok ? false : "pinned runtime unavailable" }, async (t) => {
	const { scenario, plan } = fixture(t);
	scenario.authorization.browser.service = {
		...scenario.authorization.browser.service,
		argv: ["-e", "setInterval(() => {}, 1000)"],
		readyTimeoutMs: 60000,
	};
	scenario.storyboard.catalogSha256 = contentSha256(scenario.catalog);
	rechain(scenario);
	const approvedPlan = demoPlanFrom(scenario, { helpers: plan.helpers });
	const result = await runFeasibility({ ...runOptions(approvedPlan, scenario), runId: "timed-out", deadlineMs: 200 });
	assert.equal(result.status, "timeout");
	assert.ok(result.runPath);
	assert.ok(result.manifest.cleanup.some((item) => item.item === "service" && item.result !== "failed"), JSON.stringify(result.manifest.cleanup));
});

test("the CLI runs the approved plan hash through the feasibility path", { skip: RUNTIME.ok ? false : "pinned runtime unavailable" }, async (t) => {
	const { temp, scenario, plan } = fixture(t);
	const planFile = writeJson(path.join(temp.dir, "demo-plan.json"), plan);
	const catalogFile = writeJson(path.join(temp.dir, "catalog.json"), scenario.catalog);
	const { code, json } = await runSdp(
		[
			"feasibility",
			"--plan",
			planFile,
			"--catalog",
			catalogFile,
			"--confirm-plan-sha256",
			contentSha256(plan),
			"--run-id",
			"cli-feasibility",
		],
		{
			env: {
				PATH: process.env.PATH ?? "/usr/bin:/bin",
				SDP_RUNTIME_DIR: process.env.SDP_RUNTIME_DIR,
				PYTHONDONTWRITEBYTECODE: "1",
				XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
				TMPDIR: process.env.TMPDIR,
			},
		},
	);
	assert.equal(code, 0, JSON.stringify(json));
	assert.equal(json.status, "feasible");
	assert.equal(json.sceneId, "scene.cards");
});

test("the CLI documents the approved-plan feasibility entry point", async () => {
	const help = await runSdp(["--help"]);
	assert.equal(help.code, 0);
	assert.match(help.json.usage, /feasibility --plan/);
});
