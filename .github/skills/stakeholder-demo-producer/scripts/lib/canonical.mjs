// Canonical JSON and hashing. Contracts are hashed as canonical JSON so that
// formatting does not change their identity; artifacts are hashed as bytes.
import { createHash } from "node:crypto";
import { SdpError } from "./errors.mjs";

function canonicalValue(value, pointer) {
	if (value === null) {
		return "null";
	}
	switch (typeof value) {
		case "string":
		case "boolean":
			return JSON.stringify(value);
		case "number":
			if (!Number.isFinite(value)) {
				throw new SdpError(
					"canonical-json",
					`non-finite number at ${pointer || "/"}`,
				);
			}
			return JSON.stringify(value);
		case "object": {
			if (Array.isArray(value)) {
				return `[${value
					.map((item, index) => canonicalValue(item, `${pointer}/${index}`))
					.join(",")}]`;
			}
			const keys = Object.keys(value).sort();
			const parts = keys.map(
				(key) =>
					`${JSON.stringify(key)}:${canonicalValue(value[key], `${pointer}/${key}`)}`,
			);
			return `{${parts.join(",")}}`;
		}
		default:
			throw new SdpError(
				"canonical-json",
				`unsupported value (${typeof value}) at ${pointer || "/"}`,
			);
	}
}

/** Serialises JSON data with sorted object keys and no insignificant space. */
export function canonicalJson(value) {
	return canonicalValue(value, "");
}

export function sha256Hex(data) {
	return createHash("sha256").update(data).digest("hex");
}

/** SHA-256 of the canonical JSON form of a contract document. */
export function contentSha256(value) {
	return sha256Hex(canonicalJson(value));
}

export const SHA256_PATTERN = /^[0-9a-f]{64}$/;
