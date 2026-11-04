// Synthetic fixture test file. It is inventoried by discovery, never run.
import { test } from "node:test";
import assert from "node:assert/strict";

test("counts added items", () => {
	assert.equal(["a", "b"].length, 2);
});

test("reports health", () => {
	assert.ok(true);
});
