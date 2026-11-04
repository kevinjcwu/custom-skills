/* global AbortController */
import { test } from "node:test";
import net from "node:net";
import { URL } from "node:url";
import assert from "node:assert/strict";
import { httpRequest } from "../scripts/lib/http-adapter.mjs";
import { startFixtureServer } from "./helpers.mjs";

function options(origin, overrides = {}) {
	return {
		origin,
		method: "GET",
		path: "/health",
		headers: [],
		network: "loopback",
		allowedOrigins: [origin],
		timeoutMs: 5000,
		maxRequestBytes: 1024,
		maxResponseBytes: 4096,
		...overrides,
	};
}

test("allowlisted loopback GET and POST succeed", async (t) => {
	const { origin } = await startFixtureServer(t);
	const health = await httpRequest(options(origin));
	assert.equal(health.outcome, "response");
	assert.equal(health.status, 200);
	assert.equal(health.body.toString(), '{"ok":true}');
	const echo = await httpRequest(options(origin, { method: "POST", path: "/echo", body: "hello" }));
	assert.equal(echo.body.toString(), "hello");
});

test("redirects are not followed", async (t) => {
	const { origin } = await startFixtureServer(t);
	const result = await httpRequest(options(origin, { path: "/redirect" }));
	assert.equal(result.outcome, "redirect-blocked");
	assert.equal(result.status, 302);
	assert.equal(result.location, "/items");
	assert.equal(result.body.length, 0);
});

test("response and request bodies are capped", async (t) => {
	const { origin } = await startFixtureServer(t);
	const big = await httpRequest(options(origin, { path: "/big", maxResponseBytes: 1000 }));
	assert.equal(big.outcome, "response-limit");
	assert.equal(big.bodyExceeded, true);
	assert.equal(big.body.length, 1000);
	const tooLarge = await httpRequest(options(origin, { method: "POST", path: "/echo", body: "x".repeat(2000) }));
	assert.equal(tooLarge.outcome, "refused");
	assert.equal(tooLarge.error.code, "request-too-large");
});

test("origins, ports, schemes, userinfo, paths and headers outside the authorization are refused", async (t) => {
	const { origin } = await startFixtureServer(t);
	const port = Number(new URL(origin).port);
	const otherPort = `http://127.0.0.1:${port === 65535 ? port - 1 : port + 1}`;
	const cases = [
		[options(otherPort, { allowedOrigins: [origin] }), "origin-not-allowed"],
		[options("http://user:pw@127.0.0.1:1"), "origin-invalid"],
		[options("ftp://127.0.0.1:1"), "origin-invalid"],
		[options("http://example.invalid", { network: "loopback" }), "origin-not-loopback"],
		[options(origin, { network: "none" }), "network-disabled"],
		[options(origin, { path: "//example.invalid/x" }), "path-invalid"],
		[options(origin, { headers: [{ name: "Authorization", value: "Bearer x" }] }), "header-not-allowed"],
		[options(origin, { headers: [{ name: "Cookie", value: "a=b" }] }), "header-not-allowed"],
	];
	for (const [request, code] of cases) {
		const result = await httpRequest(request);
		assert.equal(result.outcome, "refused", code);
		assert.equal(result.error.code, code);
	}
});

test("timeout and cancellation stop the request", async () => {
	// A server that accepts connections and never answers.
	const sockets = new Set();
	const server = net.createServer((socket) => sockets.add(socket));
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const silent = `http://127.0.0.1:${server.address().port}`;
	try {
		const timedOut = await httpRequest(options(silent, { timeoutMs: 150 }));
		assert.equal(timedOut.outcome, "timeout");
		const controller = new AbortController();
		const pending = httpRequest(options(silent, { signal: controller.signal }));
		controller.abort();
		assert.equal((await pending).outcome, "cancelled");
	} finally {
		for (const socket of sockets) {
			socket.destroy();
		}
		await new Promise((resolve) => server.close(resolve));
	}
});

test("a closed loopback port is a network error", async () => {
	const server = net.createServer();
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const closed = `http://127.0.0.1:${server.address().port}`;
	await new Promise((resolve) => server.close(resolve));
	const result = await httpRequest(options(closed));
	assert.equal(result.outcome, "network-error");
	assert.equal(result.error.code, "econnrefused");
});

test("header values with control characters are refused without sending anything", async () => {
	const result = await httpRequest(options("http://127.0.0.1:1", { headers: [{ name: "x-label", value: "invalid\nheader" }] }));
	assert.equal(result.outcome, "refused");
	assert.equal(result.error.code, "header-invalid");
});
