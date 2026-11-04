// Append-only run event log (events.jsonl).
//
// seq is consecutive from 0 and tMs is milliseconds on the Node monotonic
// clock since the log was opened. Every event is validated before it is
// written, and string data is redacted so binding values never reach disk.
import fs from "node:fs";
import { performance } from "node:perf_hooks";
import { validateContract } from "./contracts.mjs";
import { SdpError } from "./errors.mjs";

function redactString(value, needles) {
	let text = value;
	for (const needle of needles) {
		if (text.includes(needle.value)) {
			text = text.split(needle.value).join(`<binding:${needle.id}>`);
		}
	}
	return text.length > 2000 ? `${text.slice(0, 1997)}...` : text;
}

export class EventLog {
	/**
	 * @param {string} runId
	 * @param {string} file Path of events.jsonl; it must not already exist.
	 * @param {{id: string, value: string}[]} needles Binding values to redact.
	 */
	constructor(runId, file, needles = []) {
		this.runId = runId;
		this.needles = needles;
		this.fd = fs.openSync(file, "wx");
		this.start = performance.now();
		this.seq = 0;
		this.lastT = 0;
		this.events = [];
	}

	/**
	 * Writes one event. Throws SdpError if the event is not a valid event.v1.
	 * @param {{producer: string, type: string, disposition: string, kind?: string,
	 *   data?: Record<string, string|number|boolean|null>, sceneId?: string, actionId?: string,
	 *   attempt?: number, evidenceRef?: string, error?: {code: string, message: string}}} input
	 */
	emit(input) {
		const tMs = Math.max(this.lastT, Math.round((performance.now() - this.start) * 1000) / 1000);
		const data = {};
		for (const [key, value] of Object.entries(input.data ?? {})) {
			if (value === undefined) {
				continue;
			}
			data[key] = typeof value === "string" ? redactString(value, this.needles) : value;
		}
		const event = {
			schema: "event.v1",
			runId: this.runId,
			seq: this.seq,
			clock: "node-monotonic",
			tMs,
			producer: input.producer,
			kind: input.kind ?? "observed",
			type: input.type,
			data,
			disposition: input.disposition,
		};
		for (const key of ["sceneId", "actionId", "attempt", "evidenceRef"]) {
			if (input[key] !== undefined) {
				event[key] = input[key];
			}
		}
		if (input.error) {
			event.error = {
				code: input.error.code,
				message: redactString(input.error.message, this.needles),
			};
		}
		const errors = validateContract("event", event);
		if (errors.length > 0) {
			throw new SdpError("invalid-event", "refusing to write an invalid event", { details: errors });
		}
		fs.writeSync(this.fd, `${JSON.stringify(event)}\n`);
		this.seq += 1;
		this.lastT = tMs;
		this.events.push(event);
		return event;
	}

	close() {
		if (this.fd !== null) {
			fs.closeSync(this.fd);
			this.fd = null;
		}
	}
}

/** Reads and parses an events.jsonl file. */
export function readEvents(file) {
	const text = fs.readFileSync(file, "utf8");
	const events = [];
	for (const [index, line] of text.split("\n").entries()) {
		if (line === "") {
			continue;
		}
		try {
			events.push(JSON.parse(line));
		} catch {
			throw new SdpError("invalid-json", `events line ${index + 1} is not JSON`);
		}
	}
	return events;
}
