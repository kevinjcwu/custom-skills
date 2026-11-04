#!/usr/bin/env node
// recon --ledger <csv> --counts <csv> --out <report.json>
// Exit codes: 0 reconciled, 2 invalid input (usage or malformed CSV),
// 1 unexpected internal error.
import fs from "node:fs";
import path from "node:path";
import { CsvError } from "../src/csv.mjs";
import { reconcile } from "../src/reconcile.mjs";

const USAGE = "usage: recon --ledger <ledger.csv> --counts <counts.csv> --out <report.json>";

function parseArgs(argv) {
	const options = {};
	for (let index = 0; index < argv.length; index += 2) {
		const flag = argv[index];
		const value = argv[index + 1];
		if (!["--ledger", "--counts", "--out"].includes(flag) || value === undefined || flag.slice(2) in options) {
			return null;
		}
		options[flag.slice(2)] = value;
	}
	return options.ledger && options.counts && options.out ? options : null;
}

function main(argv) {
	const options = parseArgs(argv);
	if (!options) {
		process.stderr.write(`${USAGE}\n`);
		return 2;
	}
	let ledgerText;
	let countsText;
	try {
		ledgerText = fs.readFileSync(options.ledger, "utf8");
		countsText = fs.readFileSync(options.counts, "utf8");
	} catch (error) {
		process.stderr.write(`recon: cannot read input: ${error.code ?? "error"}\n`);
		return 2;
	}
	let report;
	try {
		report = reconcile({ ledgerText, countsText, ledgerName: path.basename(options.ledger), countsName: path.basename(options.counts) });
	} catch (error) {
		if (error instanceof CsvError) {
			process.stderr.write(`recon: ${error.file}:${error.line}:${error.column}: ${error.message}\n`);
			process.stderr.write("recon: no report written\n");
			return 2;
		}
		throw error;
	}
	try {
		fs.writeFileSync(options.out, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
	} catch (error) {
		process.stderr.write(`recon: cannot write report: ${error.code === "EEXIST" ? "file exists" : (error.code ?? "error")}\n`);
		return 2;
	}
	const { summary } = report;
	process.stdout.write(`Reconciled ${summary.skus} SKUs: ${summary.match} match, ${summary.short} short, ${summary.over} over, ${summary["not-counted"]} not counted, ${summary.unexpected} unexpected\n`);
	process.stdout.write(`Report ${report.id} written to ${path.basename(options.out)}\n`);
	return 0;
}

try {
	process.exitCode = main(process.argv.slice(2));
} catch {
	process.stderr.write("recon: internal error\n");
	process.exitCode = 1;
}
