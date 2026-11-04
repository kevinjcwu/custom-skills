// HTTP adapter: one request to an exact, approved origin.
//
// No redirects are followed (a 3xx is returned as "redirect-blocked"), no
// userinfo or auth headers are accepted, request and response bodies are
// capped, and timeout or cancellation destroys the socket.
import http from "node:http";
import https from "node:https";
import { Buffer } from "node:buffer";
import { URL } from "node:url";
import { performance } from "node:perf_hooks";
import { setTimeout, clearTimeout } from "node:timers";
import { isLoopbackHost, parseOrigin } from "./contracts.mjs";

export const HTTP_DESCRIPTOR = Object.freeze({
	schema: "adapter-descriptor.v1",
	id: "http",
	status: "implemented",
	roles: ["actor"],
	operations: ["request"],
	emits: ["action.start", "action.attempt", "action.end"],
	limits: ["timeoutMs", "maxRequestBytes", "maxResponseBytes", "retries"],
});

const FORBIDDEN_HEADERS = new Set([
	"authorization",
	"proxy-authorization",
	"cookie",
	"host",
	"content-length",
	"transfer-encoding",
	"connection",
]);

const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;
const HEADER_VALUE = /^[\t\x20-\x7e]*$/;

function refused(code, message, started) {
	return {
		outcome: "refused",
		status: null,
		body: Buffer.alloc(0),
		bodyExceeded: false,
		location: null,
		durationMs: performance.now() - started,
		error: { code, message },
	};
}

/**
 * Sends one request.
 * @param {{
 *   origin: string, method: string, path: string, headers: {name: string, value: string}[],
 *   body?: string, network: string, allowedOrigins: string[],
 *   timeoutMs: number, maxRequestBytes: number, maxResponseBytes: number, signal?: AbortSignal,
 * }} options
 * @returns {Promise<{
 *   outcome: "response" | "redirect-blocked" | "response-limit" | "timeout" | "cancelled" | "network-error" | "refused",
 *   status: number | null, body: Buffer, bodyExceeded: boolean, location: string | null,
 *   durationMs: number, error: {code: string, message: string} | null,
 * }>}
 */
export function httpRequest(options) {
	const started = performance.now();
	const parsed = parseOrigin(options.origin);
	if (parsed.error) {
		return Promise.resolve(refused("origin-invalid", `origin ${parsed.error}`, started));
	}
	if (options.network === "none") {
		return Promise.resolve(refused("network-disabled", "network is none", started));
	}
	if (!options.allowedOrigins.includes(options.origin)) {
		return Promise.resolve(refused("origin-not-allowed", "origin is not in the authorization", started));
	}
	if (options.network === "loopback" && !isLoopbackHost(parsed.url.hostname)) {
		return Promise.resolve(refused("origin-not-loopback", "network is loopback", started));
	}
	if (!options.path.startsWith("/") || options.path.startsWith("//")) {
		return Promise.resolve(refused("path-invalid", "path must start with a single /", started));
	}
	const target = new URL(options.path, options.origin);
	if (target.origin !== options.origin) {
		return Promise.resolve(refused("origin-changed", "path changes the origin", started));
	}
	for (const header of options.headers) {
		if (FORBIDDEN_HEADERS.has(header.name.toLowerCase())) {
			return Promise.resolve(refused("header-not-allowed", `header ${header.name} is not allowed`, started));
		}
		if (!HEADER_NAME.test(header.name) || !HEADER_VALUE.test(header.value)) {
			return Promise.resolve(refused("header-invalid", `header ${HEADER_NAME.test(header.name) ? header.name : "name"} has invalid characters`, started));
		}
	}
	const body = options.body === undefined ? null : Buffer.from(options.body, "utf8");
	if (body && body.length > options.maxRequestBytes) {
		return Promise.resolve(refused("request-too-large", "request body exceeds maxRequestBytes", started));
	}
	if (options.signal?.aborted) {
		return Promise.resolve({ ...refused("cancelled", "cancelled before sending", started), outcome: "cancelled" });
	}

	const headers = Object.fromEntries(options.headers.map((header) => [header.name, header.value]));
	if (body) {
		headers["content-length"] = String(body.length);
	}
	const transport = target.protocol === "https:" ? https : http;

	return new Promise((resolve) => {
		const chunks = [];
		let size = 0;
		let settled = false;
		let outcome = null;
		const done = (result) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			resolve({
				status: null,
				body: Buffer.concat(chunks),
				bodyExceeded: false,
				location: null,
				error: null,
				...result,
				durationMs: performance.now() - started,
			});
		};
		let request;
		try {
			request = transport.request({
				protocol: target.protocol,
				hostname: target.hostname.replace(/^\[|\]$/g, ""),
				port: target.port || undefined,
				method: options.method,
				path: `${target.pathname}${target.search}`,
				headers,
				agent: false,
			});
		} catch (error) {
			// Node validates the request synchronously; nothing was sent.
			settled = true;
			resolve(refused("request-invalid", `request could not be constructed: ${error.code ?? "invalid request"}`, started));
			return;
		}
		const stop = (reason) => {
			if (outcome === null) {
				outcome = reason;
			}
			request.destroy();
		};
		const onAbort = () => {
			stop("cancelled");
			done({ outcome: "cancelled", error: { code: "cancelled", message: "request cancelled" } });
		};
		options.signal?.addEventListener("abort", onAbort, { once: true });
		const timer = setTimeout(() => {
			stop("timeout");
			done({ outcome: "timeout", error: { code: "timeout", message: "request exceeded timeoutMs" } });
		}, options.timeoutMs);

		request.on("response", (response) => {
			const status = response.statusCode;
			if (status >= 300 && status < 400) {
				const location = typeof response.headers.location === "string" ? response.headers.location : null;
				response.resume();
				stop("redirect-blocked");
				done({
					outcome: "redirect-blocked",
					status,
					location,
					error: { code: "redirect-not-followed", message: "redirects are not followed" },
				});
				return;
			}
			response.on("data", (chunk) => {
				if (settled) {
					return;
				}
				const room = options.maxResponseBytes - size;
				if (chunk.length > room) {
					if (room > 0) {
						chunks.push(chunk.subarray(0, room));
						size += room;
					}
					stop("response-limit");
					done({
						outcome: "response-limit",
						status,
						bodyExceeded: true,
						error: { code: "response-too-large", message: "response exceeded maxResponseBytes" },
					});
					return;
				}
				chunks.push(chunk);
				size += chunk.length;
			});
			response.on("end", () => done({ outcome: "response", status }));
			response.on("error", () =>
				done({ outcome: "network-error", status, error: { code: "response-error", message: "response stream failed" } }),
			);
		});
		request.on("error", (error) => {
			if (outcome !== null) {
				return;
			}
			done({
				outcome: "network-error",
				error: {
					code: String(error.code ?? "request-error").toLowerCase().replace(/[^a-z0-9._-]/g, "-"),
					message: "request failed",
				},
			});
		});
		request.end(body ?? undefined);
	});
}
