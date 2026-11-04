// Synthetic protocol probe only: no browser, speech, media or provider.
import readline from "node:readline";
import process from "node:process";

const [operation, script] = process.argv.slice(2);
const lines = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
lines.on("line", (line) => {
	const message = JSON.parse(line);
	if (message.type === "start") {
		send({ type: "page", id: "probe", script, arg: { operation } });
	} else if (message.type === "page-result") {
		send({
			type: "result",
			status: message.ok ? "done" : "failed",
			detail: message.ok ? JSON.stringify(message.value) : message.error,
		});
		lines.close();
		process.stdin.destroy();
	}
});
