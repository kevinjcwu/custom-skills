---
name: stakeholder-demo-producer
description: >-
  Turns an authorized code repository into an honest narrated product demo. Use it when someone requests
  a product walkthrough or stakeholder video: inspect real user journeys, identify missing interactions,
  develop only bounded approved per-demo helpers, and obtain exact recording approval. Use the existing
  sdp workflow where its contracts fit; otherwise an agent may orchestrate a run-local driver from the
  proven browser/helper/media utilities. Produce a narrated MP4, readable captions, originals and
  provenance/coverage notes. Never invent product output or release automatically; a person must watch
  and listen to the exact file.
compatibility: Node.js 24 (verified on 24.22.0). Core commands use Node built-ins only. Browser capture, offline speech synthesis and export use a pinned project-local toolchain installed by setup, verified on linux x64 Ubuntu 22.04 only.
---

# Stakeholder demo producer

Make honest product demos: show the running app doing what a user can do with it, explain each step in
plain words, and say plainly what was left out. Never invent features, replies, metrics or quality claims.

All helper commands run through one dispatcher with Node built-ins only:

```sh
node scripts/sdp.mjs <command> [options]
```

Paths in this skill are relative to the skill folder. Every command prints one JSON document. Exit codes:
`0` ok, `1` failed or invalid, `2` usage error, `3` blocked (needs an approval, a tool or a fix).

## The narrator

Every demo has a narrator: the generated voice-over that explains what the viewer is seeing and how to use
the app. It is part of video production, not an optional extra, and it is the only voice the skill itself
provides. Any other sound in a demo comes from a run-local helper written for that app (below), is
labelled by the plan, and is never presented as the app's own output unless the app really produced it.

## What ships with the skill, and what you write per demo

- **Generic core (every demo):** discovery, clarifying questions, the evidence-backed demo plan with one
  plain-language approval, the run (start, record, stop, clean up), narration, captions, export, the
  coverage report and structural QA.
- **Generic interaction adapters:** a recorded browser (fixed page steps), terminal commands and HTTP
  requests, chosen per scene from what the app needs. A CLI demo starts no browser.
- **One generic bundled helper:** `scripts/helpers/static-server.mjs`, a static file server for a page that
  has no server of its own.
- **Examples (illustration only, never required):** `examples/cli` and `examples/inventory-recon`
  describe synthetic test fixtures. `examples/cli/helpers/seed-items.mjs` shows what a per-demo helper
  looks like; it is not a bundled tool. Never copy an example story onto a real repository.
- **Written by you per demo (run artifacts, not part of the skill):** the catalog, the demo plan, any
  `helpers/` files for that app, the run folder, exports and `demo-report.json`.
- **Local state (never distributed):** `.runtime/` (the installed toolchain) and `.runs/` (past runs) are
  ignored by version control. Share or copy the skill from version control, without them.

The skill ships no app-specific integrations or complete voice caller. Optional browser-page
[voice primitives](references/voice-integration.md) supply generated audio-only input and continuous
sink-audio capture, not repository selectors, conversation attribution or network isolation.
Reusable timestamped frames, stop-before-transfer finalization and bounded original-byte transfer
are available in `scripts/lib/recording.mjs`; use them instead of inventing capture shutdown per demo.
If discovery shows the app needs an interaction the adapters cannot perform (for
example a user speaking to the app, a file upload driven from outside the page, a device the browser
does not have), investigate the app, then write, test and declare the missing piece as a run-local
helper ([references/run-local-helpers.md](references/run-local-helpers.md)). The packaged scripts never
invent it, and a helper is never written into the app or added to the skill.

[Offline voice qualification](references/voice-qualification.md) provides pure readiness/attribution
checks and generic-runner regressions only. It adds no live voice support or caller and does not change
the browser-only feasibility boundary.

## Choosing tools from the app, not the toolbox

Understand the app and its user journey first, then pick only what that demo needs. Do not ask the human
to design the toolchain. Reuse the bundled static server when it fits. Write a helper only for something
genuinely missing, and keep it small: it does one interaction for this app.

Writing and self-testing a helper is local development work in this folder and the run workspace; do it
only within the access the human has already given you. Approving the plan later does not authorize
anything you did before it. Stop and ask, instead of acting, if a helper would need a new tool or
dependency, a device, a sign-in, network access the human has not agreed to, a change to the app, or
anything you cannot test locally.

## Choose the supported orchestration route

Use the existing `sdp` workflow when the repository journey fits its checked contracts and adapters.
Do not add behavior to those commands by implication. If an essential interaction or required
finalization policy cannot be expressed by that workflow, the agent may develop a bounded driver in the
separate per-demo workspace and compose the existing browser, helper, process, narration and export
utilities. Follow [references/repository-workflow.md](references/repository-workflow.md) for its
declared development permission, single showcase/execution approval, hard deadline, originals, honest partial
exports and evidence. A generated driver is trusted code, not a sandbox, and is never shipped as a
generic app integration.

The desired interaction is: point at the repository, receive a concise proposed showcase, discuss any
requirements or scene changes, approve the agreed execution scope once, then receive the video and
honest limitations. The agent owns discovery, integration work and routine technical correction; the
human reviews the story and permissions, not selectors or internal tests. Review has no fixed iteration
budget. Execution still has explicit time, network, cost/attempt and cleanup boundaries. An unknown
integration or new privilege is a real stop, not permission to improvise access.

## Main workflow

Work through these steps in order. Do not skip the approval, and do not present a blocked step as done.
The numbered `sdp` commands below describe the existing CLI route; the agent-orchestrated driver route
has distinct approval and evidence rules in the reference above.

For a repository requiring a new interaction integration, use the agent-orchestrated sequence:
discover → propose/discuss showcase and integration scope → approve development and execution once →
implement/check repo-local helpers → seal exact inputs → record/export/check → deliver. Do not force
the human through an additional preparation approval when that development was already authorized.
The CLI sequence below applies when its existing contracts and prepared adapters fit the journey.

1. **Discover** (available now). Run `discover --root <repo> --out catalog.json`, then read the evidence
   and extend the catalog with what a user can see and do: capabilities with `userVisible: true`, their
   class and evidence, and complete user workflows
   ([references/discovery.md](references/discovery.md)). Decide yourself how a user interacts with the
   app, and note each interaction the browser, terminal and HTTP adapters cannot perform: those are the
   helpers you will need. Never ask the human for a feature list.
2. **Clarify** (available now). Ask only what the repository cannot tell you: the audience (business,
   engineering or both), what is confidential on screen, which features matter most or may be left out,
   how the app is started on this machine (for example which sign-in the human has already done for
   identity-based cloud access; the skill never signs in for them), whether paid services may be used,
   and, if the app needs a helper, anything about it you cannot find out yourself (a device, a sample
   input, an outside service).
3. **Write and test any helpers** (available now, only when discovery found a gap). Write each one in a
   `helpers/` folder next to the plan, test it locally against a synthetic or harmless input, and record
   in the plan what it needs, reads, writes and reports
   ([references/run-local-helpers.md](references/run-local-helpers.md)). If you cannot make it work
   without new access, stop and ask.
4. **Write one demo plan** (available now). A `demo-plan.v1` file holds the story, the narrator label,
   the feature coverage, how the app runs, any helper files and the interactions they perform, outside
   services, a cost estimate and a
   whole-run time limit ([references/demo-plan.md](references/demo-plan.md),
   [references/storytelling.md](references/storytelling.md)). Every user-visible feature is either shown
   in a scene or left out with a reason. Architecture cards are off unless the human asks for them.
   Worked example (a synthetic fixture): `examples/cli/demo-plan.json` (CLI: narrator only, plus one
   helper written for that demo).
5. **Get the plan approved** (available now). Run `plan --plan demo-plan.json --catalog catalog.json
--out plan-summary.md` and show the human the summary. Change the plan as they ask and run `plan`
   again. The human approves the plan once, in plain words; they never handle hashes. The `sha256`
   printed by `plan` is how you tie the run to exactly the plan they approved. One approval covers
   building, testing and using the declared helpers within the plan's limits, and nothing more.
6. **Check browser feasibility early** (when the plan has browser scenes). Make the first browser
   scene the minimal essential user outcome, with 1-5 ordinary browser actions. After plan approval,
   run `feasibility --plan demo-plan.json --catalog catalog.json --confirm-plan-sha256 <hash>`.
   It records only that scene using the same approved plan hash, with no second approval; other scenes
   are explicitly skipped in its run record. Continue to full production only when it passes. If the
   essential interaction needs a device, microphone, helper or another unsupported operation, it fails
   promptly with an actionable diagnostic rather than substituting a simulated interaction.
7. **Produce** (available now). First run `setup check` (and, with the human's approval, `setup
install`). Then run `demo --plan demo-plan.json --catalog catalog.json --confirm-plan-sha256 <hash>`
   with the hash of the approved plan. There is no spending cap by default: approving the plan approves
   its estimate. `--max-spend-usd` is only for a human who asks for an extra limit. The command checks
   the plan again, starts the app exactly as planned, records every scene, stops at the first failure or
   the time limit, cleans up, runs structural QA, checks the export profile unless a calibration is
   given, and writes one narrated MP4 with captions per audience and a `demo-report.json`.
8. **Human review** (always a person). `ready-for-human-review` means the structural checks passed, not
   that the demo is good. Give the human each exact file and its SHA-256 to watch and listen to in full,
   together with the coverage report and the limitations. Automatic release is not implemented (blocked).

If any step fails or is blocked, stop and report it with the reason from the JSON output. Do not retry by
loosening the approved plan yourself.

## Commands

Main workflow, available now:

- `discover --root <dir> [--label <text>] [--out <file>] [--max-files <n>] [--max-file-bytes <n>] [--max-total-bytes <n>]`
- `plan --plan <file> --catalog <file> [--out <summary.md>]`: check a demo plan, print its `sha256` and a
  readable summary to approve
- `feasibility --plan <file> --catalog <file> --confirm-plan-sha256 <sha256> [--run-id <id>]`: record
  only the first browser scene (1-5 fixed browser actions, no interaction helper) using the same
  approved demo-plan hash; report unsupported interaction, missing prerequisites, timeout, product
  error or a passed check without claiming a final export
- `demo --plan <file> --catalog <file> --confirm-plan-sha256 <sha256> [--calibration <file>] [--max-spend-usd <amount>]`:
  run the approved plan and produce the narrated exports and `demo-report.json`
- `setup check|install`: verify or install the pinned project-local toolchain (`.runtime/`): narration,
  browser and export, nothing else

Building blocks, available now (the main workflow uses them; call them directly only to debug a step):

- `validate <file> [--catalog <file>] [--storyboard <file>] [--manifest <file>] [--run-id <id>]`
- `hash <file>`: canonical SHA-256 of a JSON contract
- `preflight --catalog <file> --storyboard <file> --authorization <file> [--out <file>]`
- `run --catalog <file> --storyboard <file> --authorization <file> --confirm-authorization-sha256 <sha256> [--run-id <id>]`
- `manifest --run <dir>`: re-verify artifact hashes and listing
- `qa --run <dir>`: structural QA; writes `claim-ledger.json` and `qa-report.json`
- `calibrate [--scope export] [--runs-dir <dir>]`: checks the export profile and narration levels
- `produce --run <dir> --calibration <file> [--audience business|engineering] [--runs-dir <dir>]`
  (alias `export`)

Moved (exit 2 with the replacement): `capture` and `browser` are part of `run`; `narrate`, `tts`,
`captions` and `mux` are part of `produce`.

Contract details are in [references/contracts.md](references/contracts.md), run records, QA and export
checks in [references/evidence-and-qa.md](references/evidence-and-qa.md), run rules in
[references/runtime-authority.md](references/runtime-authority.md) and platform coverage in
[references/platform-support.md](references/platform-support.md).

## Claim rules

- Every claim has a class: `fact`, `observed`, `source-backed`, `documented`, `inferred` or `unknown`.
- Only `fact`, `observed`, `source-backed` and `documented` claims may be narrated, and only with hashed
  evidence or a step that passed. `observed` claims need a step that passed in this run.
- `inferred` and `unknown` claims are never narrated as true.
- No numbers, speed or scale claims without a recorded measurement; no absolute quality claims. The
  catalog's `forbiddenClaims` patterns are enforced on narration.
- Never script, fake or replace the app's own output. Media a helper generated (for example a simulated
  user's voice) is labelled as generated, never as the app.
- A helper's "done" is its own claim. A helper step counts as passed only with the run's own evidence
  (page text that newly appeared, valid media). That evidence does not prove the app's reply belonged to
  the helper's action; if the helper cannot tell which reply is the current one, it must report
  `unknown`, and the story must not claim the interaction worked.
- A `synthetic-fixture` run demonstrates the toolchain only; it never supports a claim about the target.

## Stop and ask

Stop and ask the human when:

- the audience, confidentiality, how the app is started or whether paid services may be used is unknown;
- the app needs an interaction you cannot build as a tested helper within the access you have;
- the app needs a sign-in, secret or data you do not have (ask them to provide it themselves, for example
  by signing in on this machine; never copy secrets into the plan);
- a scene needs data that is not synthetic or whose rights are not confirmed;
- the cost estimate is unusually high for a demo, or you cannot estimate it;
- `plan` reports the plan invalid in a way that changes what the human approved;
- `demo` exits 1 or 3, or reports anything other than `ready-for-human-review`, and resolving the
  failure needs a new permission, material story change, spending/retake or application change.
  Preserve the failed result; ordinary authorized local repairs, tests and resealing need no new
  human hash approval. Never rerun a paid/live interaction by implication.

## License

Repository-authored skill code and documentation use the [MIT License](LICENSE). Downloaded tools
and voices retain their own terms; see [third-party notices](THIRD_PARTY_NOTICES.md). Keep both files
when copying this skill. Do not distribute local runtimes, recordings or private application data
as though the skill's license covered them.
