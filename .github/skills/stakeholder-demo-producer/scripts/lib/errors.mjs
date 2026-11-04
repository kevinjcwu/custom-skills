// Shared error type and exit codes for the sdp CLI and its libraries.

export const EXIT = Object.freeze({
	OK: 0,
	FAILED: 1,
	USAGE: 2,
	BLOCKED: 3,
});

export class SdpError extends Error {
	/**
	 * @param {string} code Stable machine-readable code.
	 * @param {string} message Human-readable message.
	 * @param {{exitCode?: number, details?: unknown}} [options]
	 */
	constructor(code, message, options = {}) {
		super(message);
		this.name = "SdpError";
		this.code = code;
		this.exitCode = options.exitCode ?? EXIT.FAILED;
		this.details = options.details;
	}
}

export function usageError(message, details) {
	return new SdpError("usage", message, { exitCode: EXIT.USAGE, details });
}

export function blockedError(code, message, details) {
	return new SdpError(code, message, { exitCode: EXIT.BLOCKED, details });
}
