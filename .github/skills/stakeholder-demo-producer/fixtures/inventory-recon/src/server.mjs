#!/usr/bin/env node
// Read-only report viewer: node src/server.mjs --reports <dir> [--port <n>]
// Binds 127.0.0.1 only and prints one JSON readiness line on stdout.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
const REPORT_ID = /^r-[0-9a-f]{12}$/;

function readReports(dir) {
	const reports = [];
	for (const name of fs.readdirSync(dir).sort()) {
		if (!name.endsWith(".json")) {
			continue;
		}
		try {
			const report = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
			if (report.schema === "inventory-recon.report.v1" && REPORT_ID.test(report.id)) {
				reports.push(report);
			}
		} catch {
			// Unreadable files are not reports.
		}
	}
	return reports;
}

function send(response, status, type, body) {
	response.writeHead(status, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff" });
	response.end(body);
}

const json = (response, status, value) => send(response, status, "application/json; charset=utf-8", `${JSON.stringify(value)}\n`);

export function createServer(reportsDir) {
	return http.createServer((request, response) => {
		const host = request.headers.host ?? "";
		if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) {
			return json(response, 421, { error: "loopback host required" });
		}
		if (request.method !== "GET") {
			return json(response, 405, { error: "read-only" });
		}
		const url = new URL(request.url, "http://127.0.0.1");
		if (url.pathname === "/" || url.pathname === "/index.html") {
			return send(response, 200, "text/html; charset=utf-8", fs.readFileSync(path.join(PUBLIC_DIR, "index.html")));
		}
		if (url.pathname === "/api/reports") {
			return json(response, 200, readReports(reportsDir).map(({ id, inputs, summary }) => ({ id, inputs, summary })));
		}
		const match = /^\/api\/reports\/([^/]+)$/.exec(url.pathname);
		if (match) {
			const report = REPORT_ID.test(match[1]) ? readReports(reportsDir).find((item) => item.id === match[1]) : undefined;
			return report ? json(response, 200, report) : json(response, 404, { error: "no such report" });
		}
		return json(response, 404, { error: "not found" });
	});
}

function main(argv) {
	const options = { port: "0" };
	for (let index = 0; index < argv.length; index += 2) {
		options[argv[index].replace(/^--/, "")] = argv[index + 1];
	}
	if (!options.reports || !fs.statSync(options.reports, { throwIfNoEntry: false })?.isDirectory() || !/^\d{1,5}$/.test(options.port)) {
		process.stderr.write("usage: server --reports <dir> [--port <n>]\n");
		process.exitCode = 2;
		return;
	}
	const server = createServer(path.resolve(options.reports));
	server.listen(Number(options.port), "127.0.0.1", () => {
		const { port } = server.address();
		process.stdout.write(`${JSON.stringify({ ready: true, origin: `http://127.0.0.1:${port}`, pid: process.pid })}\n`);
	});
	const stop = () => server.close(() => process.exit(0));
	process.once("SIGTERM", stop);
	process.once("SIGINT", stop);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
	main(process.argv.slice(2));
}
