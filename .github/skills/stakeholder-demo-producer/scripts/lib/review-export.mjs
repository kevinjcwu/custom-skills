import fs from "node:fs";
import path from "node:path";
import { clearTimeout, setTimeout } from "node:timers";
import { readWav } from "./audio.mjs";
import {
	EXPORT_PROFILE,
	ffmpegRun,
	moovBeforeMdat,
	probeMedia,
	profileMismatches,
} from "./export-check.mjs";
import { toWebVtt, synthesizeNarration } from "./narration.mjs";
import { hasControlCharacter } from "./paths.mjs";
import { withCancellation } from "./proc-registry.mjs";
import { sha256File } from "./toolchain.mjs";

const PROFILE = EXPORT_PROFILE;
const ROLE_PROVENANCE = new Set(["generated", "captured-unverified"]);
const MAX_TRACK_BYTES = 16 * 1024 * 1024;
const MAX_NARRATION_CHARS = 2000;

function regularInput(file, label) {
	const absolute = path.resolve(file);
	const stat = fs.lstatSync(absolute);
	if (
		!stat.isFile() ||
		stat.isSymbolicLink() ||
		fs.realpathSync(absolute) !== absolute ||
		stat.size === 0
	) {
		throw new Error(`${label} must be a non-empty regular file, not a link`);
	}
	return { file: absolute, bytes: stat.size };
}

function assertUnused(files) {
	for (const file of files) {
		if (fs.existsSync(file)) {
			throw new Error(
				`refusing to overwrite existing review output: ${path.basename(file)}`,
			);
		}
	}
}

function roundedSegmentMs(durationMs) {
	return (Math.ceil((durationMs / 1000) * PROFILE.fps) / PROFILE.fps) * 1000;
}

function validateTrackDescriptor(track, index) {
	if (
		!track ||
		typeof track !== "object" ||
		typeof track.role !== "string" ||
		!track.role.trim() ||
		typeof track.label !== "string" ||
		!track.label.trim() ||
		!ROLE_PROVENANCE.has(track.provenance) ||
		typeof track.caption !== "string" ||
		!track.caption.trim() ||
		hasControlCharacter(track.role) ||
		hasControlCharacter(track.label) ||
		hasControlCharacter(track.caption) ||
		track.role.length > 80 ||
		track.label.length > 200 ||
		track.caption.length > 1000 ||
		typeof track.file !== "string" ||
		!Number.isSafeInteger(track.offsetMs) ||
		track.offsetMs < 0 ||
		!Number.isSafeInteger(track.uncertaintyMs) ||
		track.uncertaintyMs < 0
	) {
		throw new Error(
			`track ${index} requires a role, label, explicit provenance, caption, non-negative offset and uncertainty`,
		);
	}
}

function validateTrack(track, journeyMs, index) {
	validateTrackDescriptor(track, index);
	const input = regularInput(track.file, `track ${index}`);
	if (input.bytes > MAX_TRACK_BYTES) {
		throw new Error(
			`track ${index} exceeds the ${MAX_TRACK_BYTES}-byte media limit`,
		);
	}
	const wav = readWav(input.file);
	if (
		wav.samples.length === 0 ||
		wav.sampleRate < 8000 ||
		wav.sampleRate > 96000
	) {
		throw new Error(
			`track ${index} is empty or has an unsupported sample rate`,
		);
	}
	const durationMs = (wav.samples.length / wav.sampleRate) * 1000;
	if (track.offsetMs + durationMs > journeyMs) {
		throw new Error(`track ${index} exceeds the recorded journey`);
	}
	return { ...track, file: input.file, bytes: input.bytes, durationMs };
}

function captionForTrack(track) {
	const source =
		track.provenance === "generated"
			? "generated helper audio; not app output"
			: "helper-captured audio; source unverified";
	return `${track.label} (${source}): ${track.caption}`;
}

/**
 * Make a narrated review candidate around the uncut screen recording.
 * This assembles media; it does not authenticate claims or release a demo.
 */
export async function exportReview({
	outDir,
	screenVideo,
	paths,
	env,
	intro,
	outro,
	status,
	limitations = [],
	tracks = [],
	deadlineMs = 600000,
	signal,
}) {
	if (!["complete", "incomplete"].includes(status)) {
		throw new Error("status must be complete or incomplete");
	}
	if (
		status === "incomplete" &&
		(!Array.isArray(limitations) ||
			limitations.length === 0 ||
			limitations.some((item) => typeof item !== "string" || !item.trim()))
	) {
		throw new Error(
			"an incomplete review candidate requires explicit limitations",
		);
	}
	if (!Array.isArray(tracks) || !Array.isArray(limitations)) {
		throw new Error("tracks and limitations must be arrays");
	}
	tracks.forEach(validateTrackDescriptor);
	if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1) {
		throw new Error("deadlineMs must be a positive integer");
	}
	const root = fs.realpathSync(outDir);
	if (
		root !== path.resolve(outDir) ||
		!fs.lstatSync(root).isDirectory() ||
		fs.lstatSync(root).isSymbolicLink() ||
		fs.realpathSync(path.dirname(root)) !== path.dirname(root)
	) {
		throw new Error(
			"review output must be an existing directory with a real parent",
		);
	}
	const screen = regularInput(screenVideo, "screen recording");
	const outputs = Object.fromEntries(
		[
			"narrator-intro.wav",
			"narrator-outro.wav",
			"intro.png",
			"outro.png",
			"intro.mp4",
			"journey.mp4",
			"outro.mp4",
			"review-without-captions.mp4",
			"review.mp4",
			"review.vtt",
			"review-export.json",
		].map((name) => [name, path.join(root, name)]),
	);
	assertUnused(Object.values(outputs));
	if (
		typeof intro !== "string" ||
		!intro.trim() ||
		intro.length > MAX_NARRATION_CHARS ||
		typeof outro !== "string" ||
		!outro.trim() ||
		outro.length > MAX_NARRATION_CHARS
	) {
		throw new Error("observed intro and outro narration are required");
	}
	if (
		!env ||
		typeof env !== "object" ||
		typeof env.PATH !== "string" ||
		typeof env.HOME !== "string" ||
		typeof env.TMPDIR !== "string" ||
		env.PYTHONDONTWRITEBYTECODE !== "1" ||
		env.PYTHONNOUSERSITE !== "1"
	) {
		throw new Error(
			"review export requires an explicit owned PATH, HOME, TMPDIR and Python write-isolation environment",
		);
	}
	const controller = new globalThis.AbortController();
	const deadline = setTimeout(
		() => controller.abort(new Error("review export hard deadline reached")),
		deadlineMs,
	);
	const abort = () =>
		controller.abort(signal.reason ?? new Error("review export cancelled"));
	signal?.addEventListener("abort", abort, { once: true });
	if (signal?.aborted) abort();
	const operationSignal = controller.signal;
	try {
		return await withCancellation(operationSignal, async () => {
			const env0 = { ...env };
			if (
				Object.hasOwn(env0, "PYTHONDONTWRITEBYTECODE") &&
				env0.PYTHONDONTWRITEBYTECODE !== "1"
			) {
				throw new Error("PYTHONDONTWRITEBYTECODE must be 1 for review export");
			}
			const envForTools = { ...env0, PYTHONDONTWRITEBYTECODE: "1" };
			const probe = await probeMedia(paths, screen.file, envForTools);
			const video = probe.streams?.find(
				(stream) => stream.codec_type === "video",
			);
			const journeyMs =
				Number(video?.duration ?? probe.format?.duration) * 1000;
			const journeyFrames = Number(video?.nb_read_frames ?? video?.nb_frames);
			if (
				!Number.isFinite(journeyMs) ||
				journeyMs <= 0 ||
				!Number.isSafeInteger(journeyFrames) ||
				journeyFrames < 1
			) {
				throw new Error("screen recording has no positive video duration");
			}
			const validatedTracks = tracks.map((track, index) =>
				validateTrack(track, journeyMs, index),
			);
			const introNarration = await synthesizeNarration({
				text: intro,
				outWav: outputs["narrator-intro.wav"],
				paths,
				role: "Narrator",
			});
			const outroNarration = await synthesizeNarration({
				text: outro,
				outWav: outputs["narrator-outro.wav"],
				paths,
				role: "Narrator",
			});
			const introSegmentMs = roundedSegmentMs(introNarration.durationMs);
			const outroSegmentMs = roundedSegmentMs(outroNarration.durationMs);
			const introFrame = await ffmpegRun(
				paths,
				["-n", "-i", screen.file, "-frames:v", "1", outputs["intro.png"]],
				envForTools,
			);
			if (introFrame.code !== 0)
				throw new Error("failed to capture the opening frame");
			const outroFrame = await ffmpegRun(
				paths,
				[
					"-n",
					"-sseof",
					"-0.1",
					"-i",
					screen.file,
					"-frames:v",
					"1",
					outputs["outro.png"],
				],
				envForTools,
			);
			if (outroFrame.code !== 0)
				throw new Error("failed to capture the closing frame");
			const makeNarratorSegment = async (frame, audio, durationMs, out) =>
				ffmpegRun(
					paths,
					[
						"-n",
						"-loop",
						"1",
						"-framerate",
						String(PROFILE.fps),
						"-i",
						frame,
						"-i",
						audio,
						"-t",
						(durationMs / 1000).toFixed(6),
						"-vf",
						`scale=${PROFILE.width}:${PROFILE.height}:force_original_aspect_ratio=decrease,pad=${PROFILE.width}:${PROFILE.height}:(ow-iw)/2:(oh-ih)/2,setsar=1`,
						"-af",
						`aresample=${PROFILE.sampleRate},apad`,
						"-r",
						String(PROFILE.fps),
						"-c:v",
						"libx264",
						"-profile:v",
						"high",
						"-pix_fmt",
						"yuv420p",
						"-preset",
						"medium",
						"-crf",
						"20",
						"-c:a",
						"aac",
						"-ar",
						String(PROFILE.sampleRate),
						"-ac",
						"2",
						"-movflags",
						"+faststart",
						out,
					],
					envForTools,
				);
			await makeNarratorSegment(
				outputs["intro.png"],
				outputs["narrator-intro.wav"],
				introSegmentMs,
				outputs["intro.mp4"],
			);
			const durationSec = (journeyMs / 1000).toFixed(6);
			const journeyArgs = ["-n", "-i", screen.file];
			for (const track of validatedTracks) journeyArgs.push("-i", track.file);
			const silentIndex = 1 + validatedTracks.length;
			journeyArgs.push(
				"-f",
				"lavfi",
				"-t",
				durationSec,
				"-i",
				`anullsrc=r=${PROFILE.sampleRate}:cl=stereo`,
			);
			const filters = [];
			for (const [index, track] of validatedTracks.entries()) {
				const delay = track.offsetMs;
				filters.push(
					`[${index + 1}:a]aresample=${PROFILE.sampleRate},adelay=${delay}|${delay},apad,atrim=duration=${durationSec},asetpts=PTS-STARTPTS[t${index}]`,
				);
			}
			filters.push(
				`[${silentIndex}:a]aresample=${PROFILE.sampleRate},atrim=duration=${durationSec},asetpts=PTS-STARTPTS[silence]`,
			);
			const inputs = [
				...validatedTracks.map((_, index) => `[t${index}]`),
				"[silence]",
			].join("");
			filters.push(
				`${inputs}amix=inputs=${validatedTracks.length + 1}:duration=longest:normalize=0[a]`,
			);
			journeyArgs.push(
				"-filter_complex",
				filters.join(";"),
				"-map",
				"0:v:0",
				"-map",
				"[a]",
				"-vf",
				`scale=${PROFILE.width}:${PROFILE.height}:force_original_aspect_ratio=decrease,pad=${PROFILE.width}:${PROFILE.height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${PROFILE.fps}`,
				"-t",
				durationSec,
				"-c:v",
				"libx264",
				"-profile:v",
				"high",
				"-pix_fmt",
				"yuv420p",
				"-preset",
				"medium",
				"-crf",
				"20",
				"-c:a",
				"aac",
				"-ar",
				String(PROFILE.sampleRate),
				"-ac",
				"2",
				outputs["journey.mp4"],
			);
			await ffmpegRun(paths, journeyArgs, envForTools);
			await makeNarratorSegment(
				outputs["outro.png"],
				outputs["narrator-outro.wav"],
				outroSegmentMs,
				outputs["outro.mp4"],
			);
			const intermediate = outputs["review-without-captions.mp4"];
			await ffmpegRun(
				paths,
				[
					"-n",
					"-i",
					outputs["intro.mp4"],
					"-i",
					outputs["journey.mp4"],
					"-i",
					outputs["outro.mp4"],
					"-filter_complex",
					"[0:v]fps=30,setsar=1[v0];[1:v]fps=30,setsar=1[v1];[2:v]fps=30,setsar=1[v2];[v0][0:a][v1][1:a][v2][2:a]concat=n=3:v=1:a=1[v][a]",
					"-map",
					"[v]",
					"-map",
					"[a]",
					"-c:v",
					"libx264",
					"-profile:v",
					"high",
					"-pix_fmt",
					"yuv420p",
					"-preset",
					"medium",
					"-crf",
					"20",
					"-c:a",
					"aac",
					"-ar",
					String(PROFILE.sampleRate),
					"-ac",
					"2",
					"-movflags",
					"+faststart",
					intermediate,
				],
				envForTools,
			);
			const journeyStartMs = introSegmentMs;
			const outroStartMs = introSegmentMs + journeyMs;
			const cues = [
				...introNarration.cues,
				...validatedTracks.map((track) => ({
					startMs: journeyStartMs + track.offsetMs,
					endMs: journeyStartMs + track.offsetMs + track.durationMs,
					role: track.role,
					text: captionForTrack(track),
				})),
				...outroNarration.cues.map((cue) => ({
					...cue,
					startMs: cue.startMs + outroStartMs,
					endMs: cue.endMs + outroStartMs,
				})),
			];
			fs.writeFileSync(outputs["review.vtt"], toWebVtt(cues), { flag: "wx" });
			await ffmpegRun(
				paths,
				[
					"-n",
					"-i",
					intermediate,
					"-i",
					outputs["review.vtt"],
					"-map",
					"0",
					"-map",
					"1:0",
					"-c",
					"copy",
					"-c:s",
					"mov_text",
					"-metadata:s:s:0",
					"language=eng",
					"-disposition:s:0",
					"default",
					"-movflags",
					"+faststart",
					outputs["review.mp4"],
				],
				envForTools,
			);
			const finalProbe = await probeMedia(
				paths,
				outputs["review.mp4"],
				envForTools,
			);
			const finalDurationMs =
				Number(
					finalProbe.streams?.find((stream) => stream.codec_type === "video")
						?.duration ?? finalProbe.format?.duration,
				) * 1000;
			const expectedFrames =
				Math.round((introSegmentMs * PROFILE.fps) / 1000) +
				journeyFrames +
				Math.round((outroSegmentMs * PROFILE.fps) / 1000);
			const mismatches = profileMismatches(finalProbe, expectedFrames);
			const faststart = moovBeforeMdat(outputs["review.mp4"]);
			if (
				mismatches.length ||
				!faststart ||
				!(finalDurationMs > 0) ||
				!finalProbe.streams.some((stream) => stream.codec_type === "audio") ||
				!finalProbe.streams.some(
					(stream) => stream.codec_type === "subtitle",
				) ||
				cues.some((cue) => cue.endMs > finalDurationMs + 100)
			) {
				throw new Error(
					`final export failed profile/caption checks: ${JSON.stringify({ mismatches, faststart })}`,
				);
			}
			const files = [
				"review.mp4",
				"review.vtt",
				"narrator-intro.wav",
				"narrator-outro.wav",
				"journey.mp4",
			].map((name) => ({
				path: outputs[name],
				bytes: fs.statSync(outputs[name]).size,
				sha256: sha256File(outputs[name]),
			}));
			const report = {
				schema: "sdp.review-export.v1",
				status:
					status === "complete"
						? "candidate-for-human-review"
						: "incomplete-candidate-for-human-review",
				coverage: {
					journey:
						status === "complete"
							? "reported-complete-by-driver"
							: "incomplete",
				},
				provenance: {
					screen: {
						path: screen.file,
						bytes: screen.bytes,
						sha256: sha256File(screen.file),
						treatment: "uncut recorded journey",
					},
					tracks: validatedTracks.map(
						({
							file,
							bytes,
							role,
							label,
							provenance,
							offsetMs,
							uncertaintyMs,
							durationMs,
						}) => ({
							path: file,
							bytes,
							sha256: sha256File(file),
							role,
							label,
							provenance,
							offsetMs,
							uncertaintyMs,
							durationMs,
						}),
					),
				},
				timing: {
					introMs: introSegmentMs,
					journeyMs,
					outroMs: outroSegmentMs,
					uncertainty:
						"track offsets are coarse driver observations; picture/sound alignment is not measured",
				},
				exportChecks: {
					profileMismatches: mismatches,
					faststart,
					expectedFrames,
				},
				limitations: [
					...limitations,
					"structural checks do not establish that app output belongs to an interaction; human watch/listen review has not been performed",
				],
				humanReview: "not-performed",
				files,
			};
			fs.writeFileSync(
				outputs["review-export.json"],
				`${JSON.stringify(report, null, "\t")}\n`,
				{ flag: "wx" },
			);
			return {
				report,
				probe: finalProbe,
				cues,
				files,
				output: outputs["review.mp4"],
				captions: outputs["review.vtt"],
			};
		});
	} finally {
		clearTimeout(deadline);
		signal?.removeEventListener("abort", abort);
	}
}
