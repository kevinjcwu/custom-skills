// Export-profile check (no browser, microphone, audio daemon or network).
//
// Encodes a short narrated clip with the single export profile, probes it
// back and measures its silence floor. Produce refuses to export unless this
// check passed on this host, and uses its measured threshold for the
// narration-present and silence windows of every audience export.
import fs from "node:fs";
import path from "node:path";
import { frameLevels, noiseFloor, readWav } from "./audio.mjs";
import { synthesizeNarration } from "./narration.mjs";
import { execCapture, throwIfCancelled } from "./proc-registry.mjs";
import { sha256File } from "./toolchain.mjs";

/** Sample rate used to decode exports back for level analysis. */
export const DECODE_RATE = 48000;
const WINDOW_MS = 10;

export const EXPORT_PROFILE = Object.freeze({
	videoCodec: "h264",
	videoProfile: "High",
	pixFmt: "yuv420p",
	width: 1280,
	height: 720,
	fps: 30,
	crf: 20,
	preset: "medium",
	audioCodec: "aac",
	audioProfile: "LC",
	sampleRate: 48000,
	channels: 2,
	audioBitrate: "160k",
	narratorLufs: -16,
});

export async function ffmpegRun(paths, args, env) {
	const result = await execCapture(paths.ffmpeg, ["-hide_banner", "-nostdin", "-v", "error", ...args], { env, timeoutMs: 600000 });
	if (result.code !== 0) {
		throw new Error(`ffmpeg failed (exit ${result.code}): ${result.stderr.trim().split("\n").slice(-3).join(" | ")}`);
	}
	return result;
}

/** ffprobe JSON of streams and format. */
export async function probeMedia(paths, file, env) {
	const result = await execCapture(paths.ffprobe, ["-v", "error", "-count_frames", "-show_streams", "-show_format", "-of", "json", file], { env, timeoutMs: 300000 });
	if (result.code !== 0) {
		throw new Error(`ffprobe failed: ${result.stderr.trim()}`);
	}
	return JSON.parse(result.stdout);
}

/** Checks a probe against the single export profile; returns failed field names. */
export function profileMismatches(probe, expectedFrames) {
	const video = probe.streams.filter((stream) => stream.codec_type === "video");
	const audio = probe.streams.filter((stream) => stream.codec_type === "audio");
	const v = video[0] ?? {};
	const a = audio[0] ?? {};
	const checks = {
		"one video stream": video.length === 1,
		"one audio stream": audio.length === 1,
		"video codec h264": v.codec_name === EXPORT_PROFILE.videoCodec,
		"video profile High": v.profile === EXPORT_PROFILE.videoProfile,
		"pixel format yuv420p": v.pix_fmt === EXPORT_PROFILE.pixFmt,
		"size 1280x720": v.width === EXPORT_PROFILE.width && v.height === EXPORT_PROFILE.height,
		"constant 30 fps": v.r_frame_rate === `${EXPORT_PROFILE.fps}/1` && v.avg_frame_rate === `${EXPORT_PROFILE.fps}/1`,
		"frame count equals edit arithmetic": Number(v.nb_read_frames ?? v.nb_frames) === expectedFrames,
		"audio codec aac": a.codec_name === EXPORT_PROFILE.audioCodec,
		"audio profile LC": a.profile === EXPORT_PROFILE.audioProfile,
		"audio 48 kHz": Number(a.sample_rate) === EXPORT_PROFILE.sampleRate,
		"audio stereo": a.channels === EXPORT_PROFILE.channels,
		"mp4 container": probe.format?.format_name?.includes("mp4") === true,
	};
	return Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
}

/** True when the moov atom precedes mdat (MP4 +faststart). */
export function moovBeforeMdat(file) {
	const fd = fs.openSync(file, "r");
	try {
		const size = fs.fstatSync(fd).size;
		let offset = 0;
		const head = Buffer.alloc(16);
		while (offset + 8 <= size) {
			fs.readSync(fd, head, 0, 16, offset);
			let length = head.readUInt32BE(0);
			const type = head.toString("latin1", 4, 8);
			if (type === "moov") {
				return true;
			}
			if (type === "mdat") {
				return false;
			}
			if (length === 1) {
				length = Number(head.readBigUInt64BE(8));
			}
			if (length < 8) {
				return false;
			}
			offset += length;
		}
		return false;
	} finally {
		fs.closeSync(fd);
	}
}

export async function decodeMono(paths, file, out, env) {
	await ffmpegRun(paths, ["-i", file, "-vn", "-ac", "1", "-ar", String(DECODE_RATE), "-c:a", "pcm_s16le", out], env);
	return readWav(out);
}

function check(name, pass, measured) {
	return { name, pass: Boolean(pass), measured };
}

/**
 * Export calibration: encodes a narrated clip with the single export profile
 * and measures its silence floor. No browser, microphone, audio daemon or
 * live route is started.
 *
 * @returns {Promise<object>} measurements with scope "export-only"
 */
export async function calibrateExport({ runDir, paths, log = () => {} }) {
	const dirs = Object.fromEntries(["audio", "work", "final"].map((name) => [name, path.join(runDir, name)]));
	for (const dir of Object.values(dirs)) {
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	}
	const env = {
		PATH: "/usr/bin:/bin",
		HOME: runDir,
		TMPDIR: dirs.work,
		XDG_CACHE_HOME: path.join(dirs.work, ".cache"),
		PYTHONDONTWRITEBYTECODE: "1",
		LANG: "C.UTF-8",
	};
	throwIfCancelled();
	log("checking the export profile and narration levels");
	const narratorWav = path.join(dirs.audio, "narrator.wav");
	const narrator = await synthesizeNarration({ text: "Export check. The narrator explains what is on screen.", outWav: narratorWav, paths });
	const leadMs = 1500;
	const tailMs = 1000;
	const totalFrames = Math.ceil(((leadMs + narrator.durationMs + tailMs) / 1000) * EXPORT_PROFILE.fps);
	const totalSec = totalFrames / EXPORT_PROFILE.fps;
	const finalMp4 = path.join(dirs.final, "export-check.mp4");
	await ffmpegRun(paths, [
		"-f", "lavfi", "-i", `color=c=black:s=${EXPORT_PROFILE.width}x${EXPORT_PROFILE.height}:r=${EXPORT_PROFILE.fps}:d=${totalSec.toFixed(6)}`,
		"-i", narratorWav,
		"-filter_complex", `anullsrc=r=${EXPORT_PROFILE.sampleRate}:cl=mono,atrim=duration=${(leadMs / 1000).toFixed(3)}[lead];[1:a]loudnorm=I=${EXPORT_PROFILE.narratorLufs}:TP=-1.5:LRA=11,aresample=${EXPORT_PROFILE.sampleRate},aformat=channel_layouts=mono[narr];[lead][narr]concat=n=2:v=0:a=1,pan=stereo|c0=c0|c1=c0,apad,atrim=end=${totalSec.toFixed(6)}[a]`,
		"-map", "0:v", "-map", "[a]",
		"-c:v", "libx264", "-profile:v", "high", "-preset", EXPORT_PROFILE.preset, "-crf", String(EXPORT_PROFILE.crf), "-r", String(EXPORT_PROFILE.fps), "-pix_fmt", EXPORT_PROFILE.pixFmt,
		"-c:a", "aac", "-profile:a", "aac_low", "-b:a", EXPORT_PROFILE.audioBitrate, "-ar", String(EXPORT_PROFILE.sampleRate), "-ac", String(EXPORT_PROFILE.channels),
		"-movflags", "+faststart", "-frames:v", String(totalFrames), finalMp4,
	], env);
	const probe = await probeMedia(paths, finalMp4, env);
	const mismatches = profileMismatches(probe, totalFrames);
	const faststart = moovBeforeMdat(finalMp4);
	const decoded = await decodeMono(paths, finalMp4, path.join(dirs.work, "export-decoded.wav"), env);
	const exportFrames = frameLevels(decoded.samples, DECODE_RATE, WINDOW_MS);
	const exportFloor = noiseFloor(exportFrames.levels.slice(0, Math.floor((leadMs - 200) / WINDOW_MS)));
	const exportThreshold = exportFloor.p95Db + Math.max(3, exportFloor.spreadDb);
	const windows = {
		baseline: [0, leadMs - 200],
		narrator: [leadMs + 100, leadMs + narrator.durationMs - 100],
		after: [leadMs + narrator.durationMs + 400, totalSec * 1000 - 100],
	};
	const levels = Object.fromEntries(Object.entries(windows).map(([name, [from, to]]) => [name, { fromMs: Math.round(from), toMs: Math.round(to), activeFraction: activeFraction(exportFrames, from, to, exportThreshold) }]));
	const checks = [
		check("export matches the single export profile", mismatches.length === 0 && faststart, { mismatches, faststart, expectedFrames: totalFrames }),
		check("export: baseline window is silent", levels.baseline.activeFraction === 0, levels.baseline),
		check("export: narrator audible", levels.narrator.activeFraction > 0.3, levels.narrator),
		check("export: silent after the narration", levels.after.activeFraction === 0, levels.after),
	];
	const measurements = {
		schema: "sdp.calibration.v1",
		scope: "export-only",
		createdAt: new Date().toISOString(),
		floors: { export: exportFloor, exportThresholdDb: exportThreshold },
		export: { profile: EXPORT_PROFILE, probe: summarizeProbe(probe), windows: levels },
		checks,
		passed: checks.every((entry) => entry.pass),
	};
	measurements.files = [finalMp4, narratorWav].map((file) => ({ path: path.relative(runDir, file), sha256: sha256File(file), bytes: fs.statSync(file).size }));
	fs.writeFileSync(path.join(runDir, "calibration.json"), `${JSON.stringify(measurements, null, "\t")}\n`, { flag: "wx" });
	return measurements;
}

export function activeFraction(frames, fromMs, toMs, thresholdDb) {
	const from = Math.max(0, Math.floor(fromMs / frames.frameMs));
	const to = Math.min(frames.levels.length, Math.ceil(toMs / frames.frameMs));
	if (to <= from) {
		return 0;
	}
	let active = 0;
	for (let index = from; index < to; index += 1) {
		if (frames.levels[index] > thresholdDb) {
			active += 1;
		}
	}
	return active / (to - from);
}

function summarizeProbe(probe) {
	const pick = (stream) => stream && { codec: stream.codec_name, profile: stream.profile, pixFmt: stream.pix_fmt, width: stream.width, height: stream.height, rFrameRate: stream.r_frame_rate, avgFrameRate: stream.avg_frame_rate, frames: stream.nb_read_frames ?? stream.nb_frames, sampleRate: stream.sample_rate, channels: stream.channels, bitRate: stream.bit_rate, duration: stream.duration };
	return {
		duration: probe.format?.duration,
		formatName: probe.format?.format_name,
		video: pick(probe.streams.find((stream) => stream.codec_type === "video")),
		audio: pick(probe.streams.find((stream) => stream.codec_type === "audio")),
	};
}

