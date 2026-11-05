# Agent-orchestrated repository-to-demo workflow

Use this route only when the target's essential journey or required capture/finalization behavior cannot
be expressed by the existing `sdp` contracts. It packages an agent-led process, not a new dispatcher:
inspect the authorized repository, select one coherent user journey, generate only bounded per-demo
helpers/driver code when needed, and compose the existing browser, helper, process, narration and export
utilities. Do not retrofit legacy CLI/schema behavior or describe this route as `sdp demo`.

## Discover and decide

1. Confirm repository scope, read permissions, audience, confidentiality, data rights, allowed runtime,
   startup and network boundaries. Use a fresh owned per-demo workspace with `plans/`, `helpers/`,
   `inputs/`, nonsecret `config/`, `manifests/`, `originals/`, `exports/` and `evidence/`. Never use
   task-specific or machine-specific paths in packaged instructions or reuse a prior conversation.
2. Read actual startup, user-visible capabilities and interaction paths from source, tests and docs.
   Choose one audience-appropriate essential journey. List discovered features as shown or omitted with
   a reason; inventory and automated discovery are not proof of exhaustive semantic coverage.
3. Classify essential interactions before production: ordinary-browser feasible, unsupported
   interaction, missing prerequisite, timeout, product error, cancellation or authority failure.
   Distinguish an incorrect selector/startup assumption from a demonstrated product defect. Prefer
   existing ordinary browser steps when they suffice.
4. Present a concise proposed showcase: audience/outcome, source-backed capabilities, selected scenes,
   important omissions, required integrations, startup, generated versus captured voices, external
   services/cost uncertainty and execution limits. Discuss requirements and scene changes until the
   human is satisfied. Do not silently drop a distinctive feature because its adapter is missing.
   If a task explicitly excludes a feature, prominently show that exclusion rather than overriding it.
5. Obtain one approval covering the agreed showcase, declared helper development/local checks and
   production access. Existing development authority may cover preparation before this approval;
   otherwise do not write helpers or execute the app first. Review and preparation have no fixed round,
   minute or helper-file budget. Make productive corrections within the approved scope without another
   acknowledgement. Stop when blocked by new access, dependency installation, device use, sign-in,
   app modification, material story change or spending authority not already covered.
6. For each concrete interaction gap, reuse packaged primitives and generate the smallest repo-local
   adapter. When the user/host permits task delegation, commission focused integration tasks with the
   discovered source evidence, input/output contract, owned paths, approved access and acceptance
   checks. Integrate and verify their results; do not create work-board tasks, switch orchestrators or
   assume delegation permission. Do not invent actors or adapters when no gap exists.

For voice repositories, follow [voice-integration.md](voice-integration.md). Inspect input/output,
transcripts, turn detection, interruption/cancellation, contextual follow-ups and media/tool interaction
across source, tests and visible controls. Literal discovery signals are investigation leads, not proof
that these features exist or work. Record unknowns and evidence; never claim exhaustive discovery.

## Exact recording approval

Helper-development permission alone does not authorize recording. The single showcase approval must
explicitly cover production as well. A research/preparation-only grant remains research/preparation-only.
Before any production process starts, seal and verify the implementation against that approval:

- story, audience, shown/omitted coverage and claims;
- driver/helper/startup/input/nonsecret configuration hashes and exact workspace;
- runtime identity and explicit environment;
- allowed network destinations and output/original destinations;
- any explicit human retake/attempt budget, unknown or nonbinding cost estimate, and one finite hard deadline that reserves time for
  capture finalization, export and owned-process cleanup.

Record the human's actual scope and the implementation identities; the human need not handle hashes.
Generate helpers after approval only within its declared integration/access boundaries, then seal their
tested bytes. Re-read all sealed bytes immediately before spawn. Ordinary authorized helper corrections
require checking and resealing, not another human review; changes to app identity, permissions,
destinations, story or spending beyond the approved boundary need renewed consent. Do not launch an
unapproved extra session or disguise a live retry as a local check. Use existing hashing functions; a
hash binds bytes but does not authenticate human consent. Do not add a second approval schema/service.
Azure access requires authorized Entra/DefaultAzureCredential token
patterns; never use API keys, inspect credential caches, sign in, or probe a paid service by implication.

## Driver and evidence rules

Drivers are trusted programs with the permissions of their process; they are not filesystem or network
sandboxes. Give children a complete minimal environment and owned cwd, HOME, TMPDIR, cache, profile and
output paths. Reuse only explicitly approved pinned runtimes read-only. Never start a discovered
command, application, browser or service before its exact approval.

Use the reusable `startFrameCapture`, `finalizeCapture` and `readPageBytes` functions in
`scripts/lib/recording.mjs` when composing timestamped page capture. Stop and timestamp both captures
before transferring originals; do not keep taking screenshots during a whole-array serialization.
Exercise startup and finalization locally before consuming a paid conversation. Validate media with
the actual viewer and recording viewport; do not invent a universal image-size gate.

Use `scripts/lib/recording.mjs` to correlate a declared `sdp.helper.v1` page call with its full structured
reply in `result.transcript`; the human-readable `detail` is truncated and is not the payload. Transfer
declared original bytes through an explicit page reader, verify byte bounds and optional expected hash,
and write exclusively beneath the owned originals directory. Missing, duplicate, failed or mismatched
page replies stay missing/failed/unknown; do not convert a helper's claim into product evidence.

The generated driver owns two separate stops:

- **Interaction stop** ends every new action/helper immediately on the first failure, unknown result,
  cancellation or action timeout. No retry, new question, session, product action or recovery attempt.
- **Hard stop** bounds the entire approved run, including finalization, export and cleanup. Pass it to
  browser ownership, but do not pass an already-aborted interaction-stop signal to finalization.

After interaction stop, only finalization of already-running capture is allowed: stop existing recorders,
wait for stop/data events, flush and transfer originals/partial media, close the browser to save screen
video, then stop owned process groups. Finalization gets only the remaining hard-deadline time. A hung
finalizer triggers owned teardown; preserve already persisted bytes and report missing or undecodable
media rather than claiming success. Persist chunks/checkpoints when an end-of-run browser blob is not
sufficient to survive a hard crash. Never claim hard-crash media preservation without evidence.

Use `scripts/lib/review-export.mjs` for review assembly, not the standard `produce` command's completed-run
gate. Keep the screen journey uncut; generated helper audio and helper-captured audio remain distinct,
explicitly labelled and coarsely timed with unknown picture/sound uncertainty. Narrate before and after
the journey, generate readable role-labelled VTT and a reviewable H.264/AAC MP4, and preserve originals
and intermediates on failure. A missing reply may yield an explicitly incomplete review candidate, never
a synthesized reply or a completed/released run. Claims must be source-backed or actually observed.

Check more than playable media: actual image visibility/size, role-labelled caption/audio windows,
assistant speech completion, input overlap and cutoff for interruption, and audio/video alignment at
both early and late landmarks. Do not use a status label, decoded pixel count or optional transcript
annotation as the sole evidence of a user-visible outcome. Check real app frames before selecting the
opening still; an empty first recorder frame is not a useful intro. Frame conversion preserves the whole
journey duration with at most one repeated tail frame to reach the output frame boundary; rate
conversion is not proof that every higher-rate/VFR sub-frame detail survived. Check meaningful
rendered actions. It must not speed up app behaviour. Preserve original media and disclose
synchronization edits or uncertainty.

Handle ordinary local capture/export corrections inside the approved scope; ask only at a real new
boundary. Structural failure remains failure until evidence resolves it; do not weaken checks or claim
the whole storyboard passed when only some scenes were recorded. Give an honest partial candidate
when the remaining authority does not permit completing it.

Report exact MP4, VTT and original paths/hashes, coverage, provenance, all limitations, cleanup result,
and stage times. Separate setup, warm production/export, approval/human wait, observable reasoning,
end-to-end and failure turnaround. Mark unobservable values unknown; invent no speed, threshold,
coverage percentage or general platform claim. Structural checks are not a full-file human watch/listen
review.

## Acceptance boundary

The package's controlled fixture tests prove only the tested ordinary-browser/helper composition and
export. A fresh independent-session acceptance is separate: that session must receive only the packaged
skill, an authorized controlled ordinary-browser repository, and explicit user requirements/permissions;
it must inspect, plan, test any needed helper, obtain exact production approval, and deliver a real
reviewable artifact. Do not use prior task context as fresh-session evidence. New workers, paid/live
voice runs, universal voice/Fabric/Foundry support and human full-file acceptance require their own
explicit authority.
