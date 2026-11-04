import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { contentSha256 } from "../scripts/lib/canonical.mjs";
import {
	browserActionErrors,
	contractNameOf,
	validateContract,
	validateEventStream,
	workspaceArgErrors,
} from "../scripts/lib/contracts.mjs";
import {
	clone,
	exampleAuthorization,
	exampleCatalog,
	exampleStoryboard,
	HASH_A,
	HASH_B,
} from "./helpers.mjs";
import { BROWSER_DESCRIPTOR, parseReadiness, substituteWorkspace } from "../scripts/lib/browser-adapter.mjs";
import { HTTP_DESCRIPTOR } from "../scripts/lib/http-adapter.mjs";
import { PROCESS_DESCRIPTOR } from "../scripts/lib/process-adapter.mjs";

function messages(errors) {
	return errors.map((error) => `${error.path}: ${error.message}`).join("\n");
}

function expectError(errors, pathPart, messagePart) {
	assert.ok(
		errors.some((error) => error.path.includes(pathPart) && error.message.includes(messagePart)),
		`expected ${pathPart} / ${messagePart} in:\n${messages(errors)}`,
	);
}

test("canonical hash ignores key order and formatting", () => {
	assert.equal(contentSha256({ b: 1, a: [1, { d: 2, c: 3 }] }), contentSha256({ a: [1, { c: 3, d: 2 }], b: 1 }));
	assert.throws(() => contentSha256({ a: Number.NaN }), { code: "canonical-json" });
});

test("contractNameOf maps schema fields to contracts", () => {
	assert.equal(contractNameOf({ schema: "storyboard.v1" }), "storyboard");
	assert.equal(contractNameOf({ schema: "storyboard.v2" }), null);
	assert.equal(contractNameOf([]), null);
});

test("catalog cross-field rules", () => {
	const catalog = exampleCatalog();
	assert.deepEqual(validateContract("capability-catalog", catalog), []);

	const dup = clone(catalog);
	dup.evidence.push(clone(dup.evidence[0]));
	expectError(validateContract("capability-catalog", dup), "/evidence/2/id", "duplicate");

	const broken = clone(catalog);
	broken.edges[0].to = "comp.missing";
	broken.capabilities[0].evidence = ["ev.missing"];
	const errors = validateContract("capability-catalog", broken);
	expectError(errors, "/edges/0/to", "unknown component");
	expectError(errors, "/capabilities/0/evidence/0", "unknown evidence");

	const notFact = clone(catalog);
	notFact.capabilities[0].class = "inferred";
	notFact.capabilities[0].reason = "guess";
	expectError(validateContract("capability-catalog", notFact), "/capabilities/0/class", "must be class fact");

	const badHash = clone(catalog);
	badHash.evidence[0].sha256 = "XYZ";
	expectError(validateContract("capability-catalog", badHash), "/evidence/0/sha256", "");

	const apiKey = clone(catalog);
	apiKey.repo.apiKey = "secret";
	expectError(validateContract("capability-catalog", apiKey), "/repo/apiKey", "");
});

test("storyboard hash chain and claim rules", () => {
	const catalog = exampleCatalog();
	const storyboard = exampleStoryboard(catalog);
	assert.deepEqual(validateContract("storyboard", storyboard, { catalog }), []);

	const changed = clone(catalog);
	changed.repo.fileCount = 3;
	expectError(validateContract("storyboard", storyboard, { catalog: changed }), "/catalogSha256", "does not match");

	const narratedInference = clone(storyboard);
	narratedInference.scenes[0].narration[0].claims.push("claim.lib");
	expectError(validateContract("storyboard", narratedInference, { catalog }), "/claims/1", "must not be narrated");

	const unbacked = clone(storyboard);
	unbacked.claims[0].evidence = [];
	unbacked.claims[0].demonstratedBy = [];
	const unbackedErrors = validateContract("storyboard", unbacked, { catalog });
	expectError(unbackedErrors, "/claims/0", "requires evidence or demonstratedBy");
	expectError(unbackedErrors, "/claims/0/demonstratedBy", "observed claims");

	const brokenRefs = clone(storyboard);
	brokenRefs.scenes[0].narration[0].claims = ["claim.missing"];
	brokenRefs.scenes[0].expect[0].action = "act.other";
	brokenRefs.scenes[0].diagram.edges = ["edge.missing"];
	brokenRefs.claims[0].evidence = ["ev.missing"];
	const refErrors = validateContract("storyboard", brokenRefs, { catalog });
	expectError(refErrors, "/narration/0/claims/0", "unknown claim");
	expectError(refErrors, "/expect/0/action", "unknown action");
	expectError(refErrors, "/diagram/edges/0", "unknown catalog edge");
	expectError(refErrors, "/claims/0/evidence/0", "unknown catalog evidence");

	const forbidden = clone(storyboard);
	forbidden.scenes[0].narration[0].text = "This scales to a million users.";
	expectError(validateContract("storyboard", forbidden, { catalog }), "/narration/0/text", "forbidden claim");

	const oneAudience = clone(storyboard);
	oneAudience.scenes[0].narration.pop();
	expectError(validateContract("storyboard", oneAudience, { catalog }), "/scenes/0/narration", "engineering");

	const wrongOp = clone(storyboard);
	wrongOp.scenes[0].actions[0].op = "click";
	wrongOp.scenes[0].expect[0].check = "status";
	const opErrors = validateContract("storyboard", wrongOp, { catalog });
	expectError(opErrors, "/actions/0/op", "not valid for adapter process");
	expectError(opErrors, "/expect/0/check", "not valid for adapter process");

	const nonSynthetic = clone(storyboard);
	nonSynthetic.dataProvenance[0].kind = "human-supplied";
	nonSynthetic.dataProvenance[0].rightsConfirmed = false;
	const dataErrors = validateContract("storyboard", nonSynthetic, { catalog });
	expectError(dataErrors, "/dataProvenance/0", "rightsConfirmed");
	expectError(dataErrors, "/dataProvenance/0", "synthetic-only");
});

test("run authorization rules", () => {
	const storyboard = exampleStoryboard();
	const auth = exampleAuthorization(storyboard);
	assert.deepEqual(validateContract("run-authorization", auth, { storyboard }), []);

	const mismatch = clone(auth);
	mismatch.storyboardSha256 = HASH_A;
	expectError(validateContract("run-authorization", mismatch, { storyboard }), "/storyboardSha256", "does not match");

	const relativeBinding = clone(auth);
	relativeBinding.bindings.targetRoot = "relative/root";
	expectError(validateContract("run-authorization", relativeBinding), "/bindings/targetRoot", "absolute");

	const badCwd = clone(auth);
	badCwd.commands[0].cwd = "../outside";
	expectError(validateContract("run-authorization", badCwd), "/commands/0/cwd", "");

	const unknownExe = clone(auth);
	unknownExe.commands[0].executable = "bash";
	expectError(validateContract("run-authorization", unknownExe), "/commands/0/executable", "unknown executable");

	const unauthorizedAction = clone(storyboard);
	unauthorizedAction.scenes[0].actions[0].ref = "run.other";
	expectError(
		validateContract("run-authorization", exampleAuthorization(unauthorizedAction), { storyboard: unauthorizedAction }),
		"actions/0/ref",
		"unknown authorized command",
	);

	const credential = clone(auth);
	credential.apiKey = "secret";
	expectError(validateContract("run-authorization", credential), "/apiKey", "");

	const noLimits = clone(auth);
	delete noLimits.limits.timeoutMs;
	expectError(validateContract("run-authorization", noLimits), "/limits", "timeoutMs");

	const http = clone(auth);
	http.http.requests = [
		{ id: "r1", origin: "http://user:pw@127.0.0.1:8080", method: "GET", path: "/", headers: [] },
		{ id: "r2", origin: "http://example.invalid", method: "GET", path: "/", headers: [] },
		{ id: "r3", origin: "file:///etc", method: "GET", path: "/", headers: [] },
		{ id: "r4", origin: "http://127.0.0.1:8080/x", method: "GET", path: "/", headers: [{ name: "Authorization", value: "x" }] },
		{ id: "r5", origin: "http://127.0.0.1:8080", method: "GET", path: "/", headers: [], body: "x" },
	];
	let errors = validateContract("run-authorization", http);
	expectError(errors, "/http/requests", "network none");
	http.network = "loopback";
	errors = validateContract("run-authorization", http);
	expectError(errors, "/http/requests/0/origin", "userinfo");
	expectError(errors, "/http/requests/1/origin", "loopback");
	expectError(errors, "/http/requests/2/origin", "scheme");
	expectError(errors, "/http/requests/3/origin", "exact origin");
	expectError(errors, "/http/requests/3/headers/0/name", "not allowed");
	expectError(errors, "/http/requests/4/body", "only POST");
});

test("event stream ordering", () => {
	const event = (seq, tMs) => ({
		schema: "event.v1",
		runId: "run-1",
		seq,
		clock: "node-monotonic",
		tMs,
		producer: "run",
		kind: "observed",
		type: "scene.start",
		data: {},
		disposition: "ok",
	});
	assert.deepEqual(validateEventStream([event(0, 0), event(1, 5)], "run-1"), []);
	expectError(validateEventStream([event(0, 5), event(2, 1)], "run-1"), "/1/seq", "expected seq 1");
	expectError(validateEventStream([event(0, 5), event(1, 1)], "run-1"), "/1/tMs", "decreased");
	expectError(validateEventStream([event(0, 0)], "run-2"), "/0/runId", "differs");
});

function exampleManifest() {
	return {
		schema: "artifact-manifest.v1",
		runId: "run-1",
		subject: "synthetic-fixture",
		status: "completed",
		catalogSha256: HASH_A,
		storyboardSha256: HASH_A,
		authorizationSha256: HASH_A,
		targetContentSha256: HASH_A,
		artifacts: [
			{ path: "events.jsonl", sha256: HASH_A, bytes: 10, role: "events", producedBy: "run" },
			{ path: "export/demo.webm", sha256: HASH_B, bytes: 10, role: "export-video", producedBy: "mux" },
		],
		transformations: [],
		failures: [],
		cleanup: [],
	};
}

test("manifest rules include binding leaks", () => {
	const manifest = exampleManifest();
	assert.deepEqual(validateContract("artifact-manifest", manifest), []);
	const leaked = clone(manifest);
	leaked.cleanup.push({ item: "child", result: "exited", detail: "cwd /approved/target/x" });
	expectError(
		validateContract("artifact-manifest", leaked, { needles: [{ id: "targetRoot", value: "/approved/target" }] }),
		"/cleanup/0/detail",
		"binding",
	);
	const absolute = clone(manifest);
	absolute.artifacts[0].path = "/approved/runs/events.jsonl";
	expectError(validateContract("artifact-manifest", absolute), "/artifacts/0/path", "");
	const failedWithout = clone(manifest);
	failedWithout.status = "failed";
	expectError(validateContract("artifact-manifest", failedWithout), "/failures", "at least one");
});

test("QA release requires an independent exact-file review", () => {
	const manifest = exampleManifest();
	const base = {
		schema: "qa-report.v1",
		runId: "run-1",
		manifestSha256: HASH_A,
		claimLedgerSha256: HASH_A,
		reviewer: { kind: "structural-tool", id: "sdp" },
		checks: [{ id: "hashes", status: "pass", detail: "ok" }],
		verdict: "structural-pass",
		limitations: [],
	};
	assert.deepEqual(validateContract("qa-report", base, { manifest }), []);
	const toolRelease = { ...clone(base), verdict: "release" };
	expectError(validateContract("qa-report", toolRelease, { manifest }), "/reviewer/kind", "never release");
	expectError(validateContract("qa-report", toolRelease, { manifest }), "/audiovisualReview", "exact-file");

	const review = {
		exportPath: "export/demo.webm",
		exportSha256: HASH_B,
		watchedAndListened: true,
		reviewer: "independent reviewer",
		notes: "watched end to end",
	};
	const human = { ...clone(base), verdict: "release", reviewer: { kind: "independent-human", id: "r" }, audiovisualReview: review };
	assert.deepEqual(validateContract("qa-report", human, { manifest }), []);
	expectError(validateContract("qa-report", human), "/audiovisualReview", "against its manifest");
	const wrongHash = clone(human);
	wrongHash.audiovisualReview.exportSha256 = HASH_A;
	expectError(validateContract("qa-report", wrongHash, { manifest }), "/exportSha256", "does not match");
	const notWatched = clone(human);
	notWatched.audiovisualReview.watchedAndListened = false;
	expectError(validateContract("qa-report", notWatched, { manifest }), "watchedAndListened", "requires");
	const failing = clone(base);
	failing.checks[0].status = "fail";
	expectError(validateContract("qa-report", failing), "/verdict", "failing checks");
});

test("claim ledger never asserts inferred claims", () => {
	const ledger = {
		schema: "claim-ledger.v1",
		runId: "run-1",
		manifestSha256: HASH_A,
		claims: [
			{ id: "c1", class: "inferred", verdict: "supported", reason: "x", evidence: [{ type: "run-action", ref: "a" }], narration: ["n1"] },
		],
	};
	const errors = validateContract("claim-ledger", ledger);
	expectError(errors, "/claims/0/verdict", "not-asserted");
	expectError(errors, "/claims/0/narration", "must not be narrated");
});

test("the implemented adapters' descriptors satisfy the adapter-descriptor contract", () => {
	assert.deepEqual(validateContract("adapter-descriptor", PROCESS_DESCRIPTOR), []);
	assert.deepEqual(validateContract("adapter-descriptor", HTTP_DESCRIPTOR), []);
	assert.deepEqual(validateContract("adapter-descriptor", BROWSER_DESCRIPTOR), []);
});

test("browser actions are limited to origin paths, role-named clicks and key names", () => {
	assert.deepEqual(browserActionErrors({ id: "a", op: "goto", target: "/reports?x=1" }), []);
	assert.deepEqual(browserActionErrors({ id: "a", op: "click", target: "button:counts.csv" }), []);
	assert.deepEqual(browserActionErrors({ id: "a", op: "press", value: "Enter" }), []);
	for (const target of ["//evil.example/x", "http:x", "relative", "/with space"]) {
		assert.ok(browserActionErrors({ id: "a", op: "goto", target }).some((error) => error.at === "/target"), target);
	}
	assert.ok(browserActionErrors({ id: "a", op: "click", target: "script:alert" }).some((error) => error.at === "/target"));
	assert.ok(browserActionErrors({ id: "a", op: "click", target: "#css-selector" }).some((error) => error.at === "/target"));
	assert.ok(browserActionErrors({ id: "a", op: "press", value: "a; b" }).some((error) => error.at === "/value"));
	assert.ok(browserActionErrors({ id: "a", op: "fill", target: "Name" }).some((error) => error.at === "/value"));
	assert.ok(browserActionErrors({ id: "a", op: "goto", target: "/", ref: "cmd.x" }).some((error) => error.at === "/ref"));
});

test("{workspace} may only start an argument and stays inside the run workspace", () => {
	assert.deepEqual(workspaceArgErrors("--port", false), []);
	assert.deepEqual(workspaceArgErrors("{workspace}/reports", true), []);
	assert.equal(workspaceArgErrors("{workspace}/reports", false).length, 1);
	assert.equal(workspaceArgErrors("--out={workspace}/x", true).length, 1);
	assert.ok(workspaceArgErrors("{workspace}/../escape", true).length > 0);
	assert.ok(workspaceArgErrors("{workspace}//abs", true).length > 0);
	const base = fs.realpathSync(path.dirname(fileURLToPath(import.meta.url)));
	assert.deepEqual(substituteWorkspace(["--out", "{workspace}/r/a.json", "plain"], base), ["--out", path.join(base, "r", "a.json"), "plain"]);
	assert.throws(() => substituteWorkspace(["{workspace}/x"], null), /no workspace/);
});

test("service readiness must name an exact loopback origin with an explicit port", () => {
	assert.deepEqual(parseReadiness(JSON.stringify({ ready: true, origin: "http://127.0.0.1:4100", pid: 7 })), { origin: "http://127.0.0.1:4100", port: 4100, pid: 7 });
	for (const origin of ["http://localhost:4100", "http://0.0.0.0:4100", "https://127.0.0.1:4100", "http://127.0.0.1", "http://127.0.0.1:4100/path"]) {
		assert.throws(() => parseReadiness(JSON.stringify({ ready: true, origin })), /origin/, origin);
	}
	assert.throws(() => parseReadiness("listening on 4100"), /not JSON/);
	assert.throws(() => parseReadiness(JSON.stringify({ origin: "http://127.0.0.1:1" })), /ready/);
});
