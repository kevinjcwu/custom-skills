// Minimal RFC 4180 subset: comma separator, optional double-quoted fields
// with "" escapes, LF or CRLF line endings, mandatory header row.
// Every error carries the 1-based line and column it was found at.

export class CsvError extends Error {
	constructor(message, line, column) {
		super(message);
		this.name = "CsvError";
		this.line = line;
		this.column = column;
	}
}

/**
 * Parses CSV text into records keyed by header names.
 * @param {string} text
 * @param {{required?: string[]}} [options]
 * @returns {{header: string[], rows: {line: number, values: Record<string, string>}[]}}
 */
export function parseCsv(text, { required = [] } = {}) {
	const records = [];
	let field = "";
	let record = [];
	let recordLine = 1;
	let line = 1;
	let column = 0;
	let quoted = false;
	let quoteStart = null;
	let fieldStarted = false;

	const endField = () => {
		record.push(field);
		field = "";
		fieldStarted = false;
	};
	const endRecord = () => {
		endField();
		if (!(record.length === 1 && record[0] === "")) {
			records.push({ line: recordLine, fields: record });
		}
		record = [];
	};

	for (let index = 0; index < text.length; index += 1) {
		const char = text[index];
		column += 1;
		if (quoted) {
			if (char === '"') {
				if (text[index + 1] === '"') {
					field += '"';
					index += 1;
					column += 1;
				} else {
					quoted = false;
					const next = text[index + 1];
					if (next !== undefined && next !== "," && next !== "\n" && next !== "\r") {
						throw new CsvError("unexpected character after closing quote", line, column + 1);
					}
				}
			} else {
				if (char === "\n") {
					line += 1;
					column = 0;
				}
				field += char;
			}
			continue;
		}
		if (char === '"') {
			if (fieldStarted) {
				throw new CsvError("quote inside an unquoted field", line, column);
			}
			quoted = true;
			fieldStarted = true;
			quoteStart = { line, column };
		} else if (char === ",") {
			endField();
		} else if (char === "\r" && text[index + 1] === "\n") {
			// the following \n ends the record
		} else if (char === "\n") {
			endRecord();
			line += 1;
			column = 0;
			recordLine = line;
		} else {
			field += char;
			fieldStarted = true;
		}
	}
	if (quoted) {
		throw new CsvError("unterminated quoted field", quoteStart.line, quoteStart.column);
	}
	endRecord();

	if (records.length === 0) {
		throw new CsvError("missing header row", 1, 1);
	}
	const header = records[0].fields.map((name) => name.trim());
	for (const name of required) {
		if (!header.includes(name)) {
			throw new CsvError(`missing required column "${name}"`, records[0].line, 1);
		}
	}
	const rows = records.slice(1).map(({ line: rowLine, fields }) => {
		if (fields.length !== header.length) {
			throw new CsvError(`expected ${header.length} fields, found ${fields.length}`, rowLine, 1);
		}
		return { line: rowLine, values: Object.fromEntries(header.map((name, index) => [name, fields[index]])) };
	});
	return { header, rows };
}
