import readline from "node:readline";
import process from "node:process";

const lines = readline.createInterface({ input: process.stdin });
const callId = "fixture-upload-1";
let mode = "done";
let sent = false;
let completed = false;

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const finish = (status) => {
	if (completed) return;
	completed = true;
	process.stdout.write(
		`${JSON.stringify({ type: "result", status, detail: "fixture helper diagnostic ".repeat(30), media: [] })}\n`,
		() => {
			lines.close();
			process.stdin.pause();
		},
	);
};

lines.on("line", (line) => {
	let message;
	try {
		message = JSON.parse(line);
	} catch {
		process.exitCode = 2;
		return;
	}
	if (message.type === "start") {
		mode = process.argv[2] ?? "done";
		if (mode === "hang") return;
		sent = true;
		send({
			type: "page",
			id: callId,
			script: "fixture.capture",
			arg: { op: "upload", text: process.argv[3] ?? "" },
		});
		return;
	}
	if (message.type === "page-result" && message.id === callId && sent) {
		finish(
			message.ok && mode === "done"
				? "done"
				: mode === "unknown"
					? "unknown"
					: "failed",
		);
	}
});
