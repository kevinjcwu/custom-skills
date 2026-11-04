// Test-only process fixture for adapter behaviour. Modes (argv[2]):
//   echo <args...>      print args joined by spaces
//   env <NAME>...       print NAME=value for each name ("<unset>" if absent)
//   exit <code>         exit with the code
//   sleep <ms>          sleep, then print "slept"
//   flood <bytes>       write that many bytes to stdout
//   ignore-term <ms>    ignore SIGTERM and keep running for ms
//   late <ms>           print "early", then "late" after ms
//   flaky <file>        fail (exit 1) the first time, succeed when file exists
//   cwd                 print the working directory
//   stdin               print how many bytes were read from stdin
import fs from "node:fs";
import process from "node:process";
import { setTimeout } from "node:timers";

const [mode, ...rest] = process.argv.slice(2);

switch (mode) {
	case "echo":
		process.stdout.write(`${rest.join(" ")}\n`);
		break;
	case "env":
		for (const name of rest) {
			process.stdout.write(`${name}=${process.env[name] ?? "<unset>"}\n`);
		}
		break;
	case "exit":
		process.exitCode = Number(rest[0]);
		break;
	case "sleep":
		setTimeout(() => process.stdout.write("slept\n"), Number(rest[0]));
		break;
	case "flood":
		process.stdout.write("y".repeat(Number(rest[0])));
		break;
	case "ignore-term":
		process.on("SIGTERM", () => process.stdout.write("ignored SIGTERM\n"));
		process.stdout.write("ready\n");
		setTimeout(() => {}, Number(rest[0]));
		break;
	case "late":
		process.stdout.write("early\n");
		setTimeout(() => process.stdout.write("late\n"), Number(rest[0]));
		break;
	case "flaky":
		if (fs.existsSync(rest[0])) {
			process.stdout.write("recovered\n");
		} else {
			fs.writeFileSync(rest[0], "seen\n");
			process.stderr.write("first attempt fails\n");
			process.exitCode = 1;
		}
		break;
	case "cwd":
		process.stdout.write(`${process.cwd()}\n`);
		break;
	case "stdin": {
		let total = 0;
		process.stdin.on("data", (chunk) => {
			total += chunk.length;
		});
		process.stdin.on("end", () => process.stdout.write(`stdin ${total}\n`));
		break;
	}
	default:
		process.stderr.write(`unknown mode ${mode}\n`);
		process.exitCode = 2;
}
