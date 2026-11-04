# Offline voice qualification evidence

This is an offline evidence evaluator and regression checklist, **not live voice support**. It ships no
caller, speech injector, audio router, browser launch option, provider integration or new CLI command.
The ordinary browser feasibility command still rejects essential helper/device interactions.

`scripts/lib/qualification.mjs` exports `evaluateQualification`. It is pure: it evaluates supplied
observations without starting work, waiting, reading files, opening devices or making network requests.
The caller still owns exact-plan approval, deadlines, cancellation, capture, attribution and cleanup
through the existing runner/helper mechanisms. A pass cannot independently authenticate supplied facts.

## Stages and results

Each call supplies `stage`, `startMs`, `nowMs`, `deadlineMs`, optional `cancelled`, `evidenceRefs` and
`evidence`. Stage timestamps/deadlines use one monotonic clock. Other observations retain their own
explicit clocks; they are not silently converted to that clock. Results include stage, status, code,
timestamps, elapsed milliseconds, evidence references, one next action and `scope: "supplied-evidence-only"`:

- `pass`: supplied evidence satisfies this stage only, never automatic release.
- `wait`: input/output gates are not ready, or the response baseline changed. Observe again within the
  same deadline; do not send speech or restart the session.
- `unknown`: evidence, attribution, source/membership or necessary timing cannot be established.
- `failed`: a positive qualification contradiction, such as wrong identity/source, corrupt media,
  competing output or unsuccessful generation. This does not automatically diagnose a product/Azure fault.
- `timeout`, `cancelled`: stop and use the existing owned-resource cleanup; no automatic retry.

The evaluator does not schedule repeated calls or enforce a process timeout itself. The action/run
deadline and cancellation remain the existing runner's responsibility. Scope startup/auth failures to
their actual stage; a presentation-state race is not evidence of an Azure or transport failure.

### Readiness and the input boundary

For `readiness`, supply the current `sessionId` and a `snapshot` with that same ID, `atMs` equal to
`nowMs`, boolean `peerReady`, `inputEnabled`, `outputActive`, and unique `responseIds`. A presentation
label such as "Listening" is not a readiness signal by itself. A passing result supplies a response
`baseline` with session ID, time and the IDs already observed.

For `before-input`, supply that baseline and an immediate fresh snapshot. An active output/greeting
prevents input. Any changed response IDs invalidate the baseline even after the output stops; obtain a
new readiness baseline before proceeding. A changed session, stale observation or missing gate is
unknown. The integration must recheck at actual send time; these synchronous checks do not make a
later asynchronous send atomic or prove a real app exposes the proposed observations.

The synthetic regression reproduces a "Listening" observation followed by an automatic greeting during
the runner's 500 ms settle period. It verifies waiting/baseline renewal rather than insisting that a
transient UI label remain unchanged.

### Current-turn response

For `response`, retain the same current session, baseline and authoritative normalized causal IDs.
Do not invent a shared turn ID from time, order, a transcript or per-item ordinal. Supply:

- `clock`: stage-clock `id` and `origin`; input/control facts must refer to this actual origin.
- `input`: fresh `id`, `turnId`, `sessionId`, `sentAtMs`, typed `sent` observation,
  `deliveryObserved: true` and actual accepted-input evidence `deliveryRef`.
- `response`: fresh `id` absent from the baseline, matching `inputId`, `turnId`, `sessionId`,
  authoritative ledger `associationRef`, and `generation: { status, completed }`.
  `completed` is a typed generation-completion receipt, not a received-media endpoint.
- `receiver`: actual app `sessionId`, `peerId`, receiving `trackId` and source `bindingRef`.
- `audio`: matching `sessionId`/`responseId` and the records below.

| Audio record | Required contents |
|---|---|
| `source` | Same session/peer/track/binding as `receiver`, and `direction: "received"`; participant/sent audio is not output evidence. |
| `artifacts` | `original: { ref, sha256 }`, `decoded: { ref, sha256, pcmSha256 }`, and `conversionRef`. Preserve originals/conversion effects; no padding/trimming to fit a time interval. |
| `pcm` | `bitDepth: 16`, 1 or 2 channels, integer sample rate 8000-96000, declared integer `frames`, and nonempty aligned decoded interleaved `Int16Array` `samples`. |
| `membership` | The structured response/source/artifact/history witness described below, not a bare response label or `verified:true`. |
| `capture` | Typed `started` recorder-start-event and `finalized` recorder-stop-event observations. |
| `output` | Matching `responseId`, `status: "drained"`, typed received-output `started` and `drained` observations. A cleared/interrupted output is not this complete reply. |
| `observations` | Optional additional typed render/provider/control observations; unknown uncertainty stays null and different origins remain separate. |

Decoded frame count must equal `samples.length / channels`. The evaluator hashes the samples as
canonical interleaved signed PCM16 little-endian bytes and compares that digest with
`artifacts.decoded.pcmSha256`. This is distinct from the whole decoded-file `sha256`, which includes
its container/header. Nonempty digital-nonzero samples are only a signal sanity check, not proof of
speech, audibility, intelligibility or acoustic quality. Existing media validation and human listening
are still necessary.

The result's `media.mediaDurationMs = frames / sampleRate * 1000` is explicitly **derived media
duration**. It is not compared with recorder-control duration and is never used to manufacture an end
timestamp. There is no one-sample wall-duration gate, replacement millisecond tolerance or measured
error bound. No historical response envelope is enlarged or rewritten.

### Membership and trusted source verification

`membership.kind` is `response-bound-received-capture`. It must bind the same `sessionId`, `responseId`,
`peerId`, `trackId`, source `bindingRef`, response `associationRef`, and exact `originalSha256`,
`decodedSha256` and `pcmSha256`. It additionally requires independently supported `isolationRef` and
`coverageRef`, plus `history: { ref, responseIds, baselineResponseIds, gaps }`.

The referenced output history must account for the actual pre-input baseline and the response's
received-media isolation/coverage. Its `baselineResponseIds` must match the captured baseline;
`responseIds` must contain only this fresh response. Missing history, missing baseline exclusions,
empty response membership or nonempty `gaps` is unknown. A known greeting/prior/other response within
the candidate is a competing-output failure. A timing window or matching label alone is insufficient.

**These are evidence references, not verification flags.** The pure evaluator checks internal joins,
sample digest and policy consistency; it cannot read referenced files, authenticate their hashes,
authenticate a producer or establish that a claimed isolation proof is true. The future trusted
producer/composition/export/consumer path must actually verify source ownership, artifacts,
authoritative causal association, complete history and response-to-received-media membership.
Invented references or `verified:true` cannot replace that work. A unit pass must never be reported
as an actual integration result.

That backend bridge and actual membership evidence remain unresolved. The current real helper and
the historical 660-ms synthetic-tone recording are not upgraded by this contract. The latter has no
actual input/response association or membership and remains unknown.

### Typed clocks, generation and received output

Every timing observation has `sourceRef`, `clockId`, `clockOrigin`, `meaning`, finite `atMs`, and
`uncertaintyMs`. Uncertainty is either `null` (unknown) or
`{ before, after, basisRef }`, with nonnegative bounds supported by the referenced evidence. Explicit
zero bounds in synthetic fixtures describe that fixture, not measured browser accuracy.

The required meanings are `input-sent`, `generation-completed-receipt`, `recorder-start-event`,
`recorder-stop-event`, `received-output-start` and `received-output-drain`. Do not relabel a provider
buffer event as actual received-media drain unless a trustworthy mapping establishes that meaning.
Additional observations retain their actual meaning, including provider-relative negative offsets.

As a conservative control-coverage prerequisite, require recorder-start before input, input before
received-output start, output start before drain and drain before recorder finalization. These control
facts must be inside the stage interval and on its same clock ID/origin with supported uncertainty.
Order is proven only when the earlier observation's latest possible time is strictly before the
later one's earliest possible time. Touching/overlapping ranges, unknown uncertainty or different
origins are unknown; demonstrably reversed order is a contradiction. No clock-mapping solver ships.
These checks do **not** independently identify recorded first/last samples or replace the mandatory
membership proof.

Generation status must actually be completed; failed/cancelled/incomplete generation cannot qualify.
Keep its receipt clock separate where necessary. Generation completion may precede later received
audio/drain. Different-clock completion/render/provider observations are preserved without invented
ordering, and `timing.sampleClockMapping` remains null. A same-clock generation receipt cannot
contradict the input or stage interval. Model completion, provider drain, recording finalization,
browser sink observations and actual listening are different facts.

A pass requires the supplied mandatory identity/source/membership/received-media evidence to satisfy
these checks; missing necessary timing still blocks it. Optional sample-clock mapping and latency can
remain unknown only when attribution does not depend on them, and permit no quantitative timing claim.
Human full-file listening must separately reject truncation, substitution or unintelligibility;
neither a nonzero sample nor a drain/stop/play callback proves a viewer heard a usable complete reply.

## Offline validation versus live prerequisites

`tests/voice-qualification.test.mjs` drives the actual generic `runHelper` subprocess protocol.
The declared `page.capture` expression is executed in a synthetic VM page for arm and speak; undeclared
`capture` is refused before evaluation. No real browser/app/session is used. Synthetic state and PCM
blocks test readiness, attribution, typed-clock policy, media integrity, deadlines and cleanup, not
real speech, independently authenticated membership, cross-process integration or two-peer transport.
The complete fixture's references and original/decoded file hashes are explicitly synthetic placeholders;
only its PCM digest is computed from its synthetic samples.

Default app behavior remains the reference. This contract does not authorize or implement controlled
VAD, interruption or custom context. Their effects would need a separate human behavior decision,
not an evaluator workaround.

Before any live qualification, separately resolve:

- Paid usage with an unknown total: the current cost contract must honestly express the approved
  nonbinding estimate. Never invent a guaranteed ceiling or treat an offline plan as Azure approval.
- HTTP/WebSocket allowlists versus WebRTC peer/media traffic and process egress: interception is not a
  network sandbox, nor does it establish that peer traffic is impossible.
- Approved caller access/reuse, exact helper/script mappings and actual app evidence signals.
- Already-authorized identity, configuration, approved data and an exact live plan with explicit
  attempt allowance, destinations, usage, deadlines and cleanup.

These regressions do not authorize any of those prerequisites. Do not copy private helpers, weaken
browser defaults, add dependencies or grow a caller under the heading of qualification.

Keep integration/debugging time visible separately from setup, execution/export and human approval.
Use explicit finite correction/time budgets; these are not independently installed monitoring unless
such enforcement actually exists. A qualified interaction still needs an evidence-backed story and a
human's full-file watch/listen review of any final exported video.
