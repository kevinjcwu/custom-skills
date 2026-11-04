// Synthetic fixture HTTP service, bound to 127.0.0.1 on an ephemeral port.
// Prints "listening <port>" once ready. Routes:
//   GET /health    {"ok":true}
//   GET /items     {"items":["alpha","beta"]}
//   GET /redirect  302 to /items
//   GET /big       a body larger than small response caps
//   POST /echo     echoes the request body
import http from "node:http";
import process from "node:process";
import { Buffer } from "node:buffer";

const server = http.createServer((request, response) => {
	if (request.method === "GET" && request.url === "/health") {
		response.writeHead(200, { "content-type": "application/json" });
		response.end('{"ok":true}');
	} else if (request.method === "GET" && request.url === "/items") {
		response.writeHead(200, { "content-type": "application/json" });
		response.end('{"items":["alpha","beta"]}');
	} else if (request.method === "GET" && request.url === "/redirect") {
		response.writeHead(302, { location: "/items" });
		response.end();
	} else if (request.method === "GET" && request.url === "/big") {
		response.writeHead(200, { "content-type": "text/plain" });
		response.end("x".repeat(64 * 1024));
	} else if (request.method === "POST" && request.url === "/echo") {
		const chunks = [];
		request.on("data", (chunk) => chunks.push(chunk));
		request.on("end", () => {
			response.writeHead(200, { "content-type": "text/plain" });
			response.end(Buffer.concat(chunks));
		});
	} else {
		response.writeHead(404);
		response.end("not found");
	}
});

server.listen(0, "127.0.0.1", () => {
	process.stdout.write(`listening ${server.address().port}\n`);
});

process.on("SIGTERM", () => server.close(() => process.exit(0)));
