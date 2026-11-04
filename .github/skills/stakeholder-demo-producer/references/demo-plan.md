# Demo plan

The demo plan (`demo-plan.v1`) is the one document the human approves. It holds everything the demo will
do, so one approval covers the story, the app start-up, any helpers written for this app, the cost and
the limits together.

A worked example for a synthetic command-line fixture, with placeholder paths, the narrator only and one
helper written for that demo: [../examples/cli/demo-plan.json](../examples/cli/demo-plan.json) with
[../examples/cli/catalog.json](../examples/cli/catalog.json). Run `plan` on it to see the summary a human
approves. It illustrates the format; never copy its story onto a real repository.

## Fields

- `catalogSha256`: canonical hash of the catalog the plan was written from.
- `voices`: `narrator`, the on-screen and caption label of the generated voice-over every demo has.
  Media from a run-local helper is labelled by its interaction's `media` entries instead, and those
  labels must differ from the narrator's.
- `features`: one entry per user-visible catalog capability (`userVisible: true`). Each entry has either
  `scenes` (the scenes that show it; each scene must list that capability) or `omitted.reason` (why it is
  left out, for example "needs a customer account we do not have"). Nothing user-visible is skipped
  silently.
- `helpers`: small files copied into the run workspace under `helpers/`, each with `source` (`skill`: a
  file in this skill's `scripts/helpers/`; `plan-dir`: a file in a real (not linked) `helpers/` folder next to the plan),
  `file`, `sha256` and `purpose`. Use them instead of changing the repository, for example
  `static-server.mjs` serves a static page that has no server of its own. Choose helpers from what the
  app needs: reuse an existing helper only when it fits, otherwise write a small one for this demo only
  in `helpers/` next to the plan (`plan-dir`). Such a helper is not added to the skill's bundled
  `scripts/helpers/`; promote one only after it has proved useful across several demos and been
  reviewed. Interaction helpers and their page scripts are listed here too and declared in
  `runtime.interactions` ([run-local-helpers.md](run-local-helpers.md)). Commands use them as
  `{workspace}/helpers/<file>`; the plan must declare `runtime.workspace`, and `plan` refuses a command
  or interaction that refers to a helper the plan does not list. Each file is checked again at
  run time (regular file, at most 1 MB, same SHA-256).
- `externalDestinations`: hosts outside this machine that the app's own processes are expected to reach,
  with their purpose. A paid plan must declare at least one, and every non-loopback `runtime.http`
  request origin must be listed here (paid or not), so the summary shows each outside host. The summary
  shows each HTTP step with its full origin and path.
- `estimate`: `cloud` (whether the run uses paid services), `amountUsd` (worst-case estimate for one run,
  `null` when not paid), `basis` (how you estimated it) and `maxRunSeconds` (whole-run time limit).
- `allowArchitectureCards`: `false` unless the human asked for architecture cards. A product demo shows
  the running app; architecture is usually presented by a person.
- `storyboard`: a complete `storyboard.v1` ([storytelling.md](storytelling.md)).
- `runtime`: a `run-authorization.v1` without `schema`, `storyboardSha256` and `approvalRecord`
  ([runtime-authority.md](runtime-authority.md)). The plan adds the storyboard hash itself.

## Approval

`plan --plan <file> --catalog <file> --out plan-summary.md` checks the plan and prints `{valid, sha256,
summary}`. The summary is written for a person in plain words: the scenes and their steps, the narrator
and any helper media with whether it is generated or recorded, the features shown and left out, exactly
how the app is started (commands, working folders, passed-through environment variable names, helper
files), each run-local helper with its purpose and page access (with the notes that it is not sandboxed
and that its "done" is only a claim), the outside services and cost, the time limit, a sign-in note and
what the human will get. Show it and ask the human to approve it as it stands or ask for changes.
That plain approval is the only human step; the human does not need to check or copy a hash.

The `sha256` is the agent's internal binding: after approval the agent runs `demo` with
`--confirm-plan-sha256` set to the hash of exactly the summarised plan, and `demo` refuses any other plan
(exit 3 `confirmation-mismatch`). Every change to the plan changes the hash, so re-run `plan` after each
requested change and ask again. The approved plan covers the derived run authorization; there is no
separate authorization step.

## Cost

There is no default spending cap and no separate spend approval. The estimate is in the summary the
human approves. Tell the human when the estimate is unusually high or you cannot make one, and ask
before going on. `--max-spend-usd` is an optional extra limit for a human who wants one: when given and
below the estimate, `demo` refuses to start (exit 3 `estimate-over-limit`). The skill cannot meter what
the app itself spends; the whole-run time limit bounds every run.

## Sign-in and secrets

The skill never signs in, creates credentials or copies secrets into a plan. If the app uses an
identity-based sign-in (for example a cloud CLI login that the app's credential chain picks up), the
human signs in on this machine themselves, and the plan passes only the needed environment variable
names through (`envPassthrough`). `plan`
refuses any `env` or `envPassthrough` name that looks like a secret (`KEY`, `SECRET`, `TOKEN`, `PASSWORD`,
`CREDENTIAL`, `CONNECTION`), so key-based access cannot be slipped into an approved plan.

## What `demo` does

1. Checks the plan, the approval hash, the optional spend limit and the helper files.
2. Runs passive preflight and checks the toolchain.
3. Runs every scene in order, recording browser, helper, terminal and HTTP steps. It stops at the first
   failure, a blocked or unknown helper result, a cancellation or `maxRunSeconds`, and always cleans up
   processes, the browser and helper output folders.
4. Runs structural QA, then the export check (unless `--calibration` is given): narration audible over
   digital silence and the export profile, with no browser audio, microphone or audio daemon. It then
   produces one narrated MP4 with WebVTT captions per audience. Ctrl-C and `maxRunSeconds` also stop
   the export check and every export; the stopped stage's partial output is removed.
5. Writes `demo-report.json` next to the run: plan hash, run status and failures, feature coverage
   (`observed`, `planned-not-observed` or `omitted` with its reason; an `observed` feature shown through a
   helper carries a `basis` saying what was checked and that it does not prove the app's reply belonged
   to the helper's action), QA, calibration, exports with their
   files and SHA-256, and a verdict.

Verdicts: `ready-for-human-review` (exit 0), `run-failed`, `qa-failed`, `calibration-failed`,
`export-failed` or `cancelled` (exit 1; `cancelled` says `during` `calibration` or `export` and `by`
`interrupt` or `time-limit`). Before anything runs, an invalid plan exits 1 (`invalid-plan`), and a start
that needs something exits 3: `confirmation-mismatch`, `estimate-over-limit`, `helpers-not-approved`,
`preflight-blocked` or `blocked` (a missing tool).
`ready-for-human-review` never means released: a person must watch and listen to each exact file.
