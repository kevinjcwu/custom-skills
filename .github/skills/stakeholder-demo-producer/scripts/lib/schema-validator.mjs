// A deliberately small JSON Schema subset validator.
//
// It is not a full JSON Schema implementation. It supports only the keywords
// listed below and rejects any other keyword in a schema definition, so a
// bundled schema can never silently rely on unenforced behaviour.
import { canonicalJson } from "./canonical.mjs";
import { approvedAbsoluteErrors, relativeRefErrors } from "./paths.mjs";

export const SUPPORTED_KEYWORDS = Object.freeze([
	"type",
	"properties",
	"required",
	"additionalProperties",
	"items",
	"enum",
	"const",
	"pattern",
	"minLength",
	"maxLength",
	"minimum",
	"maximum",
	"minItems",
	"maxItems",
	"uniqueItems",
	"$ref",
	"x-sdp-path",
]);
const ANNOTATIONS = new Set(["title", "description", "$comment"]);
const ROOT_ONLY = new Set(["$schema", "$id", "$defs"]);
const TYPES = new Set([
	"object",
	"array",
	"string",
	"integer",
	"number",
	"boolean",
	"null",
]);
const PATH_KINDS = new Set(["relative", "relative-dir", "approved-absolute"]);
const KEYWORDS = new Set(SUPPORTED_KEYWORDS);

export class SchemaDefinitionError extends Error {
	constructor(pointer, message) {
		super(`schema ${pointer || "/"}: ${message}`);
		this.name = "SchemaDefinitionError";
		this.pointer = pointer;
	}
}

function escapePointer(segment) {
	return String(segment).replaceAll("~", "~0").replaceAll("/", "~1");
}

function isPlainObject(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonNegativeInteger(value) {
	return Number.isInteger(value) && value >= 0;
}

function checkDefinition(schema, pointer, context, isRoot) {
	if (!isPlainObject(schema)) {
		throw new SchemaDefinitionError(pointer, "a schema must be an object");
	}
	for (const key of Object.keys(schema)) {
		if (KEYWORDS.has(key) || ANNOTATIONS.has(key)) {
			continue;
		}
		if (isRoot && ROOT_ONLY.has(key)) {
			continue;
		}
		throw new SchemaDefinitionError(pointer, `unsupported keyword "${key}"`);
	}
	if ("$ref" in schema) {
		const siblings = Object.keys(schema).filter(
			(key) => key !== "$ref" && !ANNOTATIONS.has(key),
		);
		if (siblings.length > 0) {
			throw new SchemaDefinitionError(pointer, "$ref must not have sibling keywords");
		}
		const match = /^#\/\$defs\/([A-Za-z0-9_-]+)$/.exec(schema.$ref);
		if (typeof schema.$ref !== "string" || !match) {
			throw new SchemaDefinitionError(pointer, "$ref must be '#/$defs/<name>'");
		}
		if (!Object.hasOwn(context.defs, match[1])) {
			throw new SchemaDefinitionError(pointer, `unknown $ref target "${match[1]}"`);
		}
		return;
	}
	if ("type" in schema) {
		const types = Array.isArray(schema.type) ? schema.type : [schema.type];
		if (types.length === 0 || types.some((type) => !TYPES.has(type))) {
			throw new SchemaDefinitionError(pointer, "invalid type");
		}
	}
	if ("properties" in schema) {
		if (!isPlainObject(schema.properties)) {
			throw new SchemaDefinitionError(pointer, "properties must be an object");
		}
		for (const [name, child] of Object.entries(schema.properties)) {
			checkDefinition(
				child,
				`${pointer}/properties/${escapePointer(name)}`,
				context,
				false,
			);
		}
	}
	if ("required" in schema) {
		if (
			!Array.isArray(schema.required) ||
			schema.required.some((name) => typeof name !== "string") ||
			new Set(schema.required).size !== schema.required.length
		) {
			throw new SchemaDefinitionError(pointer, "required must be unique strings");
		}
		for (const name of schema.required) {
			if (!isPlainObject(schema.properties) || !Object.hasOwn(schema.properties, name)) {
				throw new SchemaDefinitionError(
					pointer,
					`required "${name}" is not declared in properties`,
				);
			}
		}
	}
	if ("additionalProperties" in schema) {
		if (typeof schema.additionalProperties !== "boolean") {
			checkDefinition(
				schema.additionalProperties,
				`${pointer}/additionalProperties`,
				context,
				false,
			);
		}
	}
	if ("items" in schema) {
		checkDefinition(schema.items, `${pointer}/items`, context, false);
	}
	if ("enum" in schema) {
		if (!Array.isArray(schema.enum) || schema.enum.length === 0) {
			throw new SchemaDefinitionError(pointer, "enum must be a non-empty array");
		}
	}
	if ("pattern" in schema) {
		if (typeof schema.pattern !== "string") {
			throw new SchemaDefinitionError(pointer, "pattern must be a string");
		}
		try {
			new RegExp(schema.pattern, "u");
		} catch {
			throw new SchemaDefinitionError(pointer, "pattern does not compile");
		}
	}
	for (const key of ["minLength", "maxLength", "minItems", "maxItems"]) {
		if (key in schema && !isNonNegativeInteger(schema[key])) {
			throw new SchemaDefinitionError(pointer, `${key} must be a non-negative integer`);
		}
	}
	for (const key of ["minimum", "maximum"]) {
		if (key in schema && !Number.isFinite(schema[key])) {
			throw new SchemaDefinitionError(pointer, `${key} must be a finite number`);
		}
	}
	if ("uniqueItems" in schema && typeof schema.uniqueItems !== "boolean") {
		throw new SchemaDefinitionError(pointer, "uniqueItems must be a boolean");
	}
	if ("x-sdp-path" in schema) {
		const kind = schema["x-sdp-path"];
		if (!PATH_KINDS.has(kind)) {
			throw new SchemaDefinitionError(pointer, "x-sdp-path has an unknown kind");
		}
		if (schema.type !== "string") {
			throw new SchemaDefinitionError(pointer, "x-sdp-path requires type string");
		}
		if (kind === "approved-absolute" && !context.allowApprovedAbsolute) {
			throw new SchemaDefinitionError(
				pointer,
				"approved-absolute paths are only allowed in run-authorization",
			);
		}
	}
}

function typeMatches(type, value) {
	switch (type) {
		case "object":
			return isPlainObject(value);
		case "array":
			return Array.isArray(value);
		case "string":
			return typeof value === "string";
		case "integer":
			return Number.isInteger(value);
		case "number":
			return typeof value === "number" && Number.isFinite(value);
		case "boolean":
			return typeof value === "boolean";
		case "null":
			return value === null;
		default:
			return false;
	}
}

function sameJson(a, b) {
	try {
		return canonicalJson(a) === canonicalJson(b);
	} catch {
		return false;
	}
}

function validateNode(schema, value, pointer, context, errors) {
	if ("$ref" in schema) {
		const name = schema.$ref.slice("#/$defs/".length);
		validateNode(context.defs[name], value, pointer, context, errors);
		return;
	}
	const at = pointer || "/";
	if ("type" in schema) {
		const types = Array.isArray(schema.type) ? schema.type : [schema.type];
		if (!types.some((type) => typeMatches(type, value))) {
			errors.push({ path: at, message: `must be of type ${types.join("|")}` });
			return;
		}
	}
	if ("const" in schema && !sameJson(schema.const, value)) {
		errors.push({ path: at, message: `must equal ${JSON.stringify(schema.const)}` });
	}
	if ("enum" in schema && !schema.enum.some((option) => sameJson(option, value))) {
		errors.push({
			path: at,
			message: `must be one of ${schema.enum.map((option) => JSON.stringify(option)).join(", ")}`,
		});
	}
	if (typeof value === "string") {
		const length = [...value].length;
		if ("minLength" in schema && length < schema.minLength) {
			errors.push({ path: at, message: `must have at least ${schema.minLength} characters` });
		}
		if ("maxLength" in schema && length > schema.maxLength) {
			errors.push({ path: at, message: `must have at most ${schema.maxLength} characters` });
		}
		if ("pattern" in schema && !new RegExp(schema.pattern, "u").test(value)) {
			errors.push({ path: at, message: `must match pattern ${schema.pattern}` });
		}
		if ("x-sdp-path" in schema) {
			const kind = schema["x-sdp-path"];
			const problems =
				kind === "approved-absolute"
					? approvedAbsoluteErrors(value)
					: relativeRefErrors(value, { allowDot: kind === "relative-dir" });
			for (const problem of problems) {
				errors.push({ path: at, message: `path ${problem}` });
			}
		}
	}
	if (typeof value === "number") {
		if ("minimum" in schema && value < schema.minimum) {
			errors.push({ path: at, message: `must be >= ${schema.minimum}` });
		}
		if ("maximum" in schema && value > schema.maximum) {
			errors.push({ path: at, message: `must be <= ${schema.maximum}` });
		}
	}
	if (Array.isArray(value)) {
		if ("minItems" in schema && value.length < schema.minItems) {
			errors.push({ path: at, message: `must have at least ${schema.minItems} items` });
		}
		if ("maxItems" in schema && value.length > schema.maxItems) {
			errors.push({ path: at, message: `must have at most ${schema.maxItems} items` });
		}
		if (schema.uniqueItems === true) {
			const seen = new Set();
			for (const item of value) {
				const key = canonicalJson(item);
				if (seen.has(key)) {
					errors.push({ path: at, message: "must not contain duplicate items" });
					break;
				}
				seen.add(key);
			}
		}
		if ("items" in schema) {
			value.forEach((item, index) =>
				validateNode(schema.items, item, `${pointer}/${index}`, context, errors),
			);
		}
	}
	if (isPlainObject(value)) {
		const properties = schema.properties ?? {};
		for (const name of schema.required ?? []) {
			if (!Object.hasOwn(value, name)) {
				errors.push({ path: at, message: `missing required property "${name}"` });
			}
		}
		for (const [name, item] of Object.entries(value)) {
			const childPointer = `${pointer}/${escapePointer(name)}`;
			if (Object.hasOwn(properties, name)) {
				validateNode(properties[name], item, childPointer, context, errors);
			} else if (schema.additionalProperties === false) {
				errors.push({ path: childPointer, message: "is not an allowed property" });
			} else if (isPlainObject(schema.additionalProperties)) {
				validateNode(schema.additionalProperties, item, childPointer, context, errors);
			}
		}
	}
}

/**
 * Checks a schema definition and returns a validation function.
 * @param {object} schema
 * @param {{allowApprovedAbsolute?: boolean}} [options]
 * @returns {(value: unknown) => {path: string, message: string}[]}
 */
export function compileSchema(schema, options = {}) {
	if (!isPlainObject(schema)) {
		throw new SchemaDefinitionError("", "a schema must be an object");
	}
	const defs = schema.$defs ?? {};
	if (!isPlainObject(defs)) {
		throw new SchemaDefinitionError("/$defs", "$defs must be an object");
	}
	const context = {
		defs,
		allowApprovedAbsolute: options.allowApprovedAbsolute === true,
	};
	for (const [name, child] of Object.entries(defs)) {
		checkDefinition(child, `/$defs/${escapePointer(name)}`, context, false);
	}
	checkDefinition(schema, "", context, true);
	return (value) => {
		const errors = [];
		validateNode(schema, value, "", context, errors);
		return errors;
	};
}
