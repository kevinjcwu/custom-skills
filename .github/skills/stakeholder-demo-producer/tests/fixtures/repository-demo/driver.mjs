import { Buffer } from "node:buffer";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";
import { clearTimeout, setTimeout } from "node:timers";
import { fileURLToPath } from "node:url";
import { capturePageScript } from "./capture-page.mjs";
import { exportReview } from "../../../scripts/lib/review-export.mjs";
import {
	readPageResult,
	saveOriginalBlob,
} from "../../../scripts/lib/recording.mjs";
import { launchBrowser } from "../../../scripts/lib/browser.mjs";
import { runHelper } from "../../../scripts/lib/helper-adapter.mjs";
import { ProcRegistry } from "../../../scripts/lib/proc-registry.mjs";
import {
	checkToolchain,
	requireTools,
	sha256File,
} from "../../../scripts/lib/toolchain.mjs";

const FIXTURE = path.dirname(fileURLToPath(import.meta.url));
const CLEANUP_RESERVE_MS = 5000;

function verifyInputs({ files, expectedHashes }) {
	for (const [name, file] of Object.entries(files)) {
		if (sha256File(file) !== expectedHashes[name]) {
			throw new Error(`approved fixture input changed before spawn: ${name}`);
		}
	}
}

function bounded(promise, signal) {
	if (signal.aborted)
		return Promise.reject(signal.reason ?? new Error("hard deadline reached"));
	return new Promise((resolve, reject) => {
		const onAbort = () =>
			reject(signal.reason ?? new Error("hard deadline reached"));
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

export async function runFixtureDemo({
	outDir,
	inputFile,
	expectedHashes,
	helperMode = "done",
	actionTimeoutMs = 5000,
	hardDeadlineMs = 30000,
	finalizeDelayMs = 0,
	paths: suppliedPaths,
	makeExport = true,
}) {
	const startedAt = performance.now();
	const startedAtUtc = new Date().toISOString();
	const preflightStartedAt = performance.now();
	if (
		!Number.isSafeInteger(hardDeadlineMs) ||
		hardDeadlineMs <= CLEANUP_RESERVE_MS ||
		!Number.isSafeInteger(actionTimeoutMs) ||
		actionTimeoutMs < 1 ||
		actionTimeoutMs >= hardDeadlineMs - CLEANUP_RESERVE_MS
	) {
		throw new Error(
			"fixture action and hard deadlines must leave a bounded cleanup reserve",
		);
	}
	const files = {
		startup: path.join(FIXTURE, "index.html"),
		helper: path.join(FIXTURE, "interaction-helper.mjs"),
		pageScript: path.join(FIXTURE, "capture-page.mjs"),
		input: inputFile,
	};
	verifyInputs({ files, expectedHashes });
	const runtimeRoot = suppliedPaths?.root ?? process.env.SDP_RUNTIME_DIR;
	if (
		!runtimeRoot ||
		sha256File(path.join(runtimeRoot, "installed.json")) !==
			expectedHashes.runtime
	) {
		throw new Error("approved pinned runtime identity changed before spawn");
	}
	const toolchain = suppliedPaths
		? { ok: true, paths: suppliedPaths }
		: requireTools(
				["playwrightCore", "ffmpeg", "ffprobe", "python", "voiceModel"],
				runtimeRoot,
			);
	if (!toolchain.ok)
		throw new Error(`pinned runtime unavailable: ${toolchain.reason}`);
	const verification = checkToolchain(runtimeRoot);
	if (!verification.ready)
		throw new Error(
			`pinned runtime verification failed: ${JSON.stringify(verification.items.filter((item) => item.status !== "verified"))}`,
		);
	const preflightMs = Math.round(performance.now() - preflightStartedAt);
	const paths = toolchain.paths;
	const html = fs.readFileSync(files.startup, "utf8");
	const pageSource = capturePageScript;
	fs.mkdirSync(outDir, { recursive: false, mode: 0o700 });
	for (const name of ["originals", "exports", "browser"])
		fs.mkdirSync(path.join(outDir, name), { mode: 0o700 });
	const events = [];
	const record = (event) => {
		const item = { event, tMs: Math.round(performance.now() - startedAt) };
		events.push(item);
		return item.tMs;
	};
	const registry = new ProcRegistry({
		logFile: path.join(outDir, "processes.jsonl"),
	});
	const interaction = new globalThis.AbortController();
	const hard = new globalThis.AbortController();
	const hardDeadlineAt = Date.now() + hardDeadlineMs;
	const workDeadlineAt = hardDeadlineAt - CLEANUP_RESERVE_MS;
	const hardTimer = setTimeout(
		() => {
			record("hard-deadline-reached");
			hard.abort(
				new Error("fixture hard deadline reached; cleanup reserve remains"),
			);
		},
		Math.max(0, workDeadlineAt - Date.now()),
	);
	let browser;
	let result;
	let page;
	let original;
	let screenVideo;
	let exported = null;
	let payload = null;
	let payloadError = null;
	let failureAtMs = null;
	let productionStartMs = null;
	let productionEndMs = null;
	let stop = "complete";
	try {
		verifyInputs({ files, expectedHashes });
		productionStartMs = Math.round(performance.now() - startedAt);
		browser = await launchBrowser({
			paths,
			dir: path.join(outDir, "browser"),
			registry,
			origins: [],
			recordVideo: true,
			id: "fixture-browser",
			signal: hard.signal,
		});
		page = await browser.context.newPage();
		await page.setContent(html);
		await page.waitForTimeout(100);
		record("journey-start");
		const helperEntry = path.join(outDir, "helper-output");
		fs.mkdirSync(helperEntry, { mode: 0o700 });
		const helperHome = path.join(outDir, "browser", "helper-home");
		const helperTmp = path.join(outDir, "browser", "helper-tmp");
		fs.mkdirSync(helperHome, { mode: 0o700 });
		fs.mkdirSync(helperTmp, { mode: 0o700 });
		verifyInputs({ files, expectedHashes });
		const inputText = fs.readFileSync(files.input, "utf8");
		record("helper-start");
		result = await runHelper({
			registry,
			id: "fixture-interaction",
			executable: process.execPath,
			argv: [files.helper, helperMode, inputText],
			cwd: FIXTURE,
			env: {
				PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
				HOME: helperHome,
				TMPDIR: helperTmp,
				PYTHONDONTWRITEBYTECODE: "1",
			},
			outDir: helperEntry,
			interaction: { needs: ["browser-page"], media: [] },
			pageScripts: new Map([["fixture.capture", pageSource]]),
			page,
			action: { id: "fixture.upload" },
			timeoutMs: actionTimeoutMs,
			killGraceMs: 200,
			maxOutputBytes: 65536,
			signal: interaction.signal,
			now: () => performance.now(),
		});
		fs.writeFileSync(
			path.join(helperEntry, "interaction-result.json"),
			`${JSON.stringify(
				{
					outcome: result.outcome,
					claimed: result.claimed,
					detail: result.detail,
					error: result.error,
					transcript: result.transcript,
					pageCalls: result.pageCalls,
				},
				null,
				"\t",
			)}\n`,
			{ flag: "wx" },
		);
		const interactionResultMs = record(`interaction-${result.outcome}`);
		if (result.outcome !== "done") {
			stop = result.outcome;
			failureAtMs = interactionResultMs;
			interaction.abort(new Error(`stop after ${result.outcome}`));
		}
		if (result.transcript.some((entry) => entry.message?.type === "page")) {
			try {
				payload = readPageResult(result, {
					script: "fixture.capture",
					callId: "fixture-upload-1",
				});
			} catch (error) {
				payloadError = error.message;
				record("page-result-missing");
			}
		}
		record("finalization-start");
		const flush = (async () => {
			if (finalizeDelayMs > 0)
				await new Promise((resolve) => setTimeout(resolve, finalizeDelayMs));
			const size = await page.evaluate(`(${pageSource})({op:"size"})`);
			const response = await page.evaluate(`(${pageSource})({op:"bytes"})`);
			const bytes = Buffer.from(response.bytes);
			original = await saveOriginalBlob({
				readBlob: async () => bytes,
				outDir: path.join(outDir, "originals"),
				file: "capture.original",
				expectedBytes: size.bytes,
				maxBytes: 1024 * 1024,
			});
		})();
		await bounded(flush, hard.signal);
		record("original-flushed");
		record("browser-close-start");
		const closed = await bounded(browser.close(), hard.signal);
		browser = null;
		screenVideo = closed.videos[0] ?? null;
		record("browser-closed");
		productionEndMs = Math.round(performance.now() - startedAt);
		if (closed.videos.length !== 1)
			throw new Error("browser did not preserve exactly one screen recording");
		if (makeExport) {
			const complete = result.outcome === "done";
			record("export-start");
			const exportHome = path.join(outDir, "browser", "export-home");
			const exportTmp = path.join(outDir, "browser", "export-tmp");
			const exportCache = path.join(outDir, "browser", "export-cache");
			for (const dir of [exportHome, exportTmp, exportCache])
				fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
			exported = await exportReview({
				outDir: path.join(outDir, "exports"),
				screenVideo: closed.videos[0],
				paths,
				env: {
					PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
					HOME: exportHome,
					TMPDIR: exportTmp,
					PYTHONDONTWRITEBYTECODE: "1",
					PYTHONNOUSERSITE: "1",
					XDG_CACHE_HOME: exportCache,
					LANG: "C.UTF-8",
				},
				intro: "This synthetic fixture shows importing a text file.",
				outro: complete
					? "The fixture displayed the imported text."
					: "This take is incomplete because the helper did not confirm the interaction.",
				status: complete ? "complete" : "incomplete",
				limitations: complete
					? [
							"Synthetic fixture output is not evidence about another application.",
						]
					: [
							`The helper outcome was ${result.outcome}; this is not a successful product interaction.`,
						],
				deadlineMs: Math.max(1, workDeadlineAt - Date.now()),
				signal: hard.signal,
			});
			record("review-exported");
		}
	} catch (error) {
		if (stop === "complete") stop = "failed";
		failureAtMs ??= record(`failure-${error.message}`);
		throw error;
	} finally {
		if (browser) {
			try {
				await browser.close();
			} catch (error) {
				record(`browser-close-error-${error.message}`);
			}
		}
		await registry.stopAll(500);
		record("owned-process-cleanup");
		clearTimeout(hardTimer);
		fs.writeFileSync(
			path.join(outDir, "fixture-result.json"),
			`${JSON.stringify(
				{
					status:
						stop === "complete"
							? "complete"
							: stop === "failed"
								? "failed"
								: "incomplete",
					helperOutcome: result?.outcome ?? null,
					inputHashes: expectedHashes,
					startedAtUtc,
					timings: {
						preflightVerificationMs: preflightMs,
						productionMs:
							productionStartMs === null || productionEndMs === null
								? null
								: productionEndMs - productionStartMs,
						endToEndMs: Math.round(performance.now() - startedAt),
						humanApprovalWaitMs: null,
						reasoningMs: null,
						failureTurnaroundMs: failureAtMs,
						exportMs:
							events.some((event) => event.event === "export-start") &&
							events.some((event) => event.event === "review-exported")
								? events.find((event) => event.event === "review-exported")
										.tMs -
									events.find((event) => event.event === "export-start").tMs
								: null,
					},
					screenVideo,
					screenVideoIdentity: screenVideo
						? {
								bytes: fs.statSync(screenVideo).size,
								sha256: sha256File(screenVideo),
							}
						: null,
					payloadBytes: payload?.text ? Buffer.byteLength(payload.text) : 0,
					payloadError,
					original,
					export: exported
						? {
								status: exported.report.status,
								mp4: exported.output,
								vtt: exported.captions,
							}
						: null,
					events,
					survivors: registry.survivors(),
					review: "synthetic fixture only; not human-reviewed",
				},
				null,
				"\t",
			)}\n`,
			{ flag: "wx" },
		);
	}
	return {
		result,
		payload,
		original,
		exported,
		events,
		survivors: registry.survivors(),
		stop,
	};
}
