import { test } from "node:test";
import assert from "node:assert/strict";
import {
	compileSchema,
	SchemaDefinitionError,
	SUPPORTED_KEYWORDS,
} from "../scripts/lib/schema-validator.mjs";
import { CONTRACT_NAMES, loadSchema } from "../scripts/lib/contracts.mjs";

const nested = {
	type: "object",
	additionalProperties: false,
	required: ["name", "items"],
	properties: {
		name: { type: "string", minLength: 1, maxLength: 5, pattern: "^[a-z]+$" },
		items: {
			type: "array",
			minItems: 1,
			maxItems: 2,
			uniqueItems: true,
			items: {
				type: "object",
				additionalProperties: false,
				required: ["n"],
				properties: {
					n: { type: "integer", minimum: 0, maximum: 9 },
					kind: { enum: ["a", "b"] },
					fixed: { const: "x" },
				},
			},
		},
	},
};

test("accepts a valid nested document", () => {
	const validate = compileSchema(nested);
	assert.deepEqual(validate({ name: "abc", items: [{ n: 1, kind: "a", fixed: "x" }] }), []);
});

test("reports nested type, required, unknown key, enum, const and bounds errors", () => {
	const validate = compileSchema(nested);
	const errors = validate({
		name: "ABCDEFG",
		extra: true,
		items: [{ n: 1.5, kind: "c", fixed: "y", apiKey: "k" }, { n: 1.5, kind: "c", fixed: "y", apiKey: "k" }, {}],
	});
	const paths = errors.map((error) => error.path);
	for (const expected of [
		"/name",
		"/extra",
		"/items",
		"/items/0/n",
		"/items/0/kind",
		"/items/0/fixed",
		"/items/0/apiKey",
		"/items/2",
	]) {
		assert.ok(paths.includes(expected), `missing error at ${expected}: ${JSON.stringify(errors)}`);
	}
	assert.ok(validate({ items: [] }).some((error) => error.message.includes("name")));
});

test("rejects unsupported schema keywords instead of ignoring them", () => {
	for (const keyword of ["oneOf", "anyOf", "allOf", "if", "format", "patternProperties", "not"]) {
		assert.throws(
			() => compileSchema({ type: "object", [keyword]: [] }),
			SchemaDefinitionError,
			keyword,
		);
	}
	assert.ok(!SUPPORTED_KEYWORDS.includes("oneOf"));
});

test("rejects non-local $ref and $ref with siblings", () => {
	assert.throws(() => compileSchema({ $ref: "https://example.invalid/x" }), SchemaDefinitionError);
	assert.throws(
		() => compileSchema({ $defs: { a: { type: "string" } }, properties: { x: { $ref: "#/$defs/a", type: "string" } } }),
		SchemaDefinitionError,
	);
	assert.throws(() => compileSchema({ properties: { x: { $ref: "#/$defs/missing" } } }), SchemaDefinitionError);
});

test("approved-absolute paths are only allowed when explicitly enabled", () => {
	const schema = { type: "string", "x-sdp-path": "approved-absolute" };
	assert.throws(() => compileSchema(schema), SchemaDefinitionError);
	const validate = compileSchema(schema, { allowApprovedAbsolute: true });
	assert.deepEqual(validate("/approved/dir"), []);
	assert.notDeepEqual(validate("relative/dir"), []);
	assert.notDeepEqual(validate("/approved/../escape"), []);
});

test("relative x-sdp-path rejects traversal and absolute forms", () => {
	const validate = compileSchema({ type: "string", "x-sdp-path": "relative" });
	assert.deepEqual(validate("docs/readme.md"), []);
	for (const bad of ["../x", "a/../b", "/etc/passwd", "C:/x", "C:\\x", "\\\\server\\share", "a\\b", "a\u0000b", "", "a//b", "./a", "."]) {
		assert.notDeepEqual(validate(bad), [], JSON.stringify(bad));
	}
	const dir = compileSchema({ type: "string", "x-sdp-path": "relative-dir" });
	assert.deepEqual(dir("."), []);
	assert.notDeepEqual(dir(".."), []);
});

test("every bundled schema compiles and closes every object", () => {
	for (const name of CONTRACT_NAMES) {
		const schema = loadSchema(name);
		assert.doesNotThrow(() => compileSchema(schema, { allowApprovedAbsolute: name === "run-authorization" }));
		assert.equal(schema.properties.schema.const, `${name}.v1`);
		const visit = (node, at) => {
			if (node && typeof node === "object") {
				if (node.type === "object" && node.properties) {
					assert.equal(node.additionalProperties, false, `${name}${at} must close additionalProperties`);
				}
				for (const [key, child] of Object.entries(node)) {
					visit(child, `${at}/${key}`);
				}
			}
		};
		visit(schema, "");
		if (name !== "run-authorization") {
			assert.ok(!JSON.stringify(schema).includes("approved-absolute"), name);
		}
	}
});
