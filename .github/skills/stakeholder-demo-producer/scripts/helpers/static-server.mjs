#!/usr/bin/env node
// Approved demo helper: serves one directory of a static site on a random
// loopback port and prints the readiness line `sdp demo` waits for:
//   {"ready":true,"origin":"http://127.0.0.1:<port>","pid":<pid>}
// Usage: node static-server.mjs [dir]   (dir defaults to the working directory)
// Read-only: GET and HEAD only, no directory listings, no dotfiles, and no
// path outside the served directory (symlinks included).
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import process from "node:process";

const TYPES = {
	".html": "text/html; charset=utf-8",
	".htm": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".ico": "image/x-icon",
	".txt": "text/plain; charset=utf-8",
	".wav": "audio/wav",
	".mp3": "audio/mpeg",
	".woff2": "font/woff2",
};

const root = fs.realpathSync(path.resolve(process.argv[2] ?? "."));

function resolveFile(urlPath) {
	let decoded;
	try {
		decoded = decodeURIComponent(urlPath);
	} catch {
		return null;
	}
	if (decoded.includes("\0") || decoded.split("/").some((part) => part.startsWith("."))) {
		return null;
	}
	let file = path.join(root, decoded);
	try {
		if (fs.statSync(file).isDirectory()) {
			file = path.join(file, "index.html");
		}
		const real = fs.realpathSync(file);
		const rel = path.relative(root, real);
		if (rel.startsWith("..") || path.isAbsolute(rel) || !fs.statSync(real).isFile()) {
			return null;
		}
		return real;
	} catch {
		return null;
	}
}

const server = http.createServer((request, response) => {
	if (request.method !== "GET" && request.method !== "HEAD") {
		response.writeHead(405, { allow: "GET, HEAD" }).end();
		return;
	}
	const file = resolveFile(new URL(request.url, "http://127.0.0.1").pathname);
	if (!file) {
		response.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("not found");
		return;
	}
	response.writeHead(200, { "content-type": TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream", "cache-control": "no-store" });
	if (request.method === "HEAD") {
		response.end();
		return;
	}
	fs.createReadStream(file).pipe(response);
});

server.listen(0, "127.0.0.1", () => {
	process.stdout.write(`${JSON.stringify({ ready: true, origin: `http://127.0.0.1:${server.address().port}`, pid: process.pid })}\n`);
});
for (const signal of ["SIGTERM", "SIGINT"]) {
	process.on(signal, () => server.close(() => process.exit(0)));
}
