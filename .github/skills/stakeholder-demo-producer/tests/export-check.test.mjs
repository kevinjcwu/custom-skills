// Generic export-profile and socket-path tests, moved unchanged from the
// archived calibration.test.mjs when the audio-route calibration left the package.
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { test } from "node:test";
import { moovBeforeMdat, profileMismatches } from "../scripts/lib/export-check.mjs";
import { dirAlias } from "../scripts/lib/proc-registry.mjs";
import { makeTempDir } from "./helpers.mjs";

test("profile check names every mismatch against the export profile", () => {
	const good = {
		format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2" },
		streams: [
			{ codec_type: "video", codec_name: "h264", profile: "High", pix_fmt: "yuv420p", width: 1280, height: 720, r_frame_rate: "30/1", avg_frame_rate: "30/1", nb_read_frames: "90" },
			{ codec_type: "audio", codec_name: "aac", profile: "LC", sample_rate: "48000", channels: 2 },
		],
	};
	assert.deepEqual(profileMismatches(good, 90), []);
	const bad = structuredClone(good);
	bad.streams[0].pix_fmt = "yuv444p";
	bad.streams[0].avg_frame_rate = "2997/100";
	bad.streams[1].channels = 1;
	assert.deepEqual(profileMismatches(bad, 91), ["pixel format yuv420p", "constant 30 fps", "frame count equals edit arithmetic", "audio stereo"]);
});

test("faststart is read from the atom order", (t) => {
	const { dir, cleanup } = makeTempDir();
	t.after(cleanup);
	const atom = (type, body = 0) => {
		const buffer = Buffer.alloc(8 + body);
		buffer.writeUInt32BE(8 + body, 0);
		buffer.write(type, 4, "latin1");
		return buffer;
	};
	fs.writeFileSync(path.join(dir, "fast.mp4"), Buffer.concat([atom("ftyp", 8), atom("moov", 16), atom("mdat", 32)]));
	fs.writeFileSync(path.join(dir, "slow.mp4"), Buffer.concat([atom("ftyp", 8), atom("mdat", 32), atom("moov", 16)]));
	assert.equal(moovBeforeMdat(path.join(dir, "fast.mp4")), true);
	assert.equal(moovBeforeMdat(path.join(dir, "slow.mp4")), false);
});

test("a deep directory gets a short descriptor alias that Unix sockets can bind through", async (t) => {
	const { dir, cleanup } = makeTempDir();
	t.after(cleanup);
	const deep = path.join(dir, "a".repeat(60), "b".repeat(60));
	fs.mkdirSync(deep, { recursive: true });
	assert.ok(Buffer.byteLength(path.join(deep, "native")) > 108);
	const alias = dirAlias(deep);
	t.after(() => alias.close());
	assert.equal(alias.via, "directory-descriptor");
	const socket = path.join(alias.path, "native");
	const server = net.createServer();
	await new Promise((resolve, reject) => server.once("error", reject).listen(socket, resolve));
	t.after(() => server.close());
	assert.ok(fs.statSync(path.join(deep, "native")).isSocket(), "the socket lives in the real directory");
	assert.equal(dirAlias(dir.slice(0, 20)).via, "path");
});
