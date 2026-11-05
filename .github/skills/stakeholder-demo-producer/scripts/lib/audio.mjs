// PCM WAV read/write and level analysis used for calibration and QA.
// Thresholds are always derived from a measured noise floor; nothing here
// hard-codes "loud enough".
import fs from "node:fs";

/** Match the capture analyser's RMS window when comparing speech landmarks. */
export function rmsActivityBounds(samples, sampleRate, { windowMs, thresholdRms }) {
	const size = Math.round(sampleRate * windowMs / 1000);
	if (
		!(samples instanceof Float32Array) || !Number.isFinite(sampleRate) || sampleRate <= 0 ||
		!Number.isFinite(windowMs) || windowMs <= 0 || !Number.isSafeInteger(size) || size < 1 ||
		!Number.isFinite(thresholdRms) || thresholdRms <= 0 || thresholdRms > 1
	) throw new Error("invalid RMS activity window");
	let firstMs = null;
	let lastMs = null;
	for (let i = 0; i < samples.length; i += size) {
		const end = Math.min(i + size, samples.length);
		let sum = 0;
		for (let j = i; j < end; j++) {
			if (!Number.isFinite(samples[j])) throw new Error("nonfinite audio sample");
			sum += samples[j] ** 2;
		}
		if (Math.sqrt(sum / size) > thresholdRms) {
			firstMs ??= i / sampleRate * 1000;
			lastMs = end / sampleRate * 1000;
		}
	}
	return { firstMs, lastMs };
}

/** @returns {{sampleRate: number, channels: number, samples: Float32Array}} mono floats in [-1, 1] (channels averaged) */
export function readWav(file) {
	const buffer = fs.readFileSync(file);
	if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
		throw new Error("not a RIFF/WAVE file");
	}
	let offset = 12;
	let format = null;
	while (offset + 8 <= buffer.length) {
		const id = buffer.toString("ascii", offset, offset + 4);
		const size = buffer.readUInt32LE(offset + 4);
		const body = offset + 8;
		if (id === "fmt ") {
			format = { audioFormat: buffer.readUInt16LE(body), channels: buffer.readUInt16LE(body + 2), sampleRate: buffer.readUInt32LE(body + 4), bits: buffer.readUInt16LE(body + 14) };
		} else if (id === "data") {
			if (!format || format.audioFormat !== 1 || format.bits !== 16) {
				throw new Error("only 16-bit PCM WAV is supported");
			}
			const end = size === 0xffffffff || body + size > buffer.length ? buffer.length : body + size;
			return { sampleRate: format.sampleRate, channels: format.channels, samples: pcm16ToFloat(buffer.subarray(body, end), format.channels) };
		}
		offset = body + size + (size % 2);
	}
	throw new Error("WAV has no data chunk");
}

export function pcm16ToFloat(bytes, channels = 1) {
	const frames = Math.floor(bytes.length / (2 * channels));
	const out = new Float32Array(frames);
	for (let frame = 0; frame < frames; frame += 1) {
		let sum = 0;
		for (let channel = 0; channel < channels; channel += 1) {
			sum += bytes.readInt16LE((frame * channels + channel) * 2);
		}
		out[frame] = sum / channels / 32768;
	}
	return out;
}

export function floatToPcm16(samples) {
	const out = Buffer.alloc(samples.length * 2);
	for (let index = 0; index < samples.length; index += 1) {
		out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[index] * 32767))), index * 2);
	}
	return out;
}

export function writeWav(file, samples, sampleRate) {
	writePcm16Wav(file, floatToPcm16(samples), sampleRate);
}

/**
 * Writes mono PCM16 bytes unchanged under a WAV header.
 * @param {string} file
 * @param {Buffer} data little-endian s16 mono
 * @param {number} sampleRate
 * @param {{flag?: string}} [options] use flag "wx" for write-once takes
 */
export function writePcm16Wav(file, data, sampleRate, { flag = "w" } = {}) {
	const header = Buffer.alloc(44);
	header.write("RIFF", 0, "ascii");
	header.writeUInt32LE(36 + data.length, 4);
	header.write("WAVEfmt ", 8, "ascii");
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(1, 20);
	header.writeUInt16LE(1, 22);
	header.writeUInt32LE(sampleRate, 24);
	header.writeUInt32LE(sampleRate * 2, 28);
	header.writeUInt16LE(2, 32);
	header.writeUInt16LE(16, 34);
	header.write("data", 36, "ascii");
	header.writeUInt32LE(data.length, 40);
	fs.writeFileSync(file, Buffer.concat([header, data]), { flag });
}

const toDb = (rms) => (rms > 0 ? 20 * Math.log10(rms) : -120);

/** RMS level per frame, in dBFS. */
export function frameLevels(samples, sampleRate, frameMs = 10) {
	const size = Math.max(1, Math.round((sampleRate * frameMs) / 1000));
	const levels = [];
	for (let start = 0; start + size <= samples.length; start += size) {
		let sum = 0;
		for (let index = start; index < start + size; index += 1) {
			sum += samples[index] * samples[index];
		}
		levels.push(toDb(Math.sqrt(sum / size)));
	}
	return { frameMs, levels };
}

function percentile(sorted, p) {
	if (sorted.length === 0) {
		return -120;
	}
	return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * (sorted.length - 1))))];
}

/**
 * Noise floor of a recording known to contain only background: median level
 * and the 95th-percentile spread above it.
 */
export function noiseFloor(levels) {
	const sorted = [...levels].sort((a, b) => a - b);
	const median = percentile(sorted, 50);
	return { medianDb: median, p95Db: percentile(sorted, 95), spreadDb: percentile(sorted, 95) - median };
}

/**
 * Active segments: runs of frames above the measured floor's p95 by at least
 * its own spread (min 3 dB so digital silence still has a margin), lasting
 * at least minMs, merged across gaps shorter than gapMs.
 */
export function activeSegments({ frameMs, levels }, floor, { minMs = 60, gapMs = 200 } = {}) {
	const threshold = floor.p95Db + Math.max(3, floor.spreadDb);
	const raw = [];
	let start = null;
	levels.forEach((level, index) => {
		if (level > threshold && start === null) {
			start = index;
		} else if (level <= threshold && start !== null) {
			raw.push([start, index]);
			start = null;
		}
	});
	if (start !== null) {
		raw.push([start, levels.length]);
	}
	const merged = [];
	for (const segment of raw) {
		const last = merged.at(-1);
		if (last && (segment[0] - last[1]) * frameMs < gapMs) {
			last[1] = segment[1];
		} else {
			merged.push([...segment]);
		}
	}
	return {
		thresholdDb: threshold,
		segments: merged.filter(([a, b]) => (b - a) * frameMs >= minMs).map(([a, b]) => ({ startMs: a * frameMs, endMs: b * frameMs, peakDb: Math.max(...levels.slice(a, b)) })),
	};
}

/** Goertzel power of one frequency over a window, as dBFS-like level. */
export function toneLevel(samples, sampleRate, frequency, startSample = 0, length = samples.length - startSample) {
	const k = (2 * Math.PI * frequency) / sampleRate;
	const coefficient = 2 * Math.cos(k);
	let s1 = 0;
	let s2 = 0;
	for (let index = startSample; index < startSample + length; index += 1) {
		const s0 = samples[index] + coefficient * s1 - s2;
		s2 = s1;
		s1 = s0;
	}
	const power = s1 * s1 + s2 * s2 - coefficient * s1 * s2;
	return toDb((2 * Math.sqrt(Math.max(0, power))) / length / Math.SQRT2);
}

/** First frame (ms) where the tone stands out from the floor, scanning in windows. */
export function toneOnsetMs(samples, sampleRate, frequency, floorDb, windowMs = 10) {
	const size = Math.round((sampleRate * windowMs) / 1000);
	for (let start = 0; start + size <= samples.length; start += size) {
		if (toneLevel(samples, sampleRate, frequency, start, size) > floorDb + 20) {
			return (start / sampleRate) * 1000;
		}
	}
	return null;
}

/**
 * Normalised cross-correlation of two level envelopes over lags; used to
 * show that a source signal is (or is not) present in another recording.
 */
export function envelopeCorrelation(a, b, maxLagFrames = 50) {
	const norm = (values) => {
		const mean = values.reduce((sum, value) => sum + value, 0) / (values.length || 1);
		const centred = values.map((value) => value - mean);
		const energy = Math.sqrt(centred.reduce((sum, value) => sum + value * value, 0)) || 1;
		return centred.map((value) => value / energy);
	};
	const x = norm(a);
	const y = norm(b);
	let best = { lagFrames: 0, coefficient: -1 };
	for (let lag = -maxLagFrames; lag <= maxLagFrames; lag += 1) {
		let sum = 0;
		for (let index = 0; index < x.length; index += 1) {
			const other = index + lag;
			if (other >= 0 && other < y.length) {
				sum += x[index] * y[other];
			}
		}
		if (sum > best.coefficient) {
			best = { lagFrames: lag, coefficient: sum };
		}
	}
	return best;
}
