# Voice discovery and repo-local integration

This package is portable source, not a universal voice driver. Browser primitives work only where the
target uses compatible browser audio APIs. A native client, telephony endpoint, multiple sinks, encoded
custom transport or unsupported capture path needs its own declared integration or an explicit
limitation. Never replace the app's reply with a generated recording to make a scene pass.

## Discover before choosing the showcase

Trace actual documentation, UI controls, source and tests. The passive discovery command flags
microphone, audio output, speech synthesis, transcription, turn detection and interruption patterns;
it does not establish semantic capabilities. Cross-check at least:

| Candidate            | What the agent investigates                                       | What a recorded scene must show                                                            |
| -------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Conversation start   | Permission, connection, greeting and stop paths                   | The real session becomes usable and the greeting actually finishes playing                 |
| Spoken turns         | Input route, output sink, provisional/final transcripts           | Generated participant speech followed by genuine recognized text and app speech            |
| Contextual follow-up | Conversation state and follow-up tests                            | A real reply uses earlier context; do not assume memory from a chat-like UI                |
| Interruption         | Input activity, output cancellation/clearing, playback ownership  | New input overlaps audible output, old output stops, and the new question receives a reply |
| Turn handling        | Silence/VAD, manual send, push-to-talk, mute or language controls | Only the behaviours supported by the actual source and approved scenario                   |
| Media/tools          | Catalog/upload, tool commands, decoded image or playable media    | Actual visible/useful content and real viewer navigation, not just a successful load event |
| Recovery             | Stop, reconnect, failed recognition and retry states              | Include only if useful to the agreed showcase; otherwise state the omission                |

For each candidate record source evidence, proposed scene or prominent omission, integration needs and
runtime uncertainty. Configuration alone never proves a feature works. Contradictory or incomplete
evidence stays unknown. Do not promise to enumerate every capability of arbitrary code.

## Commission only the integrations that are missing

Generate adapters in the run workspace, never in the application or this skill. Give any authorized
integration task the target source evidence, approved input/output routes, own paths, API contract,
acceptance checks and permission boundaries. It returns helper files and check evidence, not a claim
that a live feature passed. Tasks may cover distinct real gaps such as input injection or a proprietary
audio transport; do not launch a fixed worker pool, create board tasks or add another orchestrator.
The host/user must permit delegation. Shared implementation ownership stays with the main agent.

No fixed review-round, helper-count or development-minute budget is imposed by this workflow.
Investigate ordinary failures and correct them within scope; stop rather than repeat unproductive
attempts or cross a new access boundary. Paid retakes are never implied by unlimited review.

## Optional browser-page primitives

Import `scripts/lib/voice-capture.mjs` from the installed skill location supplied to the run-local driver.
Both exported functions are self-contained and serializable for the owned page:

```js
await page.addInitScript({ content: `(${installVoiceInput.toString()})()` });
await page.addInitScript({ content: `(${armVoiceCapture.toString()})()` });
// Then navigate/start the real app using repo-specific actions.
const input = await page.evaluate(
	(arg) => globalThis.__sdpVoiceInput.queue(arg),
	{ wavBase64 },
);
const playback = await page.evaluate(() =>
	globalThis.__sdpVoiceCapture.status(),
);
```

`installVoiceInput` replaces audio-only `getUserMedia` for this page with an offline-generated stream.
It accepts audio constraints but refuses camera requests; it never falls through to a physical device.
`queue` returns page-clock `startMs`, duration and sample rate. A zero-valued source continues after the
finite clip, making speech-end observable. Call `__sdpVoiceInput.stop()` during owned teardown to stop
sources/tracks, close the context and restore the original method.

`armVoiceCapture` supports an `HTMLAudioElement` whose `captureStream()` exposes a live audio track.
Tested coverage is Chromium with a `srcObject` MediaStream routed through that element. File/MSE playback
is usable only if the browser exposes the same capture API and the adapter verifies it locally; it is
not certified by the MediaStream fixture. Direct WebAudio buffer/oscillator output, AudioWorklets,
`speechSynthesis`, video-element sound, detached `new Audio()` instances, cross-frame/shadow-root
elements and native/physical output are not intercepted. Those paths require a separate source-led
adapter or an explicit omission. Do not silently use the first convenient source in an ambiguous app.

The primitive watches audio elements created through `document.createElement` or already present
when armed, not elements later inserted by every DOM API. A driver may
bind a source-discovered selector through its argument `{ selector }`; without one, the first playing
audio element is captured and a second playing sink is an ambiguity error. It does not intercept every
possible audio API and never creates assistant speech. Its continuous local recording graph retains
silent intervals while the remote stream idles. `status` reports measured `startedAt`, `firstAudibleAt`,
`lastAudibleAt`, `active` and `error`; activity is sampled every 50ms. Missing audio stays missing.

Before browser teardown, call `__sdpVoiceCapture.stop()`, inspect its error, and transfer
`__sdpVoiceCapture.readOriginal()` using the existing `saveOriginalBlob` utility. It returns a
`Uint8Array`; preserve those bytes and metadata before closing the page. The default 16MiB byte bound
is a capture safety limit, not a review budget; reaching it explicitly marks the original incomplete.
The metadata's `error` remains a failed/incomplete capture even when some original bytes were recovered.
Stop during asynchronous startup waits for that startup's cleanup; startup and recorder failures must
not be reclassified as successful silence. The driver still owns hard deadlines and browser/process cleanup. The primitive does not enforce a
permission sandbox or authorize any network, device or cloud access.

Use the reusable `startFrameCapture`, `finalizeCapture` and `readPageBytes` functions in
`scripts/lib/recording.mjs` for a timestamped page journey. `finalizeCapture` starts both stop callbacks,
waits for both capture clocks to finish, and only then calls the audio-save callback. It preserves
successful audio finalization even if screen finalization fails. Read originals in bounded base64
chunks with `readPageBytes`; do not serialize an entire byte array while screenshots are in flight.
Keep the browser alive until transfer completes. `readPageBytes` accepts an optional `signal` and
`onChunk(bytes, { offset, expectedBytes })`. Persist each validated chunk to an exclusive owned partial
file in that callback when partial-transfer recovery matters. On failure retain its actual length/hash,
label it incomplete and preserve any browser-side original still available; never label a partial file
as the complete declared original. A save callback can attach `error.partialOriginal` metadata for
`finalizeCapture` to retain alongside the independently successful screen/audio stop metadata.
Without that callback transfer bytes are only in memory. Browser blobs do not survive a hard browser
crash; a hung page call still needs the driver's finite watchdog and owned teardown. This API is not a
disk checkpoint or a kill mechanism by itself.

## Owned-action outcomes, not a copied application protocol

For an ordinary non-overlapping spoken action, preserve a fresh output-drained baseline, one owned
action in flight, generated input start/end, the actual accepted speech, scoped tool call/result pairs,
actual output bytes and independently matched completed playback. Exclude stale greetings, prior actions,
typed actions and overlapping input from that claim. Tie the result to relevant observed outcomes
(for example the actual answer, cited source and useful rendered viewer), not just an event's presence.

`checkActionChronology` in `scripts/lib/playback-evidence.mjs` optionally checks adapter-normalized
observations: a baseline `{sequence, atMs, clockId, drained, oneActionInFlight}`, input with `actionId`
and `endMs`, accepted speech, `{call, result}` tool pairs, received PCM and playouts, and `outcomeRefs`.
Events carry the same `clockId`, increasing observation sequences and nonnegative `atMs`; the result
binds `callId` and an `evidenceRef`. Received audio supplies `pcm: Int16Array`, `sampleRate`, `channels`
and the action identity. Playout supplies a digest of those exact little-endian PCM bytes, the same
format/action, `directOutput`, unmodified playback settings, scheduled `startMs` and observed
`endedAtMs`; `atMs` is the scheduling observation, not the scheduled start. An adapter must
preserve the underlying observations and independently establish these bindings; flags/references
alone do not authenticate their origin. No provider/session/endpoint or app-specific protocol is assumed.

Retrieval may paraphrase accepted speech. Keep the actual accepted text and actual retrieval query
separately; do not require lexical equality, introduce a semantic-judge service, or treat a matching
query as proof of audio membership. This helper checks supplied chronology and byte identity only;
it cannot establish semantic relevance, transcript truth, provider causal turn membership or physical
speaker output. Existing `evaluateQualification` remains the separate stricter evidence evaluator;
do not weaken it or invent provider IDs to satisfy it.

The drained-action check is not an interruption evaluator: deliberately overlapping barge-in needs
its own measured input/output cutoff chronology, accepted new question, fresh call/result/answer and
actual new-output identity/completion. UI interruption annotations are optional corroboration, not a
required cross-app event or provider-cancellation acknowledgement.

## Timing and visible acceptance

Page-clock audio observations are not automatically the screen recorder's clock. Compare recorded
audio duration with capture wall time and inspect both early and late picture/audio landmarks. Detect
drift rather than assuming a single offset is enough. A repo-local adapter must supply alignment
evidence or declare uncertainty; the primitive is not proof of synchronization. Preserve genuine UI
transcription latency instead of editing the product to appear faster.

The capture metadata declares `activityWindowMs` and `activityThresholdRms`. Use those same values
with `rmsActivityBounds` in `scripts/lib/audio.mjs` when comparing decoded audio landmarks. A shorter
offline RMS window can count a quiet codec-tail transient that the page analyser did not count;
that mismatch is not independently established drift. Retain the original observations, compare early
and late landmarks and duration, and do not widen a timing bound just to obtain a pass.
The final partial offline RMS window is zero-padded to the declared window size. Window phase,
50ms page polling and codec delay still contribute uncertainty; identical window parameters do not
make the clocks identical. `compareAvLandmarks` in `scripts/lib/playback-evidence.mjs` compares at least
two ordered `{videoMs, audioMs, uncertaintyMs, evidenceRef}` pairs against an explicitly supplied
`toleranceMs`. It reports offsets/drift and retains `unknown` when the bounds overlap the tolerance.
Supply independently mapped recording landmarks, not a page-clock marker relabelled as a physical
measurement. Passing early/late samples does not prove every intervening moment is aligned.

For interruption, record input start/end and the old output's audible cutoff on the same clock, plus the
new recognized question and actual reply. An optional UI interruption annotation may be useful
supporting evidence, but is not a mandatory cross-app protocol. Never manufacture an interruption by
cutting assistant speech in post-production. Label generated participants separately from narrator and
captured app audio; an interrupted transcript may include words that were never played.

## Captions and offline recovery

`playbackCues` in `scripts/lib/playback-evidence.mjs` accepts utterances with `role`, `text`, `complete`,
`expectedChunks`, a `coverageRef`, and associated `plays` containing `startMs`, `durationMs`,
`endedAtMs`, `interrupted`. Starts are relative to the journey. It emits full text only for complete,
covered, finished playback inside the supplied `journeyStartMs`/`journeyEndMs`; missing, interrupted,
partial or outro-crossing utterances are omitted rather than clamped into apparently complete speech.
The adapter owns transcript-to-playback coverage. Mark an interruption explicitly, or caption only an
independently verified audible prefix; do not infer a word prefix by scaling a full transcript to time.
Do not caption a queued unheard ending or let assistant text continue into the narrator outro.

Keep generated participant, generated narrator and actual app output roles distinct. Whole-utterance
spans or any readable subdivisions are approximate, not word alignment. `exportReview` track captions
are caller-supplied descriptions, not an authenticated transcript; use honest annotations when full
speech was not played. Preserve the original transcript and original queued audio even when a documented
derived review mix retains only observed played samples. A scheduled-buffer adapter must handle its own
supported stop/close/playback-rate semantics; a scheduled duration alone is not proof of audibility.

Review export plans each segment's frames independently at 30fps, resets video clocks and bounds
decoded segment audio to the corresponding exact 48kHz sample count before concat. This removes codec
padding rather than trimming real actions. Fractional-duration journeys may gain less than one frame
of repeated tail. Profile/frame checks remain strict; originals and failure intermediates are retained.
The controlled 25fps and fractional-rate fixtures are not a guarantee that every higher-rate/VFR source
preserves every sub-frame visual detail when sampled at 30fps. Verify meaningful early/late rendered
actions and decoded audio after export. Additional composites must explicitly set 30fps/output clocks;
an overlay's `shortest=1` can lose a boundary frame. Validate composite counts against the planned sum,
not a count read back from that output, and do not cap a final render just to hide a mismatch.

For an image, check decoded dimensions, actual rendered bounds, viewport visibility and representative
pixels/frames. A tiny fixture can decode correctly and still be useless in a showcase. Choose appropriate
self-authored or authorized data without changing app CSS or swapping product footage for a slide.
Do not impose a universal minimum image width or height. Validate the actual viewer at the recording
viewport locally before a paid session, and use content-specific visibility/readability criteria. A
simple diagram can be useful at a size that would be inadequate for fine text. Decoding or colored
pixels alone does not establish readability.

The human approves the showcase and its execution permissions once, after any requirements discussion.
The agent owns local integration, tests, ordinary capture/export corrections and final technical checks.
Deliver exact files, shown/omitted coverage and honest limitations for the human's watch/listen review.
