// Artifact manifest: build from a run directory and verify against bytes.
import fs from "node:fs";
import path from "node:path";
import { sha256Hex } from "./canonical.mjs";
import { SdpError } from "./errors.mjs";
import { BINARY_ROLES, looksLikeHostPath, mediaLooksLikeHostPath, resolveContained } from "./paths.mjs";

/** Records written after the manifest; they are not manifest artifacts. */
export const RUN_RECORDS = Object.freeze(["manifest.json", "claim-ledger.json", "qa-report.json"]);

/** Lists regular files below a run directory as sorted relative paths. */
export function listRunFiles(runPath) {
	const files = [];
	const special = [];
	const visit = (abs, rel) => {
		const entries = fs.readdirSync(abs, { withFileTypes: true });
		entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
		for (const entry of entries) {
			const childRel = rel ? `${rel}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				visit(path.join(abs, entry.name), childRel);
			} else if (entry.isFile()) {
				if (!(rel === "" && RUN_RECORDS.includes(entry.name))) {
					files.push(childRel);
				}
			} else {
				special.push(childRel);
			}
		}
	};
	visit(runPath, "");
	return { files, special };
}

/**
 * Builds an artifact-manifest.v1 document for every file in the run
 * directory. Every file must have a declared role.
 * @param {string} runPath
 * @param {{runId: string, subject: string, status: string, catalogSha256: string,
 *   storyboardSha256: string, authorizationSha256: string, targetContentSha256: string,
 *   roles: Map<string, {role: string, producedBy: string, from?: string[]}>,
 *   transformations: object[], failures: object[], cleanup: object[]}} info
 */
export function buildManifest(runPath, info) {
	const { files, special } = listRunFiles(runPath);
	if (special.length > 0) {
		throw new SdpError("run-dir-special", "the run directory contains a symlink or special file");
	}
	const artifacts = files.map((rel) => {
		const meta = info.roles.get(rel);
		if (!meta) {
			throw new SdpError("unlisted-artifact", `no role declared for run artifact ${rel}`);
		}
		const bytes = fs.readFileSync(path.join(runPath, ...rel.split("/")));
		return {
			path: rel,
			sha256: sha256Hex(bytes),
			bytes: bytes.length,
			role: meta.role,
			producedBy: meta.producedBy,
			...(meta.from ? { from: meta.from } : {}),
		};
	});
	return {
		schema: "artifact-manifest.v1",
		runId: info.runId,
		subject: info.subject,
		status: info.status,
		catalogSha256: info.catalogSha256,
		storyboardSha256: info.storyboardSha256,
		authorizationSha256: info.authorizationSha256,
		targetContentSha256: info.targetContentSha256,
		artifacts,
		transformations: info.transformations,
		failures: info.failures,
		cleanup: info.cleanup,
	};
}

/**
 * Verifies a manifest against the run directory bytes.
 * @returns {{id: string, status: "pass"|"fail", detail: string}[]}
 */
export function verifyManifestFiles(runPath, manifest) {
	const checks = [];
	const mismatched = [];
	const missing = [];
	const hostPaths = [];
	for (const artifact of manifest.artifacts) {
		let file;
		try {
			file = resolveContained(runPath, artifact.path);
		} catch {
			missing.push(artifact.path);
			continue;
		}
		let bytes;
		try {
			bytes = fs.readFileSync(file);
		} catch {
			missing.push(artifact.path);
			continue;
		}
		if (bytes.length !== artifact.bytes || sha256Hex(bytes) !== artifact.sha256) {
			mismatched.push(artifact.path);
		}
		if (BINARY_ROLES.includes(artifact.role) ? mediaLooksLikeHostPath(bytes) : looksLikeHostPath(bytes.toString("utf8"))) {
			hostPaths.push(artifact.path);
		}
	}
	const problems = [...missing.map((item) => `missing ${item}`), ...mismatched.map((item) => `changed ${item}`)];
	checks.push({
		id: "artifact-hashes",
		status: problems.length ? "fail" : "pass",
		detail: problems.length
			? `artifact bytes differ from the manifest: ${problems.slice(0, 10).join(", ")}`
			: `${manifest.artifacts.length} artifact(s) match their recorded SHA-256 and size`,
	});
	const listed = new Set(manifest.artifacts.map((artifact) => artifact.path));
	const { files, special } = listRunFiles(runPath);
	const unlisted = files.filter((file) => !listed.has(file)).concat(special);
	checks.push({
		id: "unlisted-files",
		status: unlisted.length ? "fail" : "pass",
		detail: unlisted.length
			? `files in the run directory are not in the manifest: ${unlisted.slice(0, 10).join(", ")}`
			: "every file in the run directory is listed",
	});
	if (looksLikeHostPath(JSON.stringify(manifest))) {
		hostPaths.unshift("manifest.json");
	}
	checks.push({
		id: "no-host-paths",
		status: hostPaths.length ? "fail" : "pass",
		detail: hostPaths.length
			? `host-looking absolute paths found in: ${hostPaths.slice(0, 10).join(", ")}`
			: "no host-looking absolute paths in the manifest or artifacts",
	});
	return checks;
}
