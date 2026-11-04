#!/usr/bin/env node
// Synthetic fixture CLI: counts the items given on the command line.
//   tally add <item>...   prints "<n> items: a, b"
//   tally greet           prints the TALLY_GREETING environment value
import process from "node:process";

const [command, ...items] = process.argv.slice(2);

if (command === "add") {
	process.stdout.write(`${items.length} items: ${items.join(", ")}\n`);
} else if (command === "greet") {
	process.stdout.write(`${process.env.TALLY_GREETING ?? "no greeting"}\n`);
} else {
	process.stderr.write("usage: tally add <item>... | tally greet\n");
	process.exitCode = 2;
}
