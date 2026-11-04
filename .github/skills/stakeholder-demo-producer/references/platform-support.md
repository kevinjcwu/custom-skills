# Platform support

## Available now

- **Terminal / process**: approved executables with literal argv, controlled environment, timeouts, output
  caps, cancellation and process-group cleanup. Expectations: exit code, stdout and stderr substrings.
- **HTTP**: exact allowlisted origins, or loopback only, with no redirects followed, capped bodies and
  closed sockets. Expectations: status and body substring.
- Passive discovery, contracts and hashing, passive preflight, run records, claim ledger and structural QA.
- **Offline voice qualification evidence**: a pure readiness/current-turn evidence evaluator and
  synthetic generic-helper dispatch/deadline/cleanup regressions. No app, caller, browser recording or
  live voice integration is provided. See [voice-qualification.md](voice-qualification.md).
- **Early browser feasibility**: `sdp feasibility` reuses an approved `demo-plan.v1` and its exact
  SHA-256. It runs only the first browser scene, which must contain 1-5 fixed actions (`goto`,
  role/name `click`, label `fill`, key `press` or visible-text `wait`). It does not run interaction
  helpers or produce a narrated export. Remaining storyboard scenes are recorded as skipped, not
  silently substituted. The attempt is bounded by the lesser of the approved whole-run limit and 180
  seconds, with one attempt per action. It returns distinct `unsupported`, `missing-prerequisite`,
  `timeout`, `product-error`, `cancelled`, `blocked` and `run-failed` results. A pass proves only that
  this scene's actual browser actions and expectations passed in that run.

The following need the pinned project-local toolchain (`setup check`, `setup install`). It is verified on
linux x64 Ubuntu 22.04 only; any other platform is reported as blocked by `setup check`:

- **Browser**: one owned, headless Chromium session per run, recorded to `browser/session.webm`. It loads
  only the loopback origin announced by the one approved target service, and every other request is
  refused. WebSocket connections follow the same allowlist: a socket to any other origin is closed before
  it reaches its server and counted with the blocked requests. Storyboard ops: `goto` (path on that origin), `click` (`role:accessible name`), `fill` (label
  plus value), `press` (key), `wait` (visible text) and `helper` (below). Expectations: `pageIncludes`,
  `pageExcludes`, `pageIncludesNew`. Storyboards never supply page scripts.
- **Run-local helpers** (`helper` action): an interaction the fixed steps cannot perform runs as a helper
  the agent wrote for this app and the plan declares, with an explicit environment, time limit, output
  cap, cancellation and process cleanup. It may ask the run to evaluate its own declared page scripts in
  the recorded page, and may report WAV media it wrote. The skill ships no such helper. See
  run-local-helpers.md.
- **Agent-orchestrated driver composition**: when a journey or finalization policy does not fit the
  existing `sdp` contracts, the agent can generate a bounded per-demo driver using the existing browser,
  helper, process, narration and export utilities. The new recording/review utilities extract full helper
  page results and assemble honest complete/incomplete review candidates. This path is covered by a
  controlled synthetic browser/helper fixture; it is not the generic CLI path or a sandbox.
- **Offline speech synthesis** of narration for one audience, with no network.
- **Timed captions** (WebVTT) derived from the synthesized narration durations, labelled as a generated voice.
- **Export**: `produce` writes one H.264/AAC MP4 (1280x720, 30 fps, faststart) per audience. Browser scenes
  appear as recorded clips; process and HTTP scenes appear as recorded-output text panels, not live
  terminal video. A scene with helper media appears as a narrated still followed by the recorded clip
  with that media, captioned with its label and whether the helper generated or recorded it. Diagram
  cards (only when the plan allows them) are drawn only from catalog components and edges.
- **Calibration**: `calibrate --scope export` proves the export profile and the silence floor, with no
  browser, microphone or audio daemon. `produce` requires a passed calibration.

## Not implemented (blocked)

None of these is available, and nothing simulates them. Where one matters for a demo, say so in the plan
or the report:

- Automatic release: every export needs a person to watch and listen to the whole exact file.
  Structural export checks are not that review.
- Essential device interaction in the fast path: required microphone/device capture, user speech to the
  app and private audio routing are not provided as generic capabilities. A bounded approved
  per-demo helper/driver may be developed and tested for a specific authorized target; this is not
  universal voice support. An ordinary-browser-only plan may omit an essential interaction honestly.
- Network or filesystem sandboxing of the app's processes or of run-local helpers: they reach whatever
  they normally reach; the plan declares the expected outside hosts.
- Prebuilt app-specific integrations (for example a simulated caller for voice apps, private audio
  routes): none ship. Such interactions are written per app as run-local helpers.
- Measured picture/sound alignment of helper media: timing is reported by the helper, not measured.
- Transcribing audio into captions: helper media is captioned with the helper's own caption text.
- Desktop and mobile applications.

## Proving a new capability

A blocked capability becomes available only after a bounded proof shows it works on this toolchain with
recorded evidence, for example: one browser runtime capturing one scene, one speech path producing
narration, one export profile, and an independent exact-file watch-and-listen review of that export. Until
then, keep the commands exiting 3.
