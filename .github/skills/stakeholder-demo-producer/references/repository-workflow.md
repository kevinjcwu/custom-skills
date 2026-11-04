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
4. If a real gap remains, request explicit bounded helper-development permission before generating and
   testing helpers/driver code. Bound the work to one essential gap, at most four helper/page/support/
   driver files, 30 active minutes and two harmless fixture corrections. Stop at a new dependency,
   device, sign-in, outside network, app modification, untestable behavior or exhausted allowance.
   Do not simulate hidden product output or pursue unlimited adapter research.

## Exact recording approval

Helper-development permission does not authorize recording. Before any production process starts,
present a distinct exact approval covering:

- story, audience, shown/omitted coverage and claims;
- driver/helper/startup/input/nonsecret configuration hashes and exact workspace;
- runtime identity and explicit environment;
- allowed network destinations and output/original destinations;
- attempt count, unknown or nonbinding cost estimate, and one hard deadline that reserves time for
  capture finalization, export and owned-process cleanup.

Re-read and verify all approved bytes immediately before spawn. If any identity changes, stop and obtain
renewed approval. Use the existing content hashing functions; a hash binds bytes but does not
authenticate human consent. Do not add a second approval schema/service or imply that a hash is an
approval. Future Azure access requires separately authorized Entra/DefaultAzureCredential token
patterns; never use API keys, inspect credential caches, sign in, or probe a paid service by implication.

## Driver and evidence rules

Drivers are trusted programs with the permissions of their process; they are not filesystem or network
sandboxes. Give children a complete minimal environment and owned cwd, HOME, TMPDIR, cache, profile and
output paths. Reuse only explicitly approved pinned runtimes read-only. Never start a discovered
command, application, browser or service before its exact approval.

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
