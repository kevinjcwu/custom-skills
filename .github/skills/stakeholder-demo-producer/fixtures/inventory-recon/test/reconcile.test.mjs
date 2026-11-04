import assert from "node:assert/strict";
import { test } from "node:test";
import { CsvError, parseCsv } from "../src/csv.mjs";
import { reconcile } from "../src/reconcile.mjs";

test("parses quoted fields, escaped quotes and CRLF", () => {
	const { header, rows } = parseCsv('a,b\r\n"x, y","say ""hi"""\r\n1,2\r\n');
	assert.deepEqual(header, ["a", "b"]);
	assert.deepEqual(rows.map((row) => row.values), [{ a: "x, y", b: 'say "hi"' }, { a: "1", b: "2" }]);
	assert.deepEqual(rows.map((row) => row.line), [2, 3]);
});

test("reports line and column for malformed CSV", () => {
	assert.throws(() => parseCsv('a,b\n1,"open\n'), (error) => error instanceof CsvError && error.line === 2 && error.column === 3);
	assert.throws(() => parseCsv("a,b\n1,2,3\n"), (error) => error instanceof CsvError && error.line === 2 && /expected 2 fields/.test(error.message));
	assert.throws(() => parseCsv('a\nx"y\n'), (error) => error instanceof CsvError && error.line === 2 && error.column === 2);
	assert.throws(() => parseCsv("a\n1\n", { required: ["b"] }), /missing required column "b"/);
});

const LEDGER = "sku,description,expected_qty\nA-1,Alpha,10\nB-2,Beta,5\nC-3,Gamma,7\n";

test("classifies match, short, over, not counted and unexpected", () => {
	const report = reconcile({ ledgerText: LEDGER, countsText: "sku,counted_qty\nA-1,10\nB-2,3\nB-2,4\nZ-9,1\n" });
	assert.deepEqual(
		report.rows.map(({ sku, variance, status }) => [sku, variance, status]),
		[["A-1", 0, "match"], ["B-2", 2, "over"], ["C-3", null, "not-counted"], ["Z-9", null, "unexpected"]],
	);
	assert.deepEqual(report.summary, { skus: 4, match: 1, short: 0, over: 1, "not-counted": 1, unexpected: 1 });
	assert.match(report.id, /^r-[0-9a-f]{12}$/);
	assert.equal(reconcile({ ledgerText: LEDGER, countsText: "sku,counted_qty\nA-1,10\nB-2,3\nB-2,4\nZ-9,1\n" }).id, report.id);
});

test("rejects non-integer quantities and duplicate ledger SKUs with file and line", () => {
	assert.throws(
		() => reconcile({ ledgerText: LEDGER, countsText: "sku,counted_qty\nA-1,ten\n", countsName: "c.csv" }),
		(error) => error instanceof CsvError && error.file === "c.csv" && error.line === 2 && /whole number/.test(error.message),
	);
	assert.throws(() => reconcile({ ledgerText: `${LEDGER}A-1,Again,1\n`, countsText: "sku,counted_qty\n" }), /duplicate SKU "A-1"/);
	assert.throws(() => reconcile({ ledgerText: LEDGER, countsText: "sku,counted_qty\nA-1,-3\n" }), /whole number/);
});
