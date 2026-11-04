import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "data");

function tempDir(t) {
	// A space in the path keeps argument quoting honest.
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "recon test "));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	return dir;
}

const recon = (...args) => spawnSync(process.execPath, [path.join(ROOT, "bin", "recon.mjs"), ...args], { encoding: "utf8" });

test("recon writes a report and summarises it (exit 0)", (t) => {
	const out = path.join(tempDir(t), "report.json");
	const result = recon("--ledger", path.join(DATA, "ledger.csv"), "--counts", path.join(DATA, "counts.csv"), "--out", out);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /^Reconciled 6 SKUs: 4 match, 1 short, 1 over, 0 not counted, 0 unexpected$/m);
	const report = JSON.parse(fs.readFileSync(out, "utf8"));
	assert.deepEqual(report.rows.filter((row) => row.status !== "match").map((row) => [row.sku, row.variance]), [["BRK-L40", 6], ["NUT-M6", -12]]);
});

test("malformed counts exit 2 with a located diagnostic and no report", (t) => {
	const out = path.join(tempDir(t), "report.json");
	const result = recon("--ledger", path.join(DATA, "ledger.csv"), "--counts", path.join(DATA, "counts-malformed.csv"), "--out", out);
	assert.equal(result.status, 2);
	assert.match(result.stderr, /^recon: counts-malformed\.csv:4:1: "counted_qty" must be a whole number, found "eight hundred"$/m);
	assert.equal(fs.existsSync(out), false);
});

test("usage errors exit 2 and existing reports are never overwritten", (t) => {
	assert.equal(recon("--ledger").status, 2);
	const out = path.join(tempDir(t), "report.json");
	fs.writeFileSync(out, "keep");
	const result = recon("--ledger", path.join(DATA, "ledger.csv"), "--counts", path.join(DATA, "counts.csv"), "--out", out);
	assert.equal(result.status, 2);
	assert.equal(fs.readFileSync(out, "utf8"), "keep");
});

test("server lists and serves reports on loopback only", async (t) => {
	const reports = tempDir(t);
	assert.equal(recon("--ledger", path.join(DATA, "ledger.csv"), "--counts", path.join(DATA, "counts.csv"), "--out", path.join(reports, "a.json")).status, 0);
	const child = spawn(process.execPath, [path.join(ROOT, "src", "server.mjs"), "--reports", reports], { stdio: ["ignore", "pipe", "inherit"] });
	t.after(() => child.kill("SIGTERM"));
	const [line] = await once(child.stdout, "data");
	const { ready, origin } = JSON.parse(String(line));
	assert.equal(ready, true);
	assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/);

	const list = await (await fetch(`${origin}/api/reports`)).json();
	assert.equal(list.length, 1);
	const report = await (await fetch(`${origin}/api/reports/${list[0].id}`)).json();
	assert.equal(report.summary.short, 1);
	assert.equal((await fetch(`${origin}/api/reports/r-000000000000`)).status, 404);
	assert.equal((await fetch(`${origin}/api/reports/..%2Fsecret`)).status, 404);
	assert.equal((await fetch(`${origin}/api/reports`, { method: "POST" })).status, 405);
	// fetch() cannot override Host, so use a raw request.
	const foreignHost = await new Promise((resolve, reject) => {
		http.get(`${origin}/`, { headers: { host: "example.test" } }, (response) => {
			response.resume();
			resolve(response.statusCode);
		}).on("error", reject);
	});
	assert.equal(foreignHost, 421);
	assert.match(await (await fetch(`${origin}/`)).text(), /Inventory reconciliation/);
});
