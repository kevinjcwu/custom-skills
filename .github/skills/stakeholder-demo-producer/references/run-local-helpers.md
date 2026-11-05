# Run-local helpers

The skill ships generic adapters (a recorded browser with fixed page steps, terminal commands, HTTP
requests) and no app-specific integrations. When discovery shows that the app needs an interaction those
adapters cannot perform, you write the missing piece for this app as a **run-local helper**, test it, and
declare it in the demo plan. The human approves it with the plan; the run then executes it under the same
limits and cleanup as everything else.

That describes the existing `sdp` route. When its contracts cannot express the essential journey or capture
policy, use the separate agent-orchestrated route in
[repository-workflow.md](repository-workflow.md): helper-development authority comes before writing or
testing generated code; the agreed showcase approval may cover both development and production, so no
second acknowledgement is needed for routine implementation within that scope. A development-only
grant never permits recording. A
run-local driver composes shared utilities; it does not change `sdp` helper semantics or make helpers a
sandbox.

Examples of gaps a helper may fill: a simulated user speaking to an app that listens to its microphone, a
synthetic sensor or message feed the page waits for, a drag-and-drop the fixed page steps cannot express.
These are examples of needs to look for, not complete integrations. Generic browser voice primitives are
available in [voice-integration.md](voice-integration.md); selectors, protocols, voice scenarios and
attribution still belong in the adapter generated for the target repository.

## Two kinds of helper files

Both are listed in the plan's `helpers` (id, `source`, `file`, `sha256`, `purpose`) and copied, after their
hash is checked, into `<run>/workspace/helpers/`. Commands and interactions refer to them as
`{workspace}/helpers/<file>`.

- **Support files** used by a command or the browser service: a sample-data seeder, a wrapper that prints
  the service ready line, the bundled `static-server.mjs`. They run as ordinary approved commands.
- **Interaction helpers** started by a storyboard `helper` action in a browser scene, described below.

Write helper files in a `helpers/` folder next to the plan (`source: plan-dir`). Never write them into the
app or into this skill. That folder must be a real directory, not a link: helpers are read only from the
plan's own folder (or the skill's `scripts/helpers/`), and a linked folder, a linked file or a file name
with a path is refused before it is read.

## Declaring an interaction helper

In the plan's `runtime.interactions` (the run authorization's `interactions`):

- `id`, `purpose` (plain words: what it does for the story);
- `executable` (an approved executable id), literal `argv`, `cwd` inside the target;
- `env` literals and `envPassthrough` names. This is the helper's whole environment, plus `SDP_OUT_DIR`
  set by the run. Nothing else from the parent environment is passed; secret-looking names are refused.
- `needs`: `[]`, or `["browser-page"]` if it must read or change this run's recorded page;
- `pageScripts`: the helper files (under `helpers/`) the run may evaluate in the page for it, each one
  JavaScript function expression taking one JSON argument. Required with `browser-page`, refused without;
- `media`: the media roles it may report, each with a caption `label` and a `provenance`:
  - `generated`: the helper made it (for example a simulated user's voice). Never the app's output.
  - `helper-captured`: the helper says it recorded it from the app. The run did not verify the source.

A browser-scene action `{ "op": "helper", "ref": "<interaction id>", "value": "<input>" }` starts it. The
scene must also have a `pageIncludesNew` expectation on that action: page text the run itself sees appear
during the action (it occurs more often afterwards than in the text read just before it).

## Protocol (`sdp.helper.v1`, JSON lines)

1. The run writes one line to the helper's stdin:
   `{"type":"start","protocol":"sdp.helper.v1","action":{"id":"…","value":"…"},"deadlineMs":…}`. `deadlineMs`
   is the action time limit in milliseconds; the run stops the helper when it runs out.
2. With `browser-page`, the helper may write `{"type":"page","id":"<call id>","script":"<page script id>","arg":…}`;
   the run evaluates that declared script in the recorded page and answers
   `{"type":"page-result","id":"<call id>","ok":true,"value":…}` or `{"ok":false,"error":"…"}`. The helper
   never gets a browser endpoint, another page or another browser.
3. It ends with exactly one
   `{"type":"result","status":"done|failed|blocked|unknown","detail":"…","media":[{"file":"…","role":"…","startMs":…,"caption":"…"}]}`
   and exits. `file` is relative to `SDP_OUT_DIR`; `startMs` is from the start of the action.

Lines are handled in the order written: a page call written before the result is evaluated (and the run
waits for it, within the action time limit) even if the helper exits at once; one written after the result is
ignored. Any other stdout is a protocol error. Limits: one line at most 64 KiB, at most 64 page calls per action,
page results at most 64 KiB, at most 8 media files of at most 16 MiB each, captions at most 300 characters.
Media must be regular (not symlinked) PCM WAV files inside `SDP_OUT_DIR`, of a declared role, starting and
ending inside the action window. At export each file must be audible on its own over its placed span, as
well as in the exported mix, so a silent file is not hidden by another file playing at the same time.

## What the run enforces, and what it does not

- The helper runs with the action time limit, capped output, cancellation (Ctrl-C or the plan's time
  limit), and teardown of its whole process group and any descendant that left the group. An escaped
  descendant fails the action (`helper-escaped`) after being stopped. Cancellation and the time limit
  also end the wait for a page script still running after the helper exited.
- Helper actions are never retried: a helper may already have changed the app.
- `SDP_OUT_DIR` is the declared place to write, under the run's private folder, and is removed at cleanup.
  **It is not a sandbox.** A helper is a trusted program you wrote, with the user's filesystem and
  network access. Keep it to its declared purpose: no private files, no copied credentials, no shell or
  `eval` of discovered commands, no changes to the app, no devices or privileges, no installs.
- A helper's `done` is a claim. The action passes only when the helper said `done`, exited 0, kept the
  protocol, every reported media file is valid, and the run's own expectations hold. `failed` fails the
  run; `blocked` and `unknown` stop it as blocked.
- The `pageIncludesNew` check is a safeguard against stale text, **not** proof that the text belongs to
  the helper's action. When the app could show a matching reply for some other reason (an earlier turn, a
  natural ending, a timer), the helper itself must correlate the reply with its own action (for example
  by a turn id or a value only it sent) and report `unknown` if it cannot. Never report `done` for an
  interaction you could not attribute.
- Media timing comes from the helper; the run does not measure picture/sound alignment. The export
  places helper media in its own clip after the narrated intro, never under narration, and captions it
  with its label and provenance ("generated by the run-local helper, not the app", or "recorded by the
  run-local helper; source not verified"). Check alignment in the full-file human review.

The run keeps, per helper action: `<action>.helper.json` (claimed status, outcome, exit, media with
hashes, `timingSource: helper-reported`), the JSON-lines transcript, stderr, the page text and screenshot.

## Writing and testing one

1. From discovery, write down the exact interaction the story needs and how you will know it happened
   for this action (the correlation above). If you cannot say, stop and ask.
2. Write the helper and its page scripts in `helpers/`. Keep them small and dependency-free; use only
   tools already approved on this machine.
3. Test it locally against harmless or synthetic input before it goes into the plan, within the access
   the human has already given you. Writing and testing it is not authorized retroactively by the later
   plan approval.
4. Declare it in the plan with its `purpose`, `needs`, media roles and provenance. The plan summary shows
   all of this, and the "not a sandbox" and "done is a claim" notes, to the human.
5. Stop and ask instead if it needs a new dependency, device, sign-in, outside network access the human
   has not agreed to, a change to the app or anything you cannot test.

A helper stays with the demo. Promote one into this skill only if it is generic (not tied to one app),
has proved useful across several repositories, and has been reviewed.

For generated drivers, use the portable full-payload and exclusive-original utilities in
`scripts/lib/recording.mjs`. On interaction failure, stop new actions but use a fresh finalization signal
bounded by the whole-run hard deadline to flush already-running capture before browser close. If finalizing
fails or times out, preserve the bytes already written and report what is missing; never upgrade an
unknown reply to success.
