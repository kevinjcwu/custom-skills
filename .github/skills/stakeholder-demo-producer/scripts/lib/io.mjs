// Bounded JSON reads and exclusive writes.
import fs from "node:fs";
import { SdpError } from "./errors.mjs";

export const MAX_JSON_BYTES = 16 * 1024 * 1024;

export function readJsonFile(file, label = "input") {
	let stat;
	try {
		stat = fs.statSync(file);
	} catch (error) {
		throw new SdpError("read-failed", `${label}: cannot read file`, {
			details: { code: error.code },
		});
	}
	if (!stat.isFile()) {
		throw new SdpError("read-failed", `${label}: not a regular file`);
	}
	if (stat.size > MAX_JSON_BYTES) {
		throw new SdpError(
			"read-failed",
			`${label}: larger than ${MAX_JSON_BYTES} bytes`,
		);
	}
	const text = fs.readFileSync(file, "utf8");
	try {
		return JSON.parse(text);
	} catch (error) {
		throw new SdpError("invalid-json", `${label}: ${error.message}`);
	}
}

/** Writes a file that must not already exist. */
export function writeExclusive(file, data) {
	fs.writeFileSync(file, data, { flag: "wx" });
}

export function writeJsonExclusive(file, value) {
	writeExclusive(file, `${JSON.stringify(value, null, "\t")}\n`);
}
