#!/usr/bin/env node
// sdp: stakeholder-demo-producer helper CLI (Node built-ins only).
//
// Every command prints one JSON document on stdout. Exit codes:
//   0 success, 1 failure or invalid input, 2 usage error,
//   3 blocked or not implemented.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { contentSha256 } from "./lib/canonical.mjs";
import { contractNameOf, validateContract, validateEventStream } from "./lib/contracts.mjs";
import { discover } from "./lib/discover.mjs";
import { EXIT, SdpError, usageError } from "./lib/errors.mjs";
import { readEvents } from "./lib/events.mjs";
import { readJsonFile, writeJsonExclusive } from "./lib/io.mjs";
import { verifyManifestFiles } from "./lib/manifest.mjs";
import { preflight } from "./lib/preflight.mjs";
import { writeStructuralQa } from "./lib/qa.mjs";
import { withCancellation } from "./lib/proc-registry.mjs";
import { runDemo } from "./lib/run.mjs";
import { chromiumExecutable } from "./lib/browser.mjs";
import { assessBrowserScene, runFeasibility } from "./lib/feasibility.mjs";
import { checkToolchain, installToolchain, requireTools, SKILL_ROOT } from "./lib/toolchain.mjs";

// Nothing is currently stubbed; the map stays for future gated commands.
const NOT_IMPLEMENTED = {};

// Former stub names whose function now lives in another command.
const MOVED = {
	capture: "browser and process capture happen inside `sdp run` (browser scenes record the session video)",
	browser: "browser scenes run inside `sdp run` with an authorized loopback service",
	narrate: "narration is synthesized by `sdp produce`",
	tts: "speech synthesis is part of `sdp produce`",
	captions: "captions are written by `sdp produce`",
	mux: "muxing and export are done by `sdp produce`",
};

const HELP = `usage: sdp <command> [options]

main workflow (repo -> discover -> clarify -> approved plan -> demo):
  discover  --root <dir> [--label <text>] [--out <file>]   (also listed below)
  plan      --plan <file> --catalog <file> [--out <summary.md>]
            check a demo plan and print its sha256 and a readable summary
  feasibility --plan <file> --catalog <file> --confirm-plan-sha256 <sha256>
            [--run-id <id>]
            record the first essential browser scene (1-5 fixed browser actions)
            under the same approved demo-plan hash; unsupported steps fail fast
  demo      --plan <file> --catalog <file> --confirm-plan-sha256 <sha256>
            [--calibration <file>] [--max-spend-usd <amount>]
            run the approved plan, then produce one narrated MP4 per audience
            with a feature coverage report; every demo has the narrator;
            interactions the fixed browser steps cannot do run as approved,
            run-local helpers the agent wrote for this target (the skill
            ships none); --max-spend-usd is an optional limit the human may set

building blocks:
  discover  --root <dir> [--label <text>] [--out <file>]
            [--max-files <n>] [--max-file-bytes <n>] [--max-total-bytes <n>]
  validate  <file> [--catalog <file>] [--storyboard <file>] [--manifest <file>] [--run-id <id>]
  hash      <file>
  preflight --catalog <file> --storyboard <file> --authorization <file> [--out <file>]
  run       --catalog <file> --storyboard <file> --authorization <file>
            --confirm-authorization-sha256 <sha256> [--run-id <id>]
  manifest  --run <dir>
  qa        --run <dir>
  setup     check|install    verify or install the pinned project-local toolchain
            (ready = narration, browser and export tools)
  calibrate [--scope export] [--runs-dir <dir>]
            check the export profile and narration levels on this host
  produce   --run <dir> --calibration <file> [--audience business|engineering] [--runs-dir <dir>]
            narrated MP4 + WebVTT from a completed, QA-checked run (alias: export)

not implemented (exit 3): ${Object.keys(NOT_IMPLEMENTED).join(", ") || "none"}

exit codes: 0 ok, 1 failed/invalid, 2 usage, 3 blocked/not implemented`;

const COMMAND_OPTIONS = {
	plan: { plan: "value", catalog: "value", out: "value" },
	feasibility: { plan: "value", catalog: "value", "confirm-plan-sha256": "value", "run-id": "value" },
	demo: { plan: "value", catalog: "value", "confirm-plan-sha256": "value", calibration: "value", "max-spend-usd": "value" },
	discover: { root: "value", label: "value", out: "value", "max-files": "value", "max-file-bytes": "value", "max-total-bytes": "value" },
	validate: { catalog: "value", storyboard: "value", manifest: "value", "run-id": "value" },
	hash: {},
	preflight: { catalog: "value", storyboard: "value", authorization: "value", out: "value" },
	run: { catalog: "value", storyboard: "value", authorization: "value", "confirm-authorization-sha256": "value", "run-id": "value" },
	manifest: { run: "value" },
	qa: { run: "value" },
	setup: {},
	calibrate: { "runs-dir": "value", scope: "value" },
	produce: { run: "value", calibration: "value", audience: "value", "runs-dir": "value" },
	export: { run: "value", calibration: "value", audience: "value", "runs-dir": "value" },
};

function parseArgs(command, args) {
	const allowed = COMMAND_OPTIONS[command];
	const options = {};
	const positional = [];
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg.startsWith("--")) {
			const name = arg.slice(2);
			if (!(name in allowed)) {
				throw usageError(`unknown option --${name} for ${command}`);
			}
			if (name in options) {
				throw usageError(`option --${name} given twice`);
			}
			const value = args[index + 1];
			if (value === undefined || value.startsWith("--")) {
				throw usageError(`option --${name} needs a value`);
			}
			options[name] = value;
			index += 1;
		} else {
			positional.push(arg);
		}
	}
	return { options, positional };
}

function required(options, ...names) {
	for (const name of names) {
		if (options[name] === undefined) {
			throw usageError(`missing required option --${name}`);
		}
	}
}

function positiveInt(value, name) {
	if (value === undefined) {
		return undefined;
	}
	if (!/^[1-9][0-9]{0,11}$/.test(value)) {
		throw usageError(`--${name} must be a positive integer`);
	}
	return Number(value);
}

/** A non-negative US dollar amount with at most two decimals. */
function dollars(value, name) {
	if (!/^(0|[1-9][0-9]{0,5})(\.[0-9]{1,2})?$/.test(value)) {
		throw usageError(`--${name} must be a dollar amount such as 5 or 12.50`);
	}
	return Number(value);
}

function emit(document, outFile) {
	if (outFile) {
		try {
			writeJsonExclusive(outFile, document);
		} catch (error) {
			throw new SdpError("write-failed", error.code === "EEXIST" ? "output file already exists; outputs are never overwritten" : "cannot write the output file");
		}
	}
	return document;
}

function loadTriple(options) {
	required(options, "catalog", "storyboard", "authorization");
	return {
		catalog: readJsonFile(options.catalog, "catalog"),
		storyboard: readJsonFile(options.storyboard, "storyboard"),
		authorization: readJsonFile(options.authorization, "authorization"),
	};
}

/**
 * Passive check of the pinned browser toolchain, made only when the
 * storyboard has browser scenes. Nothing is launched.
 */
function browserRuntimeFor(storyboard) {
	const scenes = Array.isArray(storyboard?.scenes) ? storyboard.scenes : [];
	if (!scenes.some((scene) => scene?.adapter === "browser")) {
		return undefined;
	}
	const tools = requireTools([]);
	if (!tools.ok) {
		return { ok: false, reason: tools.reason };
	}
	try {
		chromiumExecutable(tools.paths);
	} catch (error) {
		return { ok: false, reason: error.message };
	}
	return { ok: true, paths: tools.paths };
}

/** Reads and checks a demo plan against its catalog. */
function loadPlan(options) {
	required(options, "plan", "catalog");
	const plan = readJsonFile(options.plan, "demo plan");
	const catalog = readJsonFile(options.catalog, "catalog");
	const catalogErrors = validateContract("capability-catalog", catalog);
	const errors = catalogErrors.length ? catalogErrors.map((error) => ({ path: `catalog${error.path}`, message: error.message })) : validateContract("demo-plan", plan, { catalog });
	return { plan, catalog, errors, sha256: contentSha256(plan), planDir: path.dirname(path.resolve(options.plan)) };
}

const COMMANDS = {
	async plan({ options, positional }) {
		if (positional.length) {
			throw usageError("plan takes no positional arguments");
		}
		const { plan, catalog, errors, sha256 } = loadPlan(options);
		if (errors.length) {
			return { exitCode: EXIT.FAILED, document: { valid: false, sha256, errors } };
		}
		const { planSummary } = await import("./lib/demo-plan.mjs");
		const summary = planSummary(plan, { sha256, catalog, planFile: options.plan });
		if (options.out) {
			try {
				fs.writeFileSync(options.out, summary, { flag: "wx" });
			} catch (error) {
				throw new SdpError("write-failed", error.code === "EEXIST" ? "output file already exists; outputs are never overwritten" : "cannot write the output file");
			}
		}
		return { exitCode: EXIT.OK, document: { valid: true, sha256, summary: options.out ?? summary } };
	},

	feasibility: (args) => feasibilityCommand(args),

	demo: (args) => demoCommand(args),

	discover({ options, positional }) {
		if (positional.length) {
			throw usageError("discover takes no positional arguments");
		}
		required(options, "root");
		const limits = {};
		for (const [flag, key] of [["max-files", "maxFiles"], ["max-file-bytes", "maxFileBytes"], ["max-total-bytes", "maxTotalBytes"]]) {
			const value = positiveInt(options[flag], flag);
			if (value !== undefined) {
				limits[key] = value;
			}
		}
		const catalog = discover(options.root, { label: options.label, limits });
		const errors = validateContract("capability-catalog", catalog);
		if (errors.length) {
			throw new SdpError("invalid-contract", "discovery produced an invalid catalog", { details: errors });
		}
		return { exitCode: EXIT.OK, document: emit(catalog, options.out) };
	},

	validate({ options, positional }) {
		if (positional.length !== 1) {
			throw usageError("validate needs exactly one file");
		}
		const file = positional[0];
		if (file.endsWith(".jsonl")) {
			const events = readEvents(file);
			const errors = validateEventStream(events, options["run-id"]);
			return { exitCode: errors.length ? EXIT.FAILED : EXIT.OK, document: { valid: errors.length === 0, contract: "event", count: events.length, errors } };
		}
		const doc = readJsonFile(file, "input");
		const contract = contractNameOf(doc);
		if (!contract) {
			return { exitCode: EXIT.FAILED, document: { valid: false, contract: null, errors: [{ path: "/schema", message: "unknown or missing contract identifier" }] } };
		}
		const context = {};
		for (const name of ["catalog", "storyboard", "manifest"]) {
			if (options[name] !== undefined) {
				context[name] = readJsonFile(options[name], name);
			}
		}
		const errors = validateContract(contract, doc, context);
		return {
			exitCode: errors.length ? EXIT.FAILED : EXIT.OK,
			document: { valid: errors.length === 0, contract, sha256: contentSha256(doc), context: Object.keys(context), errors },
		};
	},

	hash({ positional }) {
		if (positional.length !== 1) {
			throw usageError("hash needs exactly one file");
		}
		const doc = readJsonFile(positional[0], "input");
		return { exitCode: EXIT.OK, document: { contract: contractNameOf(doc), sha256: contentSha256(doc), canonical: "sorted-keys-compact-json" } };
	},

	preflight({ options, positional }) {
		if (positional.length) {
			throw usageError("preflight takes no positional arguments");
		}
		const triple = loadTriple(options);
		const result = preflight({ ...triple, browserRuntime: browserRuntimeFor(triple.storyboard) });
		emit(result, options.out);
		const invalid = result.checks.some((check) => check.id.endsWith("-contract") && check.status === "fail");
		return { exitCode: invalid ? EXIT.FAILED : result.verdict === "ready" ? EXIT.OK : EXIT.BLOCKED, document: result };
	},

	async run({ options, positional }) {
		if (positional.length) {
			throw usageError("run takes no positional arguments");
		}
		const triple = loadTriple(options);
		const controller = new globalThis.AbortController();
		const onSignal = () => controller.abort();
		process.once("SIGINT", onSignal);
		process.once("SIGTERM", onSignal);
		try {
			const result = await runDemo({
				...triple,
				browserRuntime: browserRuntimeFor(triple.storyboard),
				confirmAuthorizationSha256: options["confirm-authorization-sha256"],
				runId: options["run-id"],
				signal: controller.signal,
			});
			return {
				exitCode: result.status === "completed" ? EXIT.OK : EXIT.FAILED,
				document: {
					runId: result.runId,
					run: `<binding:runDir>/${result.runId}`,
					status: result.status,
					manifestSha256: result.manifestSha256,
					failures: result.manifest.failures,
				},
			};
		} finally {
			process.removeListener("SIGINT", onSignal);
			process.removeListener("SIGTERM", onSignal);
		}
	},

	manifest({ options, positional }) {
		if (positional.length) {
			throw usageError("manifest takes no positional arguments");
		}
		required(options, "run");
		const runPath = path.resolve(options.run);
		const manifest = readJsonFile(path.join(runPath, "manifest.json"), "manifest");
		const errors = validateContract("artifact-manifest", manifest);
		if (errors.length) {
			return { exitCode: EXIT.FAILED, document: { valid: false, errors } };
		}
		const checks = verifyManifestFiles(runPath, manifest);
		const ok = checks.every((check) => check.status === "pass");
		return {
			exitCode: ok ? EXIT.OK : EXIT.FAILED,
			document: { valid: ok, runId: manifest.runId, status: manifest.status, manifestSha256: contentSha256(manifest), checks },
		};
	},

	qa({ options, positional }) {
		if (positional.length) {
			throw usageError("qa takes no positional arguments");
		}
		required(options, "run");
		const runPath = path.resolve(options.run);
		if (!fs.existsSync(path.join(runPath, "manifest.json"))) {
			throw new SdpError("read-failed", "the run directory has no manifest.json");
		}
		const { report } = writeStructuralQa(runPath);
		const exitCode = report.verdict === "fail" ? EXIT.FAILED : report.verdict === "blocked" ? EXIT.BLOCKED : EXIT.OK;
		return { exitCode, document: report };
	},

	async setup({ positional }) {
		const [mode, ...extra] = positional;
		if ((mode !== "check" && mode !== "install") || extra.length) {
			throw usageError("setup takes exactly one of: check, install");
		}
		if (mode === "check") {
			const result = checkToolchain();
			return { exitCode: result.ready ? EXIT.OK : EXIT.BLOCKED, document: result };
		}
		const result = await installToolchain({ log: (line) => process.stderr.write(`sdp setup: ${line}\n`) });
		if (!result.installed) {
			return { exitCode: EXIT.BLOCKED, document: { ok: false, error: { code: "blocked", message: result.blocked } } };
		}
		return { exitCode: result.check.ready ? EXIT.OK : EXIT.FAILED, document: result.check };
	},

	async calibrate({ options, positional }) {
		if (positional.length) {
			throw usageError("calibrate takes no positional arguments");
		}
		if ((options.scope ?? "export") !== "export") {
			throw usageError("--scope must be export (this package has no audio-route calibration; interaction media come from run-local helpers)");
		}
		const tools = requireTools(["ffmpeg", "ffprobe", "python", "voiceModel"]);
		if (!tools.ok) {
			return { exitCode: EXIT.BLOCKED, document: { ok: false, error: { code: "blocked", message: tools.reason } } };
		}
		const runDir = freshRunDir(options["runs-dir"] ?? path.join(SKILL_ROOT, ".runs"), "calibrate");
		const { calibrateExport } = await import("./lib/export-check.mjs");
		let result;
		try {
			result = await calibrateExport({ runDir, paths: tools.paths, log: (line) => process.stderr.write(`sdp calibrate: ${line}\n`) });
		} catch (error) {
			// A calibration that cannot complete is a failed measurement, not a crash.
			return { exitCode: EXIT.FAILED, document: { passed: false, runDir, error: { code: "calibration-failed", message: String(error.message).slice(0, 2000) } } };
		}
		return {
			exitCode: result.passed ? EXIT.OK : EXIT.FAILED,
			document: { passed: result.passed, runDir, checks: result.checks.map(({ name, pass }) => ({ name, pass })), measurements: path.join(runDir, "calibration.json") },
		};
	},

	produce: (args) => produceCommand(args),
	export: (args) => produceCommand(args),
};

async function feasibilityCommand({ options, positional }) {
	if (positional.length) {
		throw usageError("feasibility takes no positional arguments");
	}
	required(options, "plan", "catalog", "confirm-plan-sha256");
	const { plan, catalog, errors, sha256, planDir } = loadPlan(options);
	if (errors.length) {
		return { exitCode: EXIT.FAILED, document: { ok: false, error: { code: "invalid-plan", message: "the demo plan is not valid; run `sdp plan`" }, errors } };
	}
	if (options["confirm-plan-sha256"] !== sha256) {
		return { exitCode: EXIT.BLOCKED, document: { ok: false, status: "blocked", error: { code: "confirmation-mismatch", message: "the confirmation does not match the exact approved demo plan" }, sha256 } };
	}
	const assessment = assessBrowserScene(plan);
	if (assessment.status !== "supported") {
		return { exitCode: EXIT.BLOCKED, document: assessment };
	}
	const browserRuntime = browserRuntimeFor(plan.storyboard);
	const controller = new globalThis.AbortController();
	const onSignal = () => controller.abort();
	process.once("SIGINT", onSignal);
	process.once("SIGTERM", onSignal);
	try {
		const result = await runFeasibility({
			plan,
			catalog,
			planDir,
			confirmedPlanSha256: sha256,
			browserRuntime,
			runId: options["run-id"],
			signal: controller.signal,
		});
		return { exitCode: result.exitCode, document: result };
	} finally {
		process.removeListener("SIGINT", onSignal);
		process.removeListener("SIGTERM", onSignal);
	}
}

async function produceCommand({ options, positional }) {
	if (positional.length) {
		throw usageError("produce takes no positional arguments");
	}
	required(options, "run", "calibration");
	const runPath = path.resolve(options.run);
	const storyboardFile = path.join(runPath, "contracts", "storyboard.json");
	if (!fs.existsSync(storyboardFile)) {
		throw new SdpError("read-failed", "the run directory has no recorded storyboard");
	}
	const audience = options.audience ?? readJsonFile(storyboardFile, "recorded storyboard").audiences?.[0];
	if (audience !== "business" && audience !== "engineering") {
		throw usageError("--audience must be business or engineering");
	}
	const tools = requireTools(["ffmpeg", "ffprobe", "python", "voiceModel"]);
	if (!tools.ok) {
		return { exitCode: EXIT.BLOCKED, document: { ok: false, error: { code: "blocked", message: tools.reason } } };
	}
	try {
		chromiumExecutable(tools.paths);
	} catch (error) {
		return { exitCode: EXIT.BLOCKED, document: { ok: false, error: { code: "blocked", message: error.message } } };
	}
	const { checkProducible, produce } = await import("./lib/produce.mjs");
	const calibrationFile = path.resolve(options.calibration);
	const precheck = checkProducible({ runPath, calibrationFile, audience });
	if (precheck.reasons.length) {
		return { exitCode: EXIT.BLOCKED, document: { ok: false, error: { code: "blocked", message: "the run cannot be exported yet", details: precheck.reasons } } };
	}
	const outDir = freshRunDir(options["runs-dir"] ?? path.join(SKILL_ROOT, ".runs"), `produce-${audience}`);
	let result;
	try {
		result = await produce({ runPath, calibrationFile, audience, outDir, paths: tools.paths, log: (line) => process.stderr.write(`sdp produce: ${line}\n`) });
	} catch (error) {
		return { exitCode: EXIT.FAILED, document: { ok: false, outDir, error: { code: "produce-failed", message: String(error.message).slice(0, 2000) } } };
	}
	if (result.blocked) {
		return { exitCode: EXIT.BLOCKED, document: { ok: false, outDir, error: { code: "blocked", message: "the run cannot be exported yet", details: result.blocked } } };
	}
	const { exportManifest } = result;
	return {
		exitCode: exportManifest.verdict === "structural-pass" ? EXIT.OK : EXIT.FAILED,
		document: {
			verdict: exportManifest.verdict,
			outDir,
			exportManifest: path.join(outDir, "export-manifest.json"),
			durationMs: exportManifest.durationMs,
			files: exportManifest.files.filter((file) => file.role === "export-video" || file.role === "captions"),
			checks: exportManifest.checks,
		},
	};
}

/**
 * The approved-plan path: plan check, approval match, spend bound, helpers,
 * preflight, run (bounded by the plan's maxRunSeconds), QA, calibration when
 * none is given, one export per audience and a coverage report.
 */
async function demoCommand({ options, positional }) {
	if (positional.length) {
		throw usageError("demo takes no positional arguments");
	}
	required(options, "confirm-plan-sha256");
	const maxSpend = options["max-spend-usd"] === undefined ? undefined : dollars(options["max-spend-usd"], "max-spend-usd");
	const { plan, catalog, errors, sha256, planDir } = loadPlan(options);
	const blocked = (code, message, extra = {}) => ({ exitCode: EXIT.BLOCKED, document: { ok: false, error: { code, message }, ...extra } });
	if (errors.length) {
		return { exitCode: EXIT.FAILED, document: { ok: false, sha256, error: { code: "invalid-plan", message: "the demo plan is not valid; run `sdp plan`" }, errors } };
	}
	if (options["confirm-plan-sha256"] !== sha256) {
		return blocked("confirmation-mismatch", "the confirmed sha256 does not match this plan; review the plan summary and confirm its exact sha256", { sha256 });
	}
	if (plan.estimate.cloud && maxSpend !== undefined && maxSpend < plan.estimate.amountUsd) {
		return blocked("estimate-over-limit", `the approved plan estimates US$${plan.estimate.amountUsd}, above the optional --max-spend-usd ${maxSpend} you set`);
	}
	const { featureCoverage, loadHelpers } = await import("./lib/demo-plan.mjs");
	const helpers = loadHelpers(plan, planDir);
	if (helpers.reasons.length) {
		return blocked("helpers-not-approved", "a helper file is missing or differs from the approved one", { details: helpers.reasons });
	}
	const { deriveAuthorization } = await import("./lib/contracts.mjs");
	const authorization = deriveAuthorization(plan);
	const { storyboard } = plan;
	const browserRuntime = browserRuntimeFor(storyboard);
	const check = preflight({ catalog, storyboard, authorization, browserRuntime });
	if (check.verdict !== "ready") {
		return blocked("preflight-blocked", "the plan cannot run on this machine yet", { preflight: check });
	}
	const tools = requireTools(["ffmpeg", "ffprobe", "python", "voiceModel"]);
	if (!tools.ok) {
		return blocked("blocked", tools.reason);
	}
	const log = (line) => process.stderr.write(`sdp demo: ${line}\n`);
	// One deadline and one Ctrl-C/SIGTERM handler cover the whole run:
	// recording, calibration and every audience's export.
	const controller = new globalThis.AbortController();
	const onSignal = () => controller.abort();
	const runSignal = globalThis.AbortSignal.any([controller.signal, globalThis.AbortSignal.timeout(plan.estimate.maxRunSeconds * 1000)]);
	process.once("SIGINT", onSignal);
	process.once("SIGTERM", onSignal);
	try {
		return await approvedDemo({ plan, sha256, storyboard, catalog, authorization, browserRuntime, helpers, featureCoverage, tools, options, log, controller, runSignal });
	} finally {
		process.removeListener("SIGINT", onSignal);
		process.removeListener("SIGTERM", onSignal);
	}
}

/** The run, QA, calibration and exports of demoCommand, all bounded by runSignal. */
async function approvedDemo({ plan, sha256, storyboard, catalog, authorization, browserRuntime, helpers, featureCoverage, tools, options, log, controller, runSignal }) {
	log(`running the approved plan (stopped after ${plan.estimate.maxRunSeconds} s)`);
	const result = await runDemo({
		catalog,
		storyboard,
		authorization,
		browserRuntime,
		workspaceSeed: helpers.seed,
		confirmAuthorizationSha256: contentSha256(authorization),
		signal: runSignal,
	});
	const outDir = path.join(path.dirname(result.runPath), `${result.runId}-demo`);
	fs.mkdirSync(outDir, { mode: 0o700 });
	const events = readEvents(path.join(result.runPath, "events.jsonl"));
	const coverage = featureCoverage(plan, events);
	const report = {
		planSha256: sha256,
		runId: result.runId,
		runPath: result.runPath,
		status: result.status,
		failures: result.manifest.failures ?? [],
		coverage,
		exports: [],
		humanReview: "required: watch and listen to every exported file in full before sharing it",
	};
	const finish = (exitCode) => {
		writeJsonExclusive(path.join(outDir, "demo-report.json"), report);
		return { exitCode, document: { ...report, report: path.join(outDir, "demo-report.json") } };
	};
	// A stop during media production keeps no partial output: the stage's
	// directory is removed and the report says what was stopped and why.
	const cancelled = (during, partialDir) => {
		if (partialDir) {
			fs.rmSync(partialDir, { recursive: true, force: true });
		}
		report.verdict = "cancelled";
		report.cancelled = { during, by: controller.signal.aborted ? "interrupt" : "time-limit" };
		return finish(EXIT.FAILED);
	};
	if (result.status !== "completed") {
		report.verdict = "run-failed";
		return finish(EXIT.FAILED);
	}
	const qa = writeStructuralQa(result.runPath).report;
	report.qa = { verdict: qa.verdict, open: qa.checks.filter((item) => item.status === "fail").map((item) => item.id) };
	if (qa.verdict === "fail") {
		report.verdict = "qa-failed";
		return finish(EXIT.FAILED);
	}
	let calibrationFile = options.calibration ? path.resolve(options.calibration) : null;
	if (!calibrationFile) {
		if (runSignal.aborted) {
			return cancelled("calibration", null);
		}
		log("checking the export profile");
		const { calibrateExport } = await import("./lib/export-check.mjs");
		const calibrationDir = path.join(outDir, "calibration");
		fs.mkdirSync(calibrationDir, { mode: 0o700 });
		try {
			const calibration = await withCancellation(runSignal, () => calibrateExport({ runDir: calibrationDir, paths: tools.paths, log }));
			if (runSignal.aborted) {
				return cancelled("calibration", calibrationDir);
			}
			calibrationFile = path.join(calibrationDir, "calibration.json");
			if (!calibration.passed) {
				report.verdict = "calibration-failed";
				report.calibration = calibrationFile;
				// Name the failed checks so the reason is visible without opening the file.
				report.calibrationFailures = (calibration.checks ?? []).filter((item) => !item.pass).map((item) => item.name);
				return finish(EXIT.FAILED);
			}
		} catch (error) {
			if (runSignal.aborted) {
				return cancelled("calibration", calibrationDir);
			}
			report.verdict = "calibration-failed";
			report.error = String(error.message).slice(0, 2000);
			return finish(EXIT.FAILED);
		}
	}
	report.calibration = calibrationFile;
	const { checkProducible, produce } = await import("./lib/produce.mjs");
	for (const audience of storyboard.audiences) {
		if (runSignal.aborted) {
			return cancelled("export", null);
		}
		const precheck = checkProducible({ runPath: result.runPath, calibrationFile, audience });
		if (precheck.reasons.length) {
			report.exports.push({ audience, verdict: "blocked", reasons: precheck.reasons });
			continue;
		}
		const exportDir = path.join(outDir, audience);
		try {
			const produced = await withCancellation(runSignal, () => produce({ runPath: result.runPath, calibrationFile, audience, outDir: exportDir, paths: tools.paths, voices: plan.voices, log }));
			if (runSignal.aborted) {
				return cancelled("export", exportDir);
			}
			if (produced.blocked) {
				report.exports.push({ audience, verdict: "blocked", reasons: produced.blocked });
				continue;
			}
			const manifest = produced.exportManifest;
			report.exports.push({
				audience,
				verdict: manifest.verdict,
				durationMs: manifest.durationMs,
				files: manifest.files.filter((file) => file.role === "export-video" || file.role === "captions").map((file) => ({ ...file, path: path.join(exportDir, file.path) })),
				failedChecks: manifest.checks.filter((item) => item.status !== "pass").map((item) => item.id),
				exportManifest: path.join(exportDir, "export-manifest.json"),
			});
		} catch (error) {
			if (runSignal.aborted) {
				return cancelled("export", exportDir);
			}
			report.exports.push({ audience, verdict: "fail", error: String(error.message).slice(0, 2000) });
		}
	}
	const ok = report.exports.length > 0 && report.exports.every((item) => item.verdict === "structural-pass");
	report.verdict = ok ? "ready-for-human-review" : "export-failed";
	return finish(ok ? EXIT.OK : EXIT.FAILED);
}

/** Creates a new, never-reused run directory named <kind>-<UTC>-<random>. */
function freshRunDir(parent, kind) {
	fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
	const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
	return fs.mkdtempSync(path.join(path.resolve(parent), `${kind}-${stamp}-`));
}

export async function main(argv) {
	const [command, ...rest] = argv;
	if (command === undefined || command === "--help" || command === "-h" || command === "help") {
		return { exitCode: command === undefined ? EXIT.USAGE : EXIT.OK, document: { usage: HELP } };
	}
	if (Object.hasOwn(NOT_IMPLEMENTED, command)) {
		return {
			exitCode: EXIT.BLOCKED,
			document: { ok: false, error: { code: "not-implemented", command, message: NOT_IMPLEMENTED[command] } },
		};
	}
	if (Object.hasOwn(MOVED, command)) {
		return { exitCode: EXIT.USAGE, document: { ok: false, error: { code: "usage", command, message: `${command} is not a separate command: ${MOVED[command]}` }, usage: HELP } };
	}
	if (!Object.hasOwn(COMMANDS, command)) {
		return { exitCode: EXIT.USAGE, document: { ok: false, error: { code: "usage", message: `unknown command ${command}` }, usage: HELP } };
	}
	try {
		return await COMMANDS[command](parseArgs(command, rest));
	} catch (error) {
		if (error instanceof SdpError) {
			return {
				exitCode: error.exitCode,
				document: { ok: false, error: { code: error.code, message: error.message, ...(error.details !== undefined ? { details: error.details } : {}) } },
			};
		}
		return { exitCode: EXIT.FAILED, document: { ok: false, error: { code: "internal", message: "unexpected internal error" } } };
	}
}

// Compare decoded, resolved file paths: URL.pathname keeps percent-escapes
// (a space is "%20"), which would silently skip every command.
function isMainModule() {
	if (!process.argv[1]) {
		return false;
	}
	const self = fileURLToPath(import.meta.url);
	const invoked = path.resolve(process.argv[1]);
	if (invoked === self) {
		return true;
	}
	try {
		return fs.realpathSync(invoked) === fs.realpathSync(self);
	} catch {
		return false;
	}
}

const isMain = isMainModule();
if (isMain) {
	const { exitCode, document } = await main(process.argv.slice(2));
	process.stdout.write(`${JSON.stringify(document, null, "\t")}\n`);
	process.exitCode = exitCode;
}
