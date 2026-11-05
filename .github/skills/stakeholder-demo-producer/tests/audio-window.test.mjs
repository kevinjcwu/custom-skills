import { test } from "node:test";
import assert from "node:assert/strict";
import { rmsActivityBounds } from "../scripts/lib/audio.mjs";

test("activity comparison uses the recorder RMS window, not a shorter quiet-tail detector", () => {
	const rate = 48000;
	const samples = new Float32Array(rate);
	samples.fill(0.1, 0, rate / 2);
	samples.fill(0.0007, Math.round(rate * 0.8), Math.round(rate * 0.81));
	const short = rmsActivityBounds(samples, rate, {
		windowMs: 10,
		thresholdRms: 0.0005,
	});
	const comparable = rmsActivityBounds(samples, rate, {
		windowMs: (1024 / 44100) * 1000,
		thresholdRms: 0.0005,
	});
	assert.ok(short.lastMs >= 800);
	assert.ok(comparable.lastMs < 550);
	assert.equal(
		rmsActivityBounds(new Float32Array(rate), rate, {
			windowMs: 25,
			thresholdRms: 0.0005,
		}).firstMs,
		null,
	);
});

test("activity comparison includes a zero-padded final partial window and rejects nonfinite samples", () => {
	const samples = new Float32Array(11);
	samples[10] = 0.1;
	assert.equal(rmsActivityBounds(samples, 1000, { windowMs: 10, thresholdRms: 0.001 }).lastMs, 11);
	samples[10] = NaN;
	assert.throws(() => rmsActivityBounds(samples, 1000, { windowMs: 10, thresholdRms: 0.001 }), /nonfinite/);
	assert.throws(() => rmsActivityBounds(new Float32Array(1), 0, { windowMs: 10, thresholdRms: 0.001 }), /invalid/);
});
