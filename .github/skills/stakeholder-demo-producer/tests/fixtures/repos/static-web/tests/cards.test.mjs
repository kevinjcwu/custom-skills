// Synthetic fixture test file. It is inventoried by discovery, never run.
import { test } from "node:test";
import assert from "node:assert/strict";

test("renders three recipe cards", () => {
	assert.equal(["Tomato soup", "Lemon rice", "Oat cookies"].length, 3);
});
