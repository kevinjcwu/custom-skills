import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeTempDir } from "./helpers.mjs";
import { exportReview } from "../scripts/lib/review-export.mjs";
import { toolPaths, sha256File } from "../scripts/lib/toolchain.mjs";
import { readWav, writeWav } from "../scripts/lib/audio.mjs";
import {
	ffmpegRun,
	probeMedia,
	profileMismatches,
} from "../scripts/lib/export-check.mjs";
import { withCancellation } from "../scripts/lib/proc-registry.mjs";
import { holdMediaLock } from "./helpers.mjs";
import process from "node:process";

test(
	"review export converts 25 fps footage with fractional duration to exact 30 fps edit arithmetic",
	{
		skip:
			!process.env.SDP_RUNTIME_DIR &&
			"optional local media runtime not supplied",
	},
	async (t) => {
		await holdMediaLock(t);
		const temp = makeTempDir();
		t.after(temp.cleanup);
		const paths = toolPaths(process.env.SDP_RUNTIME_DIR);
		const screen = path.join(temp.dir, "screen.webm");
		const outDir = path.join(temp.dir, "out");
		fs.mkdirSync(outDir);
		const env = {
			PATH: "/usr/bin:/bin",
			HOME: temp.dir,
			TMPDIR: temp.dir,
			PYTHONDONTWRITEBYTECODE: "1",
			PYTHONNOUSERSITE: "1",
		};
		const controller = new AbortController();
		const timer = setTimeout(
			() => controller.abort(new Error("export regression deadline")),
			120_000,
		);
		try {
			await withCancellation(controller.signal, async () => {
				const rawFrames = Buffer.alloc(64 * 36 * 3 * 32);
				for (let frame = 0; frame < 32; frame++) {
					for (let pixel = 0; pixel < 64 * 36; pixel++) {
						const offset = (frame * 64 * 36 + pixel) * 3;
						rawFrames[offset] = 20 + frame * 7;
						rawFrames[offset + 1] = 60;
						rawFrames[offset + 2] = 120;
					}
				}
				const rawSource = path.join(temp.dir, "source.rgb");
				fs.writeFileSync(rawSource, rawFrames);
				await ffmpegRun(
					paths,
					[
						"-n",
						"-f",
						"rawvideo",
						"-pixel_format",
						"rgb24",
						"-video_size",
						"64x36",
						"-framerate",
						"25",
						"-i",
						rawSource,
						"-c:v",
						"libvpx",
						screen,
					],
					env,
				);
				const sourceHash = sha256File(screen);
				const source = await probeMedia(paths, screen, env);
				const inputWav = path.join(temp.dir, "participant.wav");
				const samples = new Float32Array(24000);
				for (let i = 0; i < samples.length; i++) samples[i] = Math.sin(i / 24000 * 880 * Math.PI) * 0.1;
				writeWav(inputWav, samples, 24000);
				const result = await exportReview({
					outDir,
					screenVideo: screen,
					paths,
					env,
					intro: "Opening.",
					outro: "Ending.",
					status: "complete",
					deadlineMs: 100_000,
					signal: controller.signal,
					tracks: [{ file: inputWav, role: "Participant", label: "Generated input", provenance: "generated", caption: "Synthetic test tone.", offsetMs: 200, uncertaintyMs: 50 }],
				});
				assert.equal(result.report.status, "candidate-for-human-review");
				const probe = await probeMedia(paths, result.output, env);
				assert.deepEqual(
					profileMismatches(probe, result.report.exportChecks.expectedFrames),
					[],
				);
				assert.equal(result.report.timing.journeyMs, 1300);
				assert.equal(result.report.provenance.screen.sourceFrames, 32);
				assert.equal(result.report.provenance.screen.outputFrames, 39);
				assert.equal(sha256File(screen), sourceHash);
				assert.equal(Number(source.streams[0].nb_read_frames), 32);
				const planned = [Math.round(result.report.timing.introMs * 30 / 1000), 39, Math.round(result.report.timing.outroMs * 30 / 1000)];
				assert.deepEqual(result.report.exportChecks.assembly.videoFrames, planned);
				assert.deepEqual(result.report.exportChecks.assembly.audioSamples, planned.map((n) => n * 1600));
				for (const [i, name] of ["intro.mp4", "journey.mp4", "outro.mp4"].entries()) {
					const segment = await probeMedia(paths, path.join(outDir, name), env);
					assert.deepEqual(profileMismatches(segment, planned[i]), []);
					const decodedSegment = path.join(temp.dir, `segment-${i}.wav`);
					await ffmpegRun(paths, ["-i", path.join(outDir, name), "-vn", "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", decodedSegment], env);
					const decodedSamples = readWav(decodedSegment).samples.length;
					if (i !== 1) {
						const narration = readWav(path.join(outDir, i === 0 ? "narrator-intro.wav" : "narrator-outro.wav"));
						assert.ok(decodedSamples >= Math.round(narration.samples.length / narration.sampleRate * 48000), "encoded narrator must retain the full source sample span");
					}
					assert.ok(decodedSamples <= planned[i] * 1600 + 1024);
				}
				const pixels = [];
				for (const [i, file] of [screen, path.join(outDir, "journey.mp4")].entries()) {
					const rgb = path.join(temp.dir, `frames-${i}.rgb`);
					await ffmpegRun(paths, ["-i", file, "-vf", "scale=1:1,format=rgb24", "-fps_mode", "vfr", "-f", "rawvideo", rgb], env);
					pixels.push(fs.readFileSync(rgb));
				}
				assert.equal(pixels[0].length, 32 * 3);
				assert.equal(pixels[1].length, 39 * 3);
				for (let frame = 0; frame < 32; frame++) {
					let retained = false;
					for (let output = 0; output < 39; output++) {
						if ([0, 1, 2].every((channel) => Math.abs(pixels[0][frame * 3 + channel] - pixels[1][output * 3 + channel]) <= 4)) retained = true;
					}
					assert.ok(retained, `source visual state ${frame} must remain in the normalized journey`);
				}
				assert.ok(profileMismatches(probe, result.report.exportChecks.expectedFrames + 1).includes("frame count equals edit arithmetic"));
				const decoded = path.join(temp.dir, "decoded.wav");
				await ffmpegRun(paths, ["-i", result.output, "-vn", "-ac", "1", "-ar", "48000", "-c:a", "pcm_s16le", decoded], env);
				const finalWav = readWav(decoded);
				// Final AAC has at most one codec block beyond the planned sample count.
				assert.ok(finalWav.samples.length >= planned.reduce((a, b) => a + b) * 1600);
				assert.ok(finalWav.samples.length - planned.reduce((a, b) => a + b) * 1600 < 1024);
				const toneStart = Math.round((result.report.timing.introMs + 300) * 48);
				const tone = finalWav.samples.slice(toneStart, toneStart + 4800);
				assert.ok(Math.sqrt(tone.reduce((sum, value) => sum + value * value, 0) / tone.length) > 0.03);
				await ffmpegRun(paths, ["-i", result.output, "-f", "null", "-"], env);
			});
		} finally {
			clearTimeout(timer);
		}
	},
);

test("fractional source rate retains the first and last visible action with independent frame arithmetic", {
	skip: !process.env.SDP_RUNTIME_DIR && "optional pinned media runtime not supplied",
	timeout: 120000,
}, async (t) => {
	await holdMediaLock(t);
	const temp = makeTempDir();
	t.after(temp.cleanup);
	const paths = toolPaths(process.env.SDP_RUNTIME_DIR);
	const env = { PATH: "/usr/bin:/bin", HOME: temp.dir, TMPDIR: temp.dir, PYTHONDONTWRITEBYTECODE: "1", PYTHONNOUSERSITE: "1" };
	const source = path.join(temp.dir, "fractional.mp4");
	await ffmpegRun(paths, [
		"-f", "lavfi", "-i", "color=c=red:s=1280x720:r=30000/1001:d=1",
		"-f", "lavfi", "-i", "color=c=blue:s=1280x720:r=30000/1001:d=1",
		"-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v]", "-map", "[v]",
		"-r", "30000/1001", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-output_ts_offset", "5", source,
	], env);
	const original = sha256File(source);
	const before = await probeMedia(paths, source, env);
	assert.equal(before.streams[0].avg_frame_rate, "30000/1001");
	assert.equal(Number(before.streams[0].start_time), 5);
	const outDir = path.join(temp.dir, "out");
	fs.mkdirSync(outDir);
	const result = await exportReview({ outDir, screenVideo: source, paths, env, status: "complete", intro: "Opening.", outro: "Ending." });
	const sourceMs = Number(before.streams[0].duration) * 1000;
	const frames = Math.ceil(sourceMs * 30 / 1000);
	assert.equal(result.report.provenance.screen.outputFrames, frames);
	assert.equal(result.report.exportChecks.expectedFrames,
		Math.round(result.report.timing.introMs * 30 / 1000) + frames + Math.round(result.report.timing.outroMs * 30 / 1000));
	const pixels = path.join(temp.dir, "endpoints.rgb");
	await ffmpegRun(paths, ["-i", path.join(outDir, "journey.mp4"), "-vf", `select='eq(n,0)+eq(n,${frames - 1})',scale=1:1,format=rgb24`, "-fps_mode", "vfr", "-f", "rawvideo", pixels], env);
	const rgb = fs.readFileSync(pixels);
	assert.equal(rgb.length, 6);
	assert.ok(rgb[0] > 200 && rgb[2] < 30, "first red action remains");
	assert.ok(rgb[3] < 30 && rgb[5] > 200, "last blue action remains");
	assert.equal(sha256File(source), original);
	await ffmpegRun(paths, ["-i", result.output, "-f", "null", "-"], env);
});

test("controlled fixed segments expose AAC overrun and exact sample-clock assembly retains all video frames", {
	skip: !process.env.SDP_RUNTIME_DIR && "optional pinned media runtime not supplied",
	timeout: 120000,
}, async (t) => {
	await holdMediaLock(t);
	const temp = makeTempDir();
	t.after(temp.cleanup);
	const paths = toolPaths(process.env.SDP_RUNTIME_DIR);
	const env = { PATH: "/usr/bin:/bin", HOME: temp.dir, TMPDIR: temp.dir, PYTHONDONTWRITEBYTECODE: "1", PYTHONNOUSERSITE: "1" };
	const frames = [70, 72, 68];
	const sources = frames.map((_, i) => path.join(temp.dir, `segment-${i}.mp4`));
	for (const [i, count] of frames.entries()) {
		await ffmpegRun(paths, [
			"-f", "lavfi", "-i", `color=c=navy:s=1280x720:r=30:d=${count / 30}`,
			"-f", "lavfi", "-i", `sine=frequency=${440 + i * 220}:sample_rate=48000:duration=${count / 30}`,
			"-c:v", "libx264", "-profile:v", "high", "-pix_fmt", "yuv420p",
			"-c:a", "aac", "-ar", "48000", "-ac", "2", sources[i],
		], env);
	}
	const hashes = sources.map(sha256File);
	const counts = [];
	for (const bounded of [false, true]) {
		const filters = frames.map((count, i) =>
			`[${i}:v]setsar=1,${bounded ? "setpts=N/(30*TB)" : "null"}[v${i}];` +
			`[${i}:a]${bounded ? `aresample=48000,apad,atrim=end_sample=${count * 1600},asetpts=N/SR/TB` : "anull"}[a${i}]`);
		filters.push("[v0][a0][v1][a1][v2][a2]concat=n=3:v=1:a=1[v][a]");
		const output = path.join(temp.dir, bounded ? "bounded.mp4" : "unbounded.mp4");
		await ffmpegRun(paths, [
			...sources.flatMap((source) => ["-i", source]),
			"-filter_complex", filters.join(";"), "-map", "[v]", "-map", "[a]",
			"-r", "30", "-c:v", "libx264", "-profile:v", "high", "-pix_fmt", "yuv420p",
			"-c:a", "aac", "-ar", "48000", "-ac", "2", output,
		], env);
		const probe = await probeMedia(paths, output, env);
		counts.push(Number(probe.streams.find((s) => s.codec_type === "video").nb_read_frames));
		if (bounded) {
			assert.deepEqual(profileMismatches(probe, 210), []);
			const decoded = path.join(temp.dir, "bounded.wav");
			await ffmpegRun(paths, ["-i", output, "-vn", "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", decoded], env);
			const samples = readWav(decoded).samples;
			assert.ok(samples.length >= 336000 && samples.length < 337024);
			for (const [start, end] of [[1000, 110000], [113000, 225000], [228000, 334000]]) {
				const values = samples.subarray(start, end);
				assert.ok(Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / values.length) > 0.05);
			}
			await ffmpegRun(paths, ["-i", output, "-f", "null", "-"], env);
		}
	}
	assert.deepEqual(counts, [211, 210], "unbounded decoded AAC must reproduce the extra boundary frame");
	assert.deepEqual(sources.map(sha256File), hashes);
});

test("refuses incomplete exports without a declared limitation before starting media tools", async (t) => {
	const temp = makeTempDir();
	t.after(temp.cleanup);
	const outDir = path.join(temp.dir, "exports");
	fs.mkdirSync(outDir);
	await assert.rejects(
		exportReview({
			outDir,
			screenVideo: path.join(temp.dir, "missing.webm"),
			paths: {},
			env: {
				PATH: "/usr/bin:/bin",
				HOME: temp.dir,
				TMPDIR: temp.dir,
				PYTHONDONTWRITEBYTECODE: "1",
				PYTHONNOUSERSITE: "1",
			},
			intro: "Observed opening.",
			outro: "Observed ending.",
			status: "incomplete",
		}),
		/explicit limitations/,
	);
	assert.deepEqual(fs.readdirSync(outDir), []);
});

test("rejects ambiguous track provenance, out-of-range offsets and control text", async (t) => {
	const temp = makeTempDir();
	t.after(temp.cleanup);
	const outDir = path.join(temp.dir, "exports");
	fs.mkdirSync(outDir);
	const screen = path.join(temp.dir, "screen.webm");
	fs.writeFileSync(screen, "not media");
	const base = {
		outDir,
		screenVideo: screen,
		paths: {},
		env: {
			PATH: "/usr/bin:/bin",
			HOME: temp.dir,
			TMPDIR: temp.dir,
			PYTHONDONTWRITEBYTECODE: "1",
			PYTHONNOUSERSITE: "1",
		},
		intro: "Observed opening.",
		outro: "Observed ending.",
		status: "complete",
	};
	await assert.rejects(
		exportReview({
			...base,
			tracks: [
				{
					file: screen,
					role: "Participant",
					label: "User",
					provenance: "app-output",
					caption: "Reply",
					offsetMs: 0,
					uncertaintyMs: 0,
				},
			],
		}),
		/requires a role, label, explicit provenance/,
	);
	assert.deepEqual(fs.readdirSync(outDir), []);
});
