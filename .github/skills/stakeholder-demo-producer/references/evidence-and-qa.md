# Evidence and QA

## Run records

A run directory `<runDir>/<runId>/` contains:

- `events.jsonl`: one `event.v1` per line with consecutive `seq`, a monotonic `tMs` offset, producer, type
  and disposition: `run.start`, `evidence.verified` (catalog, storyboard, authorization, target content
  hashes, and one `catalog-evidence` event per cited evidence file whose bytes were re-read and matched), `scene.*`, `action.*`, `expect.result`, `cleanup`, `run.end`.
- `contracts/catalog.json`, `contracts/storyboard.json`: the exact approved inputs.
- `scenes/<scene>/<action>.attempt-<n>.stdout|stderr|body`: captured output, binding values redacted.
- For a run-local helper action: `<action>.attempt-<n>.helper.json` (the helper's claimed status, the
  run's outcome, exit, page calls, stopped processes and every media file with role, label, provenance,
  `timingSource: helper-reported` and SHA-256), the JSON-lines transcript, stderr, page text and
  screenshot, and the media files themselves. The browser endpoint never appears in these records.
- `manifest.json`: written last. Every file with its role, producer, SHA-256 and size; transformations;
  failures; cleanup records; status `completed`, `failed` or `cancelled`.

An early feasibility run keeps the full approved storyboard and authorization hashes but executes only
its selected first browser scene. Other scenes have explicit `action.skipped` records. Its `completed`
status applies only to that selected bounded check; it is not evidence that the full demo completed and
does not create narration, captions or an export.

`manifest --run <dir>` re-hashes every artifact and reports changed, missing or unlisted files and host-like
absolute paths.

## Claim ledger

`qa --run <dir>` builds `claim-ledger.json`:

- `inferred`/`unknown` claims are `not-asserted` and cite no narration.
- A claim is `supported` only when every cited catalog evidence file was re-read in this run and matched its
  recorded SHA-256 (preflight blocks a missing file or wrong hash), and every demonstrating action passed in
  this run; `observed` claims need such an action.
- In a `synthetic-fixture` run, run-action evidence supports nothing about the target.

## Structural QA

`qa` also writes `qa-report.json` with reviewer `structural-tool`. It checks the manifest, artifact hashes,
unlisted files, host paths, the event stream, the hash chain, narrated claims, unevidenced metrics, the
subject, audience grounding and run status.

The unevidenced-metrics check fails on any figure in narration or assertable claim text (durations,
percentages, multipliers, user or request counts, uptime). Structural QA cannot tell whether a figure was
measured, so remove it or have a human verify it outside this tool.

Its verdict is `fail` if any check fails; otherwise `blocked`, because audiovisual acceptance needs a
person. Structural QA never returns `release`: it does not watch or listen to anything.

## Agent-orchestrated review candidates

When the agent uses the run-local driver route in
[repository-workflow.md](repository-workflow.md), its output is not an `sdp` run manifest and must not be
passed off as a completed run. The driver preserves originals/partial media before closing the browser,
then `scripts/lib/review-export.mjs` may assemble a complete or explicitly incomplete review candidate
without weakening the standard `produce`/QA gates.

Keep the driver report with exact screen, original, MP4 and VTT paths and hashes; helper reply/result
status; source-backed or observed claims; shown/omitted coverage; generated versus helper-captured audio
provenance; coarse offset and unknown alignment uncertainty; hard-stop and cleanup outcomes; and
limitations. A missing reply remains missing even if the screen or other media can still be exported.
Probe/decode checks and caption alignment are structural evidence only. A person must still watch and
listen to the whole exact file before treating it as accepted.

## Export checks

`produce` writes, in its own directory, `final/<runId>-<audience>.mp4` and `.vtt`, the rendered cards, the
per-scene narration audio, `qa/frames/` (one frame from the middle of every segment) and
`export-manifest.json` (`export-manifest.v1`). The manifest binds the run manifest and QA report hashes,
the calibration, every segment's source (with its hashed run artifact and clip window), the narration
placement and every output file's SHA-256. Its structural checks:

- the export profile (codec, size, frame rate, pixel format, audio) and `moov` before `mdat`;
- duration matches the edit layout;
- every caption cue's narration is audible and the windows outside narration are digitally silent, measured
  against the calibrated floor (`calibrate --scope export`);
- the captions parse and end within the export;
- the review frames exist;
- for scenes with helper media: every media file is audible on its own samples over its placed span and
  in the exported mix (`helper-media-audible`; the mix alone cannot tell overlapping files apart), and
  narration never overlaps an interaction clip (`narration-media-separated`).

Helper media is placed in its own clip after the scene's narrated intro, at the times the helper
reported, level-normalised separately from the narration and captioned with its label, its caption and
its provenance. The export manifest lists the limitations: the run did not measure picture/sound
alignment, generated media is never the app's output, helper-captured media's source was not verified,
and a helper's success report is its own claim. These checks are structural: they do not show that an
app's reply belonged to the helper's action.

Its verdict is `structural-pass` at best. Limits: a level check is not speech recognition, and a frame from
the middle of a segment does not prove the whole clip shows what the narration says. Look at the review
frames, and frames near the start and end of every recorded clip, before showing the export to anyone.

## Demo report

`demo` writes `demo-report.json` next to the run with the plan hash, run status and failures, QA, the
calibration used (when it failed, `calibrationFailures` names the failed checks), every export with its
files and SHA-256, and a feature coverage list: `observed` (every step of a scene that shows it passed),
`planned-not-observed` (it was planned but a step failed or did not run) or `omitted` with the plan's
reason. An `observed` feature shown through a helper also has a `basis`: what the run checked, and that
this does not prove the app's reply belonged to the helper's action. Report coverage to the human as it
is; never describe a `planned-not-observed` feature as shown, or a helper's claim as proof.

## Release (gate G3)

Release is always the human's decision after watching and listening to each exact file in full. Hand the
human the exact file path and SHA-256, the coverage report and the export's limitations. Do not describe
a structural pass as a finished demo.
