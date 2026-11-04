// Contract loading and cross-field rules.
//
// The bundled schemas check shape; the rules here check what a schema
// cannot: unique ids, references that must resolve, the hash chain between
// documents, and the claim rules (inferred or unknown claims are never
// asserted, narration must point at backed claims).
import fs from "node:fs";
import path from "node:path";
import { Buffer } from "node:buffer";
import { fileURLToPath, URL } from "node:url";
import { compileSchema } from "./schema-validator.mjs";
import { contentSha256 } from "./canonical.mjs";
import { SdpError } from "./errors.mjs";
import { findLeaks, relativeRefErrors } from "./paths.mjs";

const SCHEMA_DIR = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"schemas",
);

export const CONTRACT_NAMES = Object.freeze([
	"capability-catalog",
	"storyboard",
	"run-authorization",
	"preflight",
	"adapter-descriptor",
	"event",
	"artifact-manifest",
	"claim-ledger",
	"qa-report",
	"export-manifest",
	"demo-plan",
]);

/** Classes that may be narrated as true. inferred and unknown never are. */
export const ASSERTABLE_CLASSES = Object.freeze([
	"fact",
	"observed",
	"source-backed",
	"documented",
]);

const ADAPTER_OPS = Object.freeze({
	process: ["run"],
	http: ["request"],
	// helper: starts an approved run-local interaction helper (helper-adapter.mjs) on the recorded page.
	browser: ["goto", "click", "fill", "press", "wait", "helper"],
});

/** Environment names the run sets for an interaction helper; an authorization may not set them. */
export const HELPER_RESERVED_ENV = Object.freeze(["SDP_OUT_DIR"]);

/** Workspace folder that holds approved helper files. */
export const HELPER_DIR = "helpers/";

const ADAPTER_CHECKS = Object.freeze({
	process: { exitCode: "integer", stdoutIncludes: "string", stderrIncludes: "string" },
	http: { status: "integer", bodyIncludes: "string" },
	// pageIncludesNew: the text occurs more often after the action than in the page text read just before it.
	browser: { pageIncludes: "string", pageExcludes: "string", pageIncludesNew: "string" },
});

/** Accessible roles a browser click may target ("role:name"). */
export const BROWSER_ROLES = Object.freeze(["button", "link", "tab", "checkbox", "radio", "menuitem", "option", "row", "cell", "heading"]);

/** Token by which argv may refer to the run workspace directory. */
export const WORKSPACE_TOKEN = "{workspace}";

/** Problems with one browser action, or [] (target/value rules per op). */
export function browserActionErrors(action) {
	const errors = [];
	const needsTarget = ["goto", "click", "fill", "wait"];
	if (needsTarget.includes(action.op) && action.target === undefined) {
		errors.push({ at: "/target", message: `op ${action.op} requires target` });
	}
	if ((action.op === "fill" || action.op === "press") && action.value === undefined) {
		errors.push({ at: "/value", message: `op ${action.op} requires value` });
	}
	if (action.ref !== undefined) {
		errors.push({ at: "/ref", message: "browser actions take no ref" });
	}
	if (action.op === "goto" && action.target !== undefined && !/^\/(?!\/)[^\s#\\]*$/.test(action.target)) {
		errors.push({ at: "/target", message: "goto target must be a path on the service origin, starting with a single /" });
	}
	if (action.op === "click" && action.target !== undefined) {
		const match = /^([a-z]+):(.+)$/.exec(action.target);
		if (!match || !BROWSER_ROLES.includes(match[1])) {
			errors.push({ at: "/target", message: `click target must be "<role>:<accessible name>" with role one of ${BROWSER_ROLES.join(", ")}` });
		}
	}
	if (action.op === "press" && action.value !== undefined && !/^[A-Za-z0-9+]{1,32}$/.test(action.value)) {
		errors.push({ at: "/value", message: "press value must be a key name such as Enter or Tab" });
	}
	return errors;
}

/** Problems with one helper action, or []: ref names the authorized interaction; value is passed to it. */
export function helperActionErrors(action) {
	const errors = [];
	if (action.ref === undefined) {
		errors.push({ at: "/ref", message: "op helper requires ref (an authorized interaction id)" });
	}
	if (action.target !== undefined) {
		errors.push({ at: "/target", message: "helper actions take no target; pass input to the helper in value" });
	}
	return errors;
}

/** Problems with a {workspace} argv reference, or [] for ordinary arguments. */
export function workspaceArgErrors(arg, hasWorkspace) {
	if (!arg.includes("{workspace")) {
		return [];
	}
	if (!hasWorkspace) {
		return ["{workspace} needs an authorization workspace section"];
	}
	if (arg === WORKSPACE_TOKEN) {
		return [];
	}
	if (!arg.startsWith(`${WORKSPACE_TOKEN}/`)) {
		return ["{workspace} may only start an argument, as {workspace} or {workspace}/<relative path>"];
	}
	return relativeRefErrors(arg.slice(WORKSPACE_TOKEN.length + 1)).map((message) => `path after {workspace}/ ${message}`);
}

const FORBIDDEN_HEADERS = new Set([
	"authorization",
	"proxy-authorization",
	"cookie",
	"host",
	"content-length",
	"transfer-encoding",
	"connection",
]);

const compiled = new Map();

export function loadSchema(name) {
	if (!CONTRACT_NAMES.includes(name)) {
		throw new SdpError("unknown-contract", `unknown contract: ${name}`);
	}
	return JSON.parse(
		fs.readFileSync(path.join(SCHEMA_DIR, `${name}.v1.json`), "utf8"),
	);
}

function validatorFor(name) {
	if (!compiled.has(name)) {
		compiled.set(
			name,
			compileSchema(loadSchema(name), {
				allowApprovedAbsolute: name === "run-authorization",
			}),
		);
	}
	return compiled.get(name);
}

/** Derives the contract name from a document's "schema" field. */
export function contractNameOf(doc) {
	if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
		return null;
	}
	const match = /^([a-z-]+)\.v1$/.exec(String(doc.schema ?? ""));
	return match && CONTRACT_NAMES.includes(match[1]) ? match[1] : null;
}

class Collector {
	constructor() {
		this.errors = [];
	}

	add(at, message) {
		this.errors.push({ path: at || "/", message });
	}

	unique(items, at, key = "id") {
		const seen = new Map();
		const ids = new Set();
		(items ?? []).forEach((item, index) => {
			const value = item?.[key];
			if (seen.has(value)) {
				this.add(
					`${at}/${index}/${key}`,
					`duplicate ${key} "${value}" (first at ${at}/${seen.get(value)})`,
				);
			} else {
				seen.set(value, index);
				ids.add(value);
			}
		});
		return ids;
	}

	refs(values, known, at, what) {
		for (const [index, value] of asList(values).entries()) {
			if (!known.has(value)) {
				this.add(
					Array.isArray(values) ? `${at}/${index}` : at,
					`unknown ${what} "${value}"`,
				);
			}
		}
	}
}

function asList(value) {
	if (value === undefined) {
		return [];
	}
	return Array.isArray(value) ? value : [value];
}

function compilePattern(pattern) {
	try {
		return new RegExp(pattern, "iu");
	} catch {
		return null;
	}
}

function catalogRules(doc, c) {
	const evidence = c.unique(doc.evidence, "/evidence");
	doc.evidence.forEach((item, index) => {
		const lines = item.ref.lines;
		if (lines && lines.end < lines.start) {
			c.add(`/evidence/${index}/ref/lines`, "end must not be before start");
		}
	});
	for (const [section, items] of Object.entries(doc.inventory)) {
		items.forEach((item, index) =>
			c.refs(item.evidence, evidence, `/inventory/${section}/${index}/evidence`, "evidence"),
		);
	}
	c.unique(doc.runCommands, "/runCommands");
	doc.runCommands.forEach((item, index) =>
		c.refs(item.evidence, evidence, `/runCommands/${index}/evidence`, "evidence"),
	);
	const platforms = c.unique(doc.platforms, "/platforms");
	doc.platforms.forEach((item, index) =>
		c.refs(item.evidence, evidence, `/platforms/${index}/evidence`, "evidence"),
	);
	c.unique(doc.capabilities, "/capabilities");
	doc.capabilities.forEach((item, index) => {
		const at = `/capabilities/${index}`;
		c.refs(item.evidence, evidence, `${at}/evidence`, "evidence");
		if (item.platform !== undefined) {
			c.refs(item.platform, platforms, `${at}/platform`, "platform");
		}
		if (item.provenance === "inventory" && item.class !== "fact") {
			c.add(`${at}/class`, "inventory-provenance capabilities must be class fact");
		}
		if (ASSERTABLE_CLASSES.includes(item.class) && item.evidence.length === 0) {
			c.add(`${at}/evidence`, `class ${item.class} requires evidence`);
		}
		if (!ASSERTABLE_CLASSES.includes(item.class) && item.reason === undefined) {
			c.add(`${at}/reason`, `class ${item.class} requires a reason`);
		}
	});
	const components = c.unique(doc.components, "/components");
	doc.components.forEach((item, index) =>
		c.refs(item.evidence, evidence, `/components/${index}/evidence`, "evidence"),
	);
	c.unique(doc.edges, "/edges");
	doc.edges.forEach((item, index) => {
		const at = `/edges/${index}`;
		c.refs(item.from, components, `${at}/from`, "component");
		c.refs(item.to, components, `${at}/to`, "component");
		c.refs(item.evidence, evidence, `${at}/evidence`, "evidence");
		if (ASSERTABLE_CLASSES.includes(item.class) && item.evidence.length === 0) {
			c.add(`${at}/evidence`, `class ${item.class} requires evidence`);
		}
	});
	c.unique(doc.forbiddenClaims, "/forbiddenClaims");
	doc.forbiddenClaims.forEach((item, index) => {
		if (!compilePattern(item.pattern)) {
			c.add(`/forbiddenClaims/${index}/pattern`, "is not a valid regular expression");
		}
	});
	c.unique(doc.unknowns, "/unknowns");
	c.unique(doc.skipped, "/skipped", "path");
}

function storyboardRules(doc, c, context) {
	const catalog = context.catalog;
	if (catalog && doc.catalogSha256 !== contentSha256(catalog)) {
		c.add("/catalogSha256", "does not match the canonical hash of the catalog");
	}
	const audiences = new Set(doc.audiences);
	c.unique(doc.clarifications, "/clarifications");
	const provenance = c.unique(doc.dataProvenance, "/dataProvenance");
	const provenanceById = new Map(doc.dataProvenance.map((item) => [item.id, item]));
	const claimIds = c.unique(doc.claims, "/claims");
	c.unique(doc.scenes, "/scenes");

	const actionIds = new Set();
	const expectIds = new Set();
	const narrationIds = new Set();
	const narratedClaims = new Set();
	const catalogEvidence = new Set(catalog?.evidence.map((item) => item.id));
	const catalogCapabilities = new Set(catalog?.capabilities.map((item) => item.id));
	const catalogEdges = new Set(catalog?.edges.map((item) => item.id));
	const forbidden = (catalog?.forbiddenClaims ?? [])
		.map((item) => ({ id: item.id, regex: compilePattern(item.pattern) }))
		.filter((item) => item.regex);
	const checkForbidden = (text, at) => {
		for (const rule of forbidden) {
			if (rule.regex.test(text)) {
				c.add(at, `matches forbidden claim "${rule.id}"`);
			}
		}
	};

	doc.scenes.forEach((scene, sceneIndex) => {
		const at = `/scenes/${sceneIndex}`;
		if (catalog) {
			c.refs(scene.capabilities, catalogCapabilities, `${at}/capabilities`, "capability");
		}
		c.refs(scene.dataProvenance, provenance, `${at}/dataProvenance`, "data provenance");
		scene.dataProvenance.forEach((id, index) => {
			const item = provenanceById.get(id);
			if (!item) {
				return;
			}
			if (item.kind === "forbidden") {
				c.add(`${at}/dataProvenance/${index}`, "forbidden data must not be used in a scene");
			}
			if (item.kind === "human-supplied" && !item.rightsConfirmed) {
				c.add(`${at}/dataProvenance/${index}`, "human-supplied data needs rightsConfirmed");
			}
			if (doc.confidentiality.onScreen === "synthetic-only" && item.kind !== "synthetic") {
				c.add(`${at}/dataProvenance/${index}`, "confidentiality is synthetic-only");
			}
		});
		const sceneActions = new Set();
		scene.actions.forEach((action, index) => {
			const actionAt = `${at}/actions/${index}`;
			if (actionIds.has(action.id)) {
				c.add(`${actionAt}/id`, `duplicate action id "${action.id}"`);
			}
			actionIds.add(action.id);
			sceneActions.add(action.id);
			if (!ADAPTER_OPS[scene.adapter].includes(action.op)) {
				c.add(`${actionAt}/op`, `op ${action.op} is not valid for adapter ${scene.adapter}`);
			}
			if ((action.op === "run" || action.op === "request") && action.ref === undefined) {
				c.add(`${actionAt}/ref`, `op ${action.op} requires ref`);
			}
			if (scene.adapter === "browser") {
				for (const error of action.op === "helper" ? helperActionErrors(action) : browserActionErrors(action)) {
					c.add(`${actionAt}${error.at}`, error.message);
				}
			}
		});
		scene.actions.forEach((action, index) => {
			// A helper's own report is a claim. The run needs its own evidence that
			// the page changed during this action: text that was not there before.
			// That is a safeguard against stale page text, not proof that the text
			// belongs to the helper's interaction.
			if (action.op === "helper" && !scene.expect.some((item) => item.action === action.id && item.check === "pageIncludesNew")) {
				c.add(`${at}/actions/${index}`, `helper action "${action.id}" needs a pageIncludesNew expectation: page text the run itself sees appear during this action`);
			}
		});
		scene.expect.forEach((expectation, index) => {
			const expectAt = `${at}/expect/${index}`;
			if (expectIds.has(expectation.id)) {
				c.add(`${expectAt}/id`, `duplicate expect id "${expectation.id}"`);
			}
			expectIds.add(expectation.id);
			if (!sceneActions.has(expectation.action)) {
				c.add(`${expectAt}/action`, `unknown action "${expectation.action}" in this scene`);
			}
			const valueType = ADAPTER_CHECKS[scene.adapter][expectation.check];
			if (!valueType) {
				c.add(`${expectAt}/check`, `check ${expectation.check} is not valid for adapter ${scene.adapter}`);
			} else if (valueType === "integer" && !Number.isInteger(expectation.value)) {
				c.add(`${expectAt}/value`, `check ${expectation.check} needs an integer value`);
			} else if (valueType === "string" && typeof expectation.value !== "string") {
				c.add(`${expectAt}/value`, `check ${expectation.check} needs a string value`);
			}
		});
		const sceneAudiences = new Set();
		scene.narration.forEach((narration, index) => {
			const narrationAt = `${at}/narration/${index}`;
			if (narrationIds.has(narration.id)) {
				c.add(`${narrationAt}/id`, `duplicate narration id "${narration.id}"`);
			}
			narrationIds.add(narration.id);
			sceneAudiences.add(narration.audience);
			if (!audiences.has(narration.audience)) {
				c.add(`${narrationAt}/audience`, `audience ${narration.audience} is not declared`);
			}
			c.refs(narration.claims, claimIds, `${narrationAt}/claims`, "claim");
			narration.claims.forEach((id) => narratedClaims.add(id));
			checkForbidden(narration.text, `${narrationAt}/text`);
		});
		for (const audience of audiences) {
			if (!sceneAudiences.has(audience)) {
				c.add(`${at}/narration`, `no narration for declared audience ${audience}`);
			}
		}
		if (scene.diagram && catalog) {
			c.refs(scene.diagram.edges, catalogEdges, `${at}/diagram/edges`, "catalog edge");
		}
	});

	doc.claims.forEach((claim, index) => {
		const at = `/claims/${index}`;
		if (catalog) {
			c.refs(claim.evidence, catalogEvidence, `${at}/evidence`, "catalog evidence");
			if (claim.capability !== undefined) {
				c.refs(claim.capability, catalogCapabilities, `${at}/capability`, "capability");
			}
		}
		c.refs(claim.demonstratedBy, actionIds, `${at}/demonstratedBy`, "action");
		const assertable = ASSERTABLE_CLASSES.includes(claim.class);
		if (!assertable && narratedClaims.has(claim.id)) {
			c.add(at, `class ${claim.class} claims must not be narrated as true`);
		}
		if (assertable && claim.evidence.length === 0 && claim.demonstratedBy.length === 0) {
			c.add(at, `class ${claim.class} requires evidence or demonstratedBy`);
		}
		if (claim.class === "observed" && claim.demonstratedBy.length === 0) {
			c.add(`${at}/demonstratedBy`, "observed claims must be demonstrated by an action");
		}
		checkForbidden(claim.text, `${at}/text`);
	});
}

/** Parses an origin; returns {url} or {error}. */
export function parseOrigin(origin) {
	let url;
	try {
		url = new URL(origin);
	} catch {
		return { error: "is not a valid URL" };
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		return { error: "scheme must be http or https" };
	}
	if (url.username !== "" || url.password !== "") {
		return { error: "must not contain userinfo" };
	}
	if (url.origin !== origin) {
		return { error: `must be an exact origin (expected "${url.origin}")` };
	}
	return { url };
}

export function isLoopbackHost(hostname) {
	return hostname === "127.0.0.1" || hostname === "[::1]";
}

function authorizationRules(doc, c, context) {
	const storyboard = context.storyboard;
	if (storyboard && doc.storyboardSha256 !== contentSha256(storyboard)) {
		c.add("/storyboardSha256", "does not match the canonical hash of the storyboard");
	}
	const executables = c.unique(doc.bindings.executables, "/bindings/executables");
	c.unique(doc.bindings.executables, "/bindings/executables", "path");
	const commands = c.unique(doc.commands, "/commands");
	doc.commands.forEach((command, index) => {
		const at = `/commands/${index}`;
		c.refs(command.executable, executables, `${at}/executable`, "executable");
		const literal = c.unique(command.env, `${at}/env`, "name");
		command.envPassthrough.forEach((name, nameIndex) => {
			if (literal.has(name)) {
				c.add(`${at}/envPassthrough/${nameIndex}`, `"${name}" is also set literally`);
			}
		});
	});
	const hasWorkspace = doc.workspace !== undefined;
	doc.commands.forEach((command, index) => {
		command.argv.forEach((arg, argIndex) => {
			for (const message of workspaceArgErrors(arg, hasWorkspace)) {
				c.add(`/commands/${index}/argv/${argIndex}`, message);
			}
		});
	});
	if (doc.browser) {
		const service = doc.browser.service;
		c.refs(service.executable, executables, "/browser/service/executable", "executable");
		const literal = c.unique(service.env, "/browser/service/env", "name");
		service.envPassthrough.forEach((name, nameIndex) => {
			if (literal.has(name)) {
				c.add(`/browser/service/envPassthrough/${nameIndex}`, `"${name}" is also set literally`);
			}
		});
		service.argv.forEach((arg, argIndex) => {
			for (const message of workspaceArgErrors(arg, hasWorkspace)) {
				c.add(`/browser/service/argv/${argIndex}`, message);
			}
		});
		if (doc.network !== "loopback") {
			c.add("/network", "browser capture requires network loopback");
		}
	}
	const requests = c.unique(doc.http.requests, "/http/requests");
	if (doc.network === "none" && doc.http.requests.length > 0) {
		c.add("/http/requests", "network none allows no HTTP requests");
	}
	doc.http.requests.forEach((request, index) => {
		const at = `/http/requests/${index}`;
		const parsed = parseOrigin(request.origin);
		if (parsed.error) {
			c.add(`${at}/origin`, parsed.error);
		} else if (doc.network === "loopback" && !isLoopbackHost(parsed.url.hostname)) {
			c.add(`${at}/origin`, "network loopback allows only 127.0.0.1 or [::1]");
		}
		if (request.path.includes("#") || /[\s]/.test(request.path)) {
			c.add(`${at}/path`, "must not contain a fragment or whitespace");
		}
		request.headers.forEach((header, headerIndex) => {
			if (FORBIDDEN_HEADERS.has(header.name.toLowerCase())) {
				c.add(`${at}/headers/${headerIndex}/name`, `header ${header.name} is not allowed`);
			}
		});
		if (request.body !== undefined) {
			if (request.method !== "POST") {
				c.add(`${at}/body`, "only POST requests may have a body");
			}
			if (Buffer.byteLength(request.body, "utf8") > doc.limits.maxRequestBytes) {
				c.add(`${at}/body`, "exceeds limits.maxRequestBytes");
			}
		}
	});
	const interactions = c.unique(doc.interactions ?? [], "/interactions");
	(doc.interactions ?? []).forEach((interaction, index) => {
		const at = `/interactions/${index}`;
		c.refs(interaction.executable, executables, `${at}/executable`, "executable");
		const literal = c.unique(interaction.env, `${at}/env`, "name");
		interaction.envPassthrough.forEach((name, nameIndex) => {
			if (literal.has(name)) {
				c.add(`${at}/envPassthrough/${nameIndex}`, `"${name}" is also set literally`);
			}
			if (HELPER_RESERVED_ENV.includes(name)) {
				c.add(`${at}/envPassthrough/${nameIndex}`, `${name} is set by the run`);
			}
		});
		interaction.env.forEach((item, envIndex) => {
			if (HELPER_RESERVED_ENV.includes(item.name)) {
				c.add(`${at}/env/${envIndex}/name`, `${item.name} is set by the run`);
			}
		});
		interaction.argv.forEach((arg, argIndex) => {
			for (const message of workspaceArgErrors(arg, hasWorkspace)) {
				c.add(`${at}/argv/${argIndex}`, message);
			}
		});
		c.unique(interaction.pageScripts, `${at}/pageScripts`);
		const pageAccess = interaction.needs.includes("browser-page");
		if (interaction.pageScripts.length && !pageAccess) {
			c.add(`${at}/pageScripts`, "page scripts need browser-page in needs");
		}
		if (pageAccess && !interaction.pageScripts.length) {
			c.add(`${at}/needs`, "browser-page needs at least one declared page script");
		}
		interaction.pageScripts.forEach((script, scriptIndex) => {
			if (!script.file.startsWith(HELPER_DIR) || script.file.length === HELPER_DIR.length) {
				c.add(`${at}/pageScripts/${scriptIndex}/file`, `must be an approved helper file under ${HELPER_DIR}`);
			}
		});
		c.unique(interaction.media, `${at}/media`, "role");
		c.unique(interaction.media, `${at}/media`, "label");
	});
	if ((doc.interactions ?? []).length) {
		if (!doc.browser) {
			c.add("/interactions", "helper actions run on the recorded browser page; a browser section is required");
		}
		if (!hasWorkspace) {
			c.add("/interactions", "helpers are approved files copied into the run workspace; a workspace section is required");
		}
	}
	if (storyboard) {
		storyboard.scenes.forEach((scene, sceneIndex) => {
			scene.actions.forEach((action, index) => {
				const at = `storyboard:/scenes/${sceneIndex}/actions/${index}/ref`;
				if (action.op === "run") {
					c.refs(action.ref, commands, at, "authorized command");
				} else if (action.op === "request") {
					c.refs(action.ref, requests, at, "authorized request");
				} else if (action.op === "helper") {
					c.refs(action.ref, interactions, at, "authorized interaction");
				}
			});
		});
	}
}

function preflightRules(doc, c) {
	c.unique(doc.checks, "/checks");
	const ready =
		doc.checks.every((check) => check.status === "pass") &&
		doc.adapters.every((adapter) => adapter.status === "supported");
	if (doc.verdict === "ready" && !ready) {
		c.add("/verdict", "ready requires every check to pass and every adapter supported");
	}
	doc.adapters.forEach((adapter, index) => {
		if (adapter.status !== "supported" && adapter.reason === undefined) {
			c.add(`/adapters/${index}/reason`, `status ${adapter.status} requires a reason`);
		}
	});
}

function descriptorRules(doc, c) {
	if (doc.status === "not-implemented" && doc.blockedReason === undefined) {
		c.add("/blockedReason", "not-implemented adapters require a blockedReason");
	}
}

function manifestRules(doc, c, context) {
	const paths = c.unique(doc.artifacts, "/artifacts", "path");
	doc.artifacts.forEach((artifact, index) =>
		c.refs(artifact.from, paths, `/artifacts/${index}/from`, "artifact"),
	);
	doc.transformations.forEach((item, index) =>
		c.refs(item.artifact, paths, `/transformations/${index}/artifact`, "artifact"),
	);
	if (doc.status === "completed" && doc.failures.length > 0) {
		c.add("/status", "a completed run must not record failures");
	}
	if (doc.status !== "completed" && doc.failures.length === 0) {
		c.add("/failures", `status ${doc.status} requires at least one failure record`);
	}
	if (context.needles) {
		for (const leak of findLeaks(doc, context.needles)) {
			c.add(leak.pointer, `contains the value of binding "${leak.binding}"`);
		}
	}
}

function ledgerRules(doc, c) {
	c.unique(doc.claims, "/claims");
	doc.claims.forEach((claim, index) => {
		const at = `/claims/${index}`;
		const assertable = ASSERTABLE_CLASSES.includes(claim.class);
		if (!assertable && claim.verdict !== "not-asserted") {
			c.add(`${at}/verdict`, `class ${claim.class} claims must be not-asserted`);
		}
		if (!assertable && claim.narration.length > 0) {
			c.add(`${at}/narration`, `class ${claim.class} claims must not be narrated`);
		}
		if (claim.verdict === "supported" && claim.evidence.length === 0) {
			c.add(`${at}/evidence`, "supported claims need evidence");
		}
	});
}

function qaRules(doc, c, context) {
	c.unique(doc.checks, "/checks");
	const anyFail = doc.checks.some((check) => check.status === "fail");
	if (anyFail && (doc.verdict === "structural-pass" || doc.verdict === "release")) {
		c.add("/verdict", `verdict ${doc.verdict} is not allowed with failing checks`);
	}
	if (doc.verdict !== "release") {
		return;
	}
	if (doc.reviewer.kind === "structural-tool") {
		c.add("/reviewer/kind", "a structural tool can never release");
	}
	const review = doc.audiovisualReview;
	if (!review) {
		c.add("/audiovisualReview", "release requires an exact-file audiovisual review");
		return;
	}
	if (review.watchedAndListened !== true) {
		c.add("/audiovisualReview/watchedAndListened", "release requires watchedAndListened");
	}
	if (doc.checks.some((check) => check.status !== "pass")) {
		c.add("/checks", "release requires every check to pass");
	}
	const manifest = context.manifest;
	if (!manifest) {
		c.add("/audiovisualReview", "release can only be validated against its manifest");
		return;
	}
	const exported = manifest.artifacts.find(
		(artifact) =>
			artifact.path === review.exportPath &&
			(artifact.role === "export-video" || artifact.role === "export-audio"),
	);
	if (!exported) {
		c.add("/audiovisualReview/exportPath", "is not an export artifact of the manifest");
	} else if (exported.sha256 !== review.exportSha256) {
		c.add("/audiovisualReview/exportSha256", "does not match the export artifact");
	}
}

function exportManifestRules(doc, c) {
	c.unique(doc.checks, "/checks");
	c.unique(doc.segments, "/segments");
	if (doc.verdict === "structural-pass" && doc.checks.some((check) => check.status !== "pass")) {
		c.add("/verdict", "structural-pass is not allowed with failing checks");
	}
	// The edit list must tile the export exactly: no gap, overlap or slack.
	let cursor = 0;
	doc.segments.forEach((segment, index) => {
		if (segment.startFrame !== cursor) {
			c.add(`/segments/${index}/startFrame`, `must be ${cursor} (segments are contiguous)`);
		}
		cursor = segment.startFrame + segment.frames;
	});
	if (cursor !== doc.totalFrames) {
		c.add("/totalFrames", `segments cover ${cursor} frames, not ${doc.totalFrames}`);
	}
	if (Math.abs(doc.durationMs - (doc.totalFrames * 1000) / 30) > 1) {
		c.add("/durationMs", "must equal totalFrames at 30 fps");
	}
	const paths = doc.files.map((file) => file.path);
	if (new Set(paths).size !== paths.length) {
		c.add("/files", "file paths must be unique");
	}
	for (const role of ["export-video", "captions"]) {
		if (doc.files.filter((file) => file.role === role).length !== 1) {
			c.add("/files", `exactly one ${role} file is required`);
		}
	}
}

/** Environment names a demo plan may not set or pass through. */
const SECRET_LIKE_ENV = /KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|CONNECTION/i;

/** Fields a plan's runtime must not carry: the derivation adds or forbids them. */
const RUNTIME_RESERVED = ["schema", "storyboardSha256", "approvalRecord"];

/**
 * The run authorization a demo plan stands for: its runtime plus the
 * storyboard hash. Approving the plan's sha256 approves exactly this.
 */
export function deriveAuthorization(plan) {
	const runtime = Object.fromEntries(Object.entries(plan.runtime ?? {}).filter(([key]) => !RUNTIME_RESERVED.includes(key)));
	return { schema: "run-authorization.v1", storyboardSha256: contentSha256(plan.storyboard), ...runtime };
}

function demoPlanRules(doc, c, context) {
	const catalog = context.catalog;
	if (catalog && doc.catalogSha256 !== contentSha256(catalog)) {
		c.add("/catalogSha256", "does not match the canonical hash of the catalog");
	}
	const nested = (prefix, errors) => errors.forEach((error) => c.add(`${prefix}${error.path === "/" ? "" : error.path}`, error.message));
	if (doc.storyboard.schema !== "storyboard.v1") {
		c.add("/storyboard/schema", "must be storyboard.v1");
		return;
	}
	nested("/storyboard", validateContract("storyboard", doc.storyboard, { catalog }));
	if (doc.storyboard.catalogSha256 !== doc.catalogSha256) {
		c.add("/storyboard/catalogSha256", "must equal the plan's catalogSha256");
	}
	for (const key of RUNTIME_RESERVED) {
		if (Object.hasOwn(doc.runtime, key)) {
			c.add(`/runtime/${key}`, "is added by the plan (schema, storyboard hash) or not allowed (approval records); approval is the plan sha256 passed on the command line");
		}
	}
	const authorization = deriveAuthorization(doc);
	nested("/runtime", validateContract("run-authorization", authorization, { storyboard: doc.storyboard }));
	const scenes = Array.isArray(doc.storyboard.scenes) ? doc.storyboard.scenes : [];
	const sceneById = new Map(scenes.map((scene) => [scene.id, scene]));

	const covered = new Set();
	doc.features.forEach((feature, index) => {
		const at = `/features/${index}`;
		if (covered.has(feature.capability)) {
			c.add(`${at}/capability`, `capability "${feature.capability}" is listed twice`);
		}
		covered.add(feature.capability);
		if ((feature.scenes === undefined) === (feature.omitted === undefined)) {
			c.add(at, "give exactly one of scenes (where it is shown) or omitted (why not)");
		}
		(feature.scenes ?? []).forEach((id, sceneIndex) => {
			const scene = sceneById.get(id);
			if (!scene) {
				c.add(`${at}/scenes/${sceneIndex}`, `unknown scene "${id}"`);
			} else if (!scene.capabilities.includes(feature.capability)) {
				c.add(`${at}/scenes/${sceneIndex}`, `scene "${id}" does not list capability "${feature.capability}"`);
			}
		});
	});
	if (catalog) {
		const known = new Map(catalog.capabilities.map((capability) => [capability.id, capability]));
		doc.features.forEach((feature, index) => {
			if (!known.has(feature.capability)) {
				c.add(`/features/${index}/capability`, `unknown capability "${feature.capability}"`);
			}
		});
		for (const capability of catalog.capabilities) {
			if (capability.userVisible && !covered.has(capability.id)) {
				c.add("/features", `user-visible capability "${capability.id}" (${capability.title}) is neither shown nor omitted with a reason`);
			}
		}
	}

	// Apps reach cloud services through the identity the human signed in with;
	// a plan never holds a secret value or forwards one from the environment.
	const launches = [
		...(Array.isArray(doc.runtime.commands) ? doc.runtime.commands.map((command, index) => [`/runtime/commands/${index}`, command]) : []),
		...(doc.runtime.browser?.service ? [["/runtime/browser/service", doc.runtime.browser.service]] : []),
		...(Array.isArray(doc.runtime.interactions) ? doc.runtime.interactions.map((interaction, index) => [`/runtime/interactions/${index}`, interaction]) : []),
	];
	const secretMessage = "looks like a secret (key, token, password, credential or connection string); a demo plan never carries or passes secrets, so use the identity-based sign-in the human has done on this machine";
	for (const [at, launch] of launches) {
		(Array.isArray(launch.env) ? launch.env : []).forEach((item, index) => {
			if (SECRET_LIKE_ENV.test(item?.name ?? "")) {
				c.add(`${at}/env/${index}/name`, secretMessage);
			}
		});
		(Array.isArray(launch.envPassthrough) ? launch.envPassthrough : []).forEach((name, index) => {
			if (SECRET_LIKE_ENV.test(name)) {
				c.add(`${at}/envPassthrough/${index}`, secretMessage);
			}
		});
	}

	// Helper media must never be captioned as the narrator.
	(Array.isArray(doc.runtime.interactions) ? doc.runtime.interactions : []).forEach((interaction, index) => {
		(Array.isArray(interaction?.media) ? interaction.media : []).forEach((item, mediaIndex) => {
			if (typeof item?.label === "string" && item.label === doc.voices?.narrator) {
				c.add(`/runtime/interactions/${index}/media/${mediaIndex}/label`, "helper media needs its own label, not the narrator's");
			}
		});
	});

	const declared = new Set((Array.isArray(doc.helpers) ? doc.helpers : []).map((item) => item?.file));
	const helperPrefix = `${WORKSPACE_TOKEN}/helpers/`;
	for (const [at, launch] of launches) {
		(Array.isArray(launch.argv) ? launch.argv : []).forEach((arg, index) => {
			if (typeof arg === "string" && arg.startsWith(helperPrefix) && !declared.has(arg.slice(helperPrefix.length))) {
				c.add(`${at}/argv/${index}`, `"${arg}" is not a declared helper; list ${arg.slice(helperPrefix.length)} in helpers so it is approved and copied into the workspace`);
			}
		});
	}

	(Array.isArray(doc.runtime.interactions) ? doc.runtime.interactions : []).forEach((interaction, index) => {
		(Array.isArray(interaction.pageScripts) ? interaction.pageScripts : []).forEach((script, scriptIndex) => {
			if (typeof script?.file === "string" && script.file.startsWith(HELPER_DIR) && !declared.has(script.file.slice(HELPER_DIR.length))) {
				c.add(`/runtime/interactions/${index}/pageScripts/${scriptIndex}/file`, `"${script.file}" is not a declared helper; list ${script.file.slice(HELPER_DIR.length)} in helpers so it is approved and copied into the workspace`);
			}
		});
	});

	c.unique(doc.helpers, "/helpers");
	c.unique(doc.helpers, "/helpers", "file");
	if (doc.helpers.length && doc.runtime.workspace === undefined) {
		c.add("/helpers", "helpers are copied into the run workspace; declare runtime.workspace");
	}
	c.unique(doc.externalDestinations, "/externalDestinations", "host");
	// Every off-machine HTTP origin must be a declared destination, so the
	// approval summary lists it whether or not the plan is paid.
	const declaredHosts = new Set(doc.externalDestinations.map((destination) => String(destination.host).toLowerCase()));
	(doc.runtime?.http?.requests ?? []).forEach((request, index) => {
		const parsed = parseOrigin(request.origin);
		if (!parsed.error && !isLoopbackHost(parsed.url.hostname) && !declaredHosts.has(parsed.url.hostname.toLowerCase())) {
			c.add(`/runtime/http/requests/${index}/origin`, `"${parsed.url.hostname}" is off this machine; list it in externalDestinations with its purpose so the approval shows it`);
		}
	});

	const { estimate } = doc;
	if (estimate.cloud && typeof estimate.amountUsd !== "number") {
		c.add("/estimate/amountUsd", "a cloud run needs an estimated amount");
	}
	if (!estimate.cloud && estimate.amountUsd !== null && estimate.amountUsd !== 0) {
		c.add("/estimate/amountUsd", "must be null or 0 when cloud is false");
	}
	if (estimate.cloud && doc.externalDestinations.length === 0) {
		c.add("/externalDestinations", "a cloud run must declare where the app sends data");
	}
	const timeoutMs = Number.isInteger(doc.runtime.limits?.timeoutMs) ? doc.runtime.limits.timeoutMs : 0;
	if (estimate.maxRunSeconds * 1000 < timeoutMs) {
		c.add("/estimate/maxRunSeconds", "must be at least one action's time limit (runtime.limits.timeoutMs)");
	}
	if (!doc.allowArchitectureCards) {
		scenes.forEach((scene, index) => {
			if (scene.diagram !== undefined) {
				c.add(`/storyboard/scenes/${index}/diagram`, "a product demo shows the running app; set allowArchitectureCards only when the human asked for architecture cards");
			}
		});
	}
}

const RULES = {
	"export-manifest": exportManifestRules,
	"capability-catalog": catalogRules,
	storyboard: storyboardRules,
	"run-authorization": authorizationRules,
	preflight: preflightRules,
	"adapter-descriptor": descriptorRules,
	event: () => {},
	"artifact-manifest": manifestRules,
	"claim-ledger": ledgerRules,
	"qa-report": qaRules,
	"demo-plan": demoPlanRules,
};

/**
 * Validates a document against its schema and, only when the shape is
 * valid, its cross-field rules.
 * @param {string} name Contract name.
 * @param {unknown} doc
 * @param {{catalog?: object, storyboard?: object, manifest?: object, needles?: {id: string, value: string}[]}} [context]
 * @returns {{path: string, message: string}[]}
 */
export function validateContract(name, doc, context = {}) {
	const errors = validatorFor(name)(doc);
	if (errors.length > 0) {
		return errors;
	}
	const c = new Collector();
	RULES[name](doc, c, context);
	return c.errors;
}

/** Validates or throws SdpError("invalid-contract") with the errors as details. */
export function assertContract(name, doc, context = {}, label = name) {
	const errors = validateContract(name, doc, context);
	if (errors.length > 0) {
		throw new SdpError("invalid-contract", `${label} is not a valid ${name}.v1`, {
			details: errors,
		});
	}
	return doc;
}

/**
 * Validates an events.jsonl stream: each line is an event.v1, runId is
 * constant, seq is consecutive from 0 and tMs never decreases.
 * @param {object[]} events
 */
export function validateEventStream(events, runId) {
	const errors = [];
	let previous = -1;
	events.forEach((event, index) => {
		for (const error of validateContract("event", event)) {
			errors.push({ path: `/${index}${error.path === "/" ? "" : error.path}`, message: error.message });
		}
		if (event?.seq !== index) {
			errors.push({ path: `/${index}/seq`, message: `expected seq ${index}` });
		}
		if (runId !== undefined && event?.runId !== runId) {
			errors.push({ path: `/${index}/runId`, message: "runId differs from the run" });
		}
		if (typeof event?.tMs === "number") {
			if (event.tMs < previous) {
				errors.push({ path: `/${index}/tMs`, message: "tMs decreased" });
			}
			previous = event.tMs;
		}
	});
	return errors;
}
