// Compares an expected stock ledger with physical counts, per SKU.
import { createHash } from "node:crypto";
import { CsvError, parseCsv } from "./csv.mjs";

const SKU = /^[A-Z0-9][A-Z0-9-]{0,31}$/;

function quantity(row, name, file) {
	const raw = row.values[name].trim();
	if (!/^(0|[1-9][0-9]{0,8})$/.test(raw)) {
		const error = new CsvError(`"${name}" must be a whole number, found "${row.values[name]}"`, row.line, 1);
		error.file = file;
		throw error;
	}
	return Number(raw);
}

function sku(row, file) {
	const value = row.values.sku.trim();
	if (!SKU.test(value)) {
		const error = new CsvError(`invalid SKU "${row.values.sku}"`, row.line, 1);
		error.file = file;
		throw error;
	}
	return value;
}

function parse(text, file, required) {
	try {
		return parseCsv(text, { required });
	} catch (error) {
		if (error instanceof CsvError) {
			error.file = file;
		}
		throw error;
	}
}

/**
 * @param {{ledgerText: string, countsText: string, ledgerName?: string, countsName?: string}} input
 * @returns {object} deterministic report (no clock values)
 */
export function reconcile({ ledgerText, countsText, ledgerName = "ledger.csv", countsName = "counts.csv" }) {
	const ledger = parse(ledgerText, ledgerName, ["sku", "description", "expected_qty"]);
	const counts = parse(countsText, countsName, ["sku", "counted_qty"]);

	const expected = new Map();
	for (const row of ledger.rows) {
		const id = sku(row, ledgerName);
		if (expected.has(id)) {
			const error = new CsvError(`duplicate SKU "${id}"`, row.line, 1);
			error.file = ledgerName;
			throw error;
		}
		expected.set(id, { description: row.values.description.trim(), expected: quantity(row, "expected_qty", ledgerName) });
	}
	const counted = new Map();
	for (const row of counts.rows) {
		const id = sku(row, countsName);
		const value = quantity(row, "counted_qty", countsName);
		counted.set(id, (counted.get(id) ?? 0) + value);
	}

	const rows = [];
	for (const [id, item] of expected) {
		const count = counted.get(id);
		if (count === undefined) {
			rows.push({ sku: id, description: item.description, expected: item.expected, counted: null, variance: null, status: "not-counted" });
			continue;
		}
		const variance = count - item.expected;
		rows.push({ sku: id, description: item.description, expected: item.expected, counted: count, variance, status: variance === 0 ? "match" : variance > 0 ? "over" : "short" });
	}
	for (const [id, count] of counted) {
		if (!expected.has(id)) {
			rows.push({ sku: id, description: null, expected: null, counted: count, variance: null, status: "unexpected" });
		}
	}
	rows.sort((a, b) => a.sku.localeCompare(b.sku));

	const summary = { skus: rows.length, match: 0, short: 0, over: 0, "not-counted": 0, unexpected: 0 };
	for (const row of rows) {
		summary[row.status] += 1;
	}
	const digest = createHash("sha256").update(ledgerText).update("\0").update(countsText).digest("hex");
	return { schema: "inventory-recon.report.v1", id: `r-${digest.slice(0, 12)}`, inputs: { ledger: ledgerName, counts: countsName }, summary, rows };
}
