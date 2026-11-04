// Demo plan helpers for `sdp plan` and `sdp demo`: the readable summary a
// human approves, approved helper files, and the feature coverage report.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_VOICES } from "./produce.mjs";
import { SKILL_ROOT } from "./toolchain.mjs";

export const SKILL_HELPERS_DIR = path.join(SKILL_ROOT, "scripts", "helpers");
const MAX_HELPER_BYTES = 1024 * 1024;

/**
 * Resolves a helpers folder that must be a real directory directly under
 * root: a symlinked folder (or ancestor link) pointing elsewhere is refused
 * before any helper file is read.
 * @returns {{real?: string, error?: string}}
 */
function helperDir(root, rel) {
	try {
		const realRoot = fs.realpathSync(root);
		const candidate = path.join(realRoot, rel);
		const stat = fs.lstatSync(candidate);
		if (stat.isSymbolicLink() || !stat.isDirectory()) {
			return { error: "is not a real directory (links are refused)" };
		}
		if (fs.realpathSync(candidate) !== candidate) {
			return { error: "resolves outside its approved location" };
		}
		return { real: candidate };
	} catch {
		return { error: "is missing" };
	}
}

/**
 * Reads every helper the plan names and checks its sha256. Returns the
 * workspace seed for the run, or the reasons it cannot be used.
 *
 * @param {object} plan
 * @param {string} planDir directory holding the plan file
 * @returns {{seed: {rel: string, bytes: Buffer, sha256: string}[], reasons: string[]}}
 */
export function loadHelpers(plan, planDir) {
	const seed = [];
	const reasons = [];
	const dirs = { skill: helperDir(SKILL_ROOT, path.join("scripts", "helpers")), plan: helperDir(planDir, "helpers") };
	for (const helper of plan.helpers) {
		const folder = helper.source === "skill" ? "skill's scripts/helpers" : "plan's helpers";
		const dir = dirs[helper.source === "skill" ? "skill" : "plan"];
		if (dir.error) {
			reasons.push(`helper ${helper.id}: the ${folder} folder ${dir.error}`);
			continue;
		}
		if (path.basename(helper.file) !== helper.file) {
			reasons.push(`helper ${helper.id}: ${helper.file} is not a plain file name`);
			continue;
		}
		const file = path.join(dir.real, helper.file);
		let bytes;
		try {
			const stat = fs.lstatSync(file);
			if (!stat.isFile()) {
				reasons.push(`helper ${helper.id}: ${helper.file} is not a regular file`);
				continue;
			}
			if (stat.size > MAX_HELPER_BYTES) {
				reasons.push(`helper ${helper.id}: ${helper.file} is larger than ${MAX_HELPER_BYTES} bytes`);
				continue;
			}
			bytes = fs.readFileSync(file);
		} catch {
			reasons.push(`helper ${helper.id}: ${helper.file} is missing from the ${folder} folder`);
			continue;
		}
		const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
		if (sha256 !== helper.sha256) {
			reasons.push(`helper ${helper.id}: ${helper.file} has sha256 ${sha256}, not the approved ${helper.sha256}`);
			continue;
		}
		seed.push({ rel: `helpers/${helper.file}`, bytes, sha256 });
	}
	return { seed, reasons };
}

/**
 * Which features the run actually showed: a feature is observed when every
 * action of at least one of its scenes passed.
 *
 * @param {object} plan
 * @param {object[]} events run events
 */
export function featureCoverage(plan, events) {
	const passed = new Set(events.filter((event) => event.type === "action.attempt" && event.disposition === "ok").map((event) => event.actionId));
	const scenes = new Map(plan.storyboard.scenes.map((scene) => [scene.id, scene]));
	return plan.features.map((feature) => {
		if (feature.omitted) {
			return { capability: feature.capability, status: "omitted", reason: feature.omitted.reason };
		}
		const shownIn = feature.scenes.filter((id) => scenes.get(id).actions.every((action) => passed.has(action.id)));
		const viaHelper = shownIn.some((id) => scenes.get(id).actions.some((action) => action.op === "helper"));
		return shownIn.length
			? {
					capability: feature.capability,
					status: "observed",
					scenes: shownIn,
					// A helper's pass means its own claim plus the run's structural checks; it does not prove what the app did.
					...(viaHelper ? { basis: "includes run-local helper actions: the helper reported done, exited 0, its media checked out and the expected page text newly appeared; this does not prove the app's reply belonged to the helper's action" } : {}),
				}
			: { capability: feature.capability, status: "planned-not-observed", scenes: feature.scenes, reason: "no planned scene for it completed every action" };
	});
}

const md = (text) => String(text).replace(/[\\`*_[\]<>|]/g, (char) => `\\${char}`);

function describeAction(action, runtime) {
	switch (action.op) {
		case "helper": {
			const interaction = runtime.interactions?.find((item) => item.id === action.ref);
			return `run helper ${md(action.ref)}${interaction ? ` (${md(interaction.purpose)})` : ""}${action.value !== undefined ? ` with input "${md(action.value)}"` : ""}`;
		}
		case "goto":
			return `open ${md(action.target)}`;
		case "click":
			return `click ${md(action.target)}`;
		case "fill":
			return `type "${md(action.value)}" into ${md(action.target)}`;
		case "press":
			return `press ${md(action.value)}`;
		case "wait":
			return `wait for ${md(action.target ?? action.value ?? "the page")}`;
		case "run":
			return `run command ${md(action.ref)}`;
		case "request": {
			const request = runtime.http?.requests?.find((item) => item.id === action.ref);
			return request ? `send ${md(request.method)} ${md(`${request.origin}${request.path}`)}` : `send request ${md(action.ref)}`;
		}
		default:
			return md(action.op);
	}
}

const commandLine = (runtime, command) => {
	const executable = runtime.bindings.executables.find((item) => item.id === command.executable)?.path ?? command.executable;
	return md([executable, ...command.argv].join(" "));
};

/**
 * The plain-language plan summary shown to the human before approval.
 *
 * @param {object} plan a valid demo plan
 * @param {{sha256: string, catalog: object, planFile: string}} context
 */
export function planSummary(plan, { sha256, catalog, planFile }) {
	const { storyboard, runtime, estimate } = plan;
	const voices = { ...DEFAULT_VOICES, ...plan.voices };
	const feasibilityScene = storyboard.scenes.find((scene) => scene.adapter === "browser");
	const interactions = runtime.interactions ?? [];
	const helperFiles = new Map(plan.helpers.map((helper) => [`helpers/${helper.file}`, helper]));
	const capabilities = new Map(catalog.capabilities.map((capability) => [capability.id, capability]));
	const lines = [];
	const out = (line = "") => lines.push(line);
	out(`# Demo plan: ${md(storyboard.title)}`);
	out();
	out(md(storyboard.goal));
	out();
	out(`Audiences: ${storyboard.audiences.join(", ")}. Plan sha256: \`${sha256}\`.`);
	out();
	out("## Voices");
	out();
	out(`- **${md(voices.narrator)}** explains what is on screen in every scene.`);
	const media = interactions.flatMap((interaction) => interaction.media);
	if (media.length) {
		for (const item of media) {
			out(`- **${md(item.label)}**: ${item.provenance === "generated" ? "made by this demo's run-local helper; it is never the app's own output" : "recorded by this demo's run-local helper; the run does not verify where it came from"}. Captions say so.`);
		}
		out("- The narrator never talks over helper media.");
	} else {
		out("- No other voices or sounds: only the narrator.");
	}
	if (feasibilityScene) {
		out();
		out("## Early browser feasibility");
		out();
		out(`- The first browser scene, **${md(feasibilityScene.title)}**, is the bounded essential-interaction check.`);
		out(`- \`sdp feasibility\` records only that scene (1–5 fixed browser actions, no interaction helpers) under this same approved plan sha256. Other scenes are explicitly skipped in its run record; it does not produce a final demo.`);
		out("- A microphone/device journey is not simulated. It may be omitted only when the approved story demonstrates a real browser-only outcome and names the omission.");
	}
	out();
	out("## Scenes");
	for (const [index, scene] of storyboard.scenes.entries()) {
		out();
		out(`### ${index + 1}. ${md(scene.title)} (${scene.adapter})${scene.id === feasibilityScene?.id ? " - early feasibility scene" : ""}`);
		out();
		for (const narration of scene.narration) {
			out(`- Narrator (${narration.audience}): "${md(narration.text)}"`);
		}
		for (const action of scene.actions) {
			out(`- ${describeAction(action, runtime)}`);
		}
		if (scene.diagram) {
			out("- Shows an architecture card.");
		}
	}
	out();
	out("## Features");
	out();
	for (const feature of plan.features) {
		const title = capabilities.get(feature.capability)?.title ?? feature.capability;
		out(feature.scenes ? `- Shown: ${md(title)} (scenes ${feature.scenes.join(", ")})` : `- Left out: ${md(title)}: ${md(feature.omitted.reason)}`);
	}
	out();
	out("## How the app runs");
	out();
	out(`- Target folder: \`${runtime.bindings.targetRoot}\` (read only; outputs go to the run's own workspace).`);
	out(`- Run outputs: \`${runtime.bindings.runDir}\`.`);
	if (runtime.browser) {
		const { service } = runtime.browser;
		out(`- App server: \`${commandLine(runtime, service)}\` in \`${md(service.cwd)}\`. The headless browser may only load the loopback address it reports.`);
	}
	for (const command of runtime.commands) {
		out(`- Command \`${md(command.id)}\`: \`${commandLine(runtime, command)}\` in \`${md(command.cwd)}\`.`);
	}
	out("- App processes are not network-sandboxed: they can reach whatever this machine can reach.");
	for (const helper of plan.helpers) {
		out(
			helper.source === "skill"
				? `- Existing helper \`${md(helper.file)}\` bundled with the skill, reused because it fits: ${md(helper.purpose)}`
				: `- New helper \`${md(helper.file)}\` written for this demo only (kept beside the plan, copied into the run workspace, never into the app or the skill): ${md(helper.purpose)}`,
		);
	}
	if (interactions.length) {
		out();
		out("## Run-local interaction helpers");
		out();
		out("The skill has no built-in support for these interactions; the agent wrote these helpers for this app after reading it. They run only inside this demo, from the approved files below.");
		for (const interaction of interactions) {
			out();
			out(`### ${md(interaction.id)}`);
			out();
			out(`- Purpose: ${md(interaction.purpose)}`);
			out(`- Runs: \`${commandLine(runtime, interaction)}\` in \`${md(interaction.cwd)}\`.`);
			const files = [...new Set([...interaction.argv.filter((arg) => arg.startsWith("{workspace}/helpers/")).map((arg) => arg.slice("{workspace}/".length)), ...interaction.pageScripts.map((script) => script.file)])];
			for (const file of files) {
				const helper = helperFiles.get(file);
				out(`- File \`${md(file)}\`${helper ? ` sha256 \`${helper.sha256}\`` : " (not a declared helper)"}.`);
			}
			out(interaction.needs.includes("browser-page")
				? `- May ask the run to evaluate its page scripts (${interaction.pageScripts.map((script) => md(script.id)).join(", ")}) in this demo's recorded page. It gets no browser connection of its own.`
				: "- No access to the recorded page.");
			out(interaction.media.length ? `- May report audio: ${interaction.media.map((item) => `${md(item.label)} (${item.provenance})`).join(", ")}.` : "- Reports no audio.");
			const passed = [...new Set(interaction.envPassthrough)];
			out(`- Environment: only ${interaction.env.length} fixed value(s)${passed.length ? ` and ${passed.map((name) => `\`${name}\``).join(", ")} from your environment` : ""}, plus SDP_OUT_DIR.`);
		}
		out();
		out("- Not a sandbox: a helper is a trusted program with your account's file and network access. SDP_OUT_DIR is only the place it is asked to write.");
		out("- A helper's own \"done\" is a claim. The run only passes its action when the helper also exits cleanly, its audio files check out and the expected page text newly appears; even then the run cannot prove the reply belongs to the helper's action.");
		out("- A helper that reports blocked or unknown stops the run as blocked; it is never shown as a success.");
	}
	out();
	out("## Outside services and cost");
	out();
	if (plan.externalDestinations.length) {
		for (const destination of plan.externalDestinations) {
			out(`- \`${md(destination.host)}\`: ${md(destination.purpose)}`);
		}
	} else {
		out("- None expected.");
	}
	out(estimate.cloud ? `- Estimated cost: up to US$${estimate.amountUsd} (${md(estimate.basis)}).` : `- No paid services (${md(estimate.basis)}).`);
	out(`- The whole run is stopped after ${estimate.maxRunSeconds} s; each action after ${runtime.limits.timeoutMs} ms.`);
	const services = [...runtime.commands, ...(runtime.browser ? [runtime.browser.service] : []), ...interactions];
	if (services.some((command) => command.envPassthrough.length)) {
		out(`- Passed through from your environment: ${[...new Set(services.flatMap((command) => command.envPassthrough))].map((name) => `\`${name}\``).join(", ")}.`);
	}
	out("- Sign-in: if the app needs one (for example Entra ID), sign in yourself before the run; the skill never asks for or stores credentials.");
	out();
	out("## What you get");
	out();
	out(`- One narrated MP4 with captions per audience (${storyboard.audiences.join(", ")}), with the plan's features shown or listed as left out.`);
	out("- A report of every check. Structural checks never replace your full watch-and-listen review.");
	out();
	out("## Approve");
	out();
	out("Reply that you approve this plan as it stands, or ask for changes (each change produces a new summary).");
	out("Nothing else is needed from you. After your approval the agent runs it, tied to exactly this plan:");
	out();
	out("```");
	out(`sdp demo --plan ${planFile} --catalog <catalog.json> --confirm-plan-sha256 ${sha256}`);
	out("```");
	return `${lines.join("\n")}\n`;
}
