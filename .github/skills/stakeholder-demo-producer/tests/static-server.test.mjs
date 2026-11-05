import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { startService } from "../scripts/lib/browser-adapter.mjs";
import { ProcRegistry } from "../scripts/lib/proc-registry.mjs";
import { makeTempDir, SKILL_ROOT } from "./helpers.mjs";

function request(origin, { host = origin.host, method = "GET", pathname = "/public.txt", headers = {} } = {}) {
	return new Promise((resolve, reject) => {
		const req = http.request({
			hostname: origin.hostname,
			port: origin.port,
			path: pathname,
			method,
			agent: false,
			setHost: false,
			headers: { ...(host === null ? {} : { host }), ...headers },
		}, (response) => {
			let body = "";
			response.setEncoding("utf8");
			response.on("data", (chunk) => { body += chunk; });
			response.on("error", reject);
			response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body }));
		});
		req.setTimeout(2000, () => req.destroy(new Error("static helper request timed out")));
		req.on("error", reject);
		req.end();
	});
}

test("static helper serves only its announced authority and preserves read-only file restrictions", { timeout: 15000 }, async (t) => {
	const temp = makeTempDir();
	const registry = new ProcRegistry();
	t.after(async () => {
		await registry.stopAll(500);
		temp.cleanup();
	});
	fs.writeFileSync(path.join(temp.dir, "public.txt"), "synthetic public asset\n");
	fs.writeFileSync(path.join(temp.dir, ".hidden"), "synthetic hidden asset\n");
	const service = await startService({
		registry,
		id: "static-helper",
		executable: process.execPath,
		argv: [path.join(SKILL_ROOT, "scripts", "helpers", "static-server.mjs"), temp.dir],
		cwd: temp.dir,
		env: {},
		readyTimeoutMs: 5000,
		maxOutputBytes: 65536,
	});
	assert.equal(service.ok, true, service.error);
	const origin = new URL(service.origin);

	await t.test("GET and HEAD work on the exact announced authority", async () => {
		const get = await request(origin);
		assert.equal(get.status, 200);
		assert.equal(get.body, "synthetic public asset\n");
		assert.equal(get.headers["content-type"], "text/plain; charset=utf-8");
		const head = await request(origin, { method: "HEAD" });
		assert.equal(head.status, 200);
		assert.equal(head.body, "");
	});

	const wrongPort = Number(origin.port) === 65535 ? 65534 : Number(origin.port) + 1;
	for (const host of [
		`attacker.invalid:${origin.port}`,
		`127.0.0.1.attacker.invalid:${origin.port}`,
		`localhost:${origin.port}`,
		`127.0.0.1:${wrongPort}`,
		"127.0.0.1",
		`[::1]:${origin.port}`,
	]) {
		await t.test(`rejects Host ${host}`, async () => {
			const response = await request(origin, { host, headers: { "x-forwarded-host": origin.host } });
			assert.equal(response.status, 421);
			assert.ok(!response.body.includes("synthetic public asset"));
		});
	}

	await t.test("missing Host cannot retrieve an asset", async () => {
		const response = await request(origin, { host: null });
		assert.ok([400, 421].includes(response.status));
		assert.ok(!response.body.includes("synthetic public asset"));
	});

	await t.test("dotfiles and writes remain blocked on the valid authority", async () => {
		assert.equal((await request(origin, { pathname: "/.hidden" })).status, 404);
		const post = await request(origin, { method: "POST" });
		assert.equal(post.status, 405);
		assert.equal(post.headers.allow, "GET, HEAD");
	});
});
