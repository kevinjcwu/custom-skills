# Runtime authority

Availability is not approval. A tool being installed, a preflight being ready or a port being open never
authorizes a run. Only the human's approval of an exact plan does.

In the main workflow the human approves the demo plan's summary in plain words
([demo-plan.md](demo-plan.md)); the agent then binds the run to that exact plan by its SHA-256. The plan's
`runtime` section plus its storyboard hash is the run authorization described below; `demo` derives it and
runs it, so approving the plan approves exactly that authorization. The `run` building block takes a
separate authorization and its own hash (gate G2 below).

## Run authorization

A `run-authorization.v1` document, bound to the approved storyboard hash, lists everything a run may do:

- `subject`: `target` (the repository itself) or `synthetic-fixture` (toolchain demonstration only; its
  actions never support target claims).
- `bindings`: the only absolute paths: `targetRoot`, `runDir` (must not contain or be inside the target)
  and approved `executables` by id.
- `commands`: id, executable id, literal `argv`, relative `cwd` inside the target, literal `env` values and
  `envPassthrough` names. No shell is used, so metacharacters stay literal. Nothing else from the parent
  environment is passed.
- `network`: `none`, `loopback` (only `127.0.0.1` or `[::1]`) or `allowlisted-origins`; HTTP `requests` with an exact
  origin (no user info, `http`/`https` only), method `GET`/`HEAD`/`POST`, path and headers. Authorization,
  cookie, host and hop-by-hop headers are refused. Header values may contain only tab and printable ASCII
  characters. Bodies are only for `POST`.
- `limits`: timeout, output and response caps, request size, kill grace period and retries.
- `workspace`: directories created fresh under `<run>/workspace`. Commands and the browser service refer to
  them only through the literal `{workspace}` token, so target outputs never modify `targetRoot`. A demo
  plan's approved helper files are copied into `<run>/workspace/helpers/` before anything starts.
- `browser` (for browser scenes): one target `service` (approved executable, literal argv, cwd, env and a
  readiness timeout) that must print a JSON line `{"ready": true, "origin": "http://127.0.0.1:<port>"}`
  from a socket it owns, and `settleMs` after each action. The browser loads only that origin and needs
  `network: loopback`. If the app's own server prints something else, use a small approved helper that
  starts it and prints the ready line, rather than changing the repository. The socket may belong to the
  started process or to a process it started (the wrapper's child server), as long as that process stays
  in the service's process group so cleanup can stop it; a `pid` in the ready line, if given, must be one
  of those processes. A process that left the group is stopped by the run and the start-up fails. After
  readiness the run keeps checking the service's process tree (every 100 ms) until teardown: a process
  that leaves the group later (for example a worker started on a request) is tracked by exact pid
  identity, stopped at cleanup (`service descendant <pid>`), and fails the run (`service-escaped`). A
  process that detaches and whose parent exits between two checks cannot be traced to the service; that
  limit is not a sandbox guarantee.
- `interactions` (for `helper` actions): run-local helpers the agent wrote for this app, each with an
  approved executable, literal argv, cwd, an explicit environment, optional access to this run's
  recorded page through declared page scripts, and the media roles it may report with their provenance
  ([run-local-helpers.md](run-local-helpers.md)). They run with the action time limit, output cap,
  cancellation and process-group cleanup; a descendant that left the group is stopped and fails the
  action. They are never retried.
- Cancellation (Ctrl-C or the plan's time limit) also ends a service start-up wait, a browser page action
  or a helper that is still running; an action that finishes after cancellation is recorded as
  `cancelled`, never as a success.
- The whole run is also bounded by the demo plan's `estimate.maxRunSeconds`: when it is reached the run is
  cancelled and cleaned up like a Ctrl-C. That limit and Ctrl-C also cover the export check and every
  audience's export: their tools are stopped and the stage's partial output is removed.
- A browser service that writes more than `maxOutputBytes` stops the run as `limit-exceeded`; its logs
  are kept only up to that limit and the run is never reported as completed.
- `stopConditions`: `first-failure`, `cancellation` and `limit-exceeded` (all three are required).

An `approvalRecord` is informational. It is not authentication and never enables a run.

## Confirmation (gate G2)

1. `preflight` (passive): contracts, hash chain, target content digest, cwd, run directory, executable bits
   and adapter support. It never spawns a process, opens a port or contacts an origin.
2. Show the human the authorization and the output of `hash authorization.json`.
3. Run with `--confirm-authorization-sha256 <that hash>`. A missing or malformed value is a usage error
   (exit 2); a different value is refused (exit 1); a blocked preflight is refused (exit 3).

The hash only proves the caller confirmed that exact authorization content. It is not authentication and
not a sandbox: approved commands and run-local helpers run with the user's own permissions and their
network access is not restricted (only the recorded browser is limited to loopback). A helper's
`SDP_OUT_DIR` is where it is told to write, not a filesystem boundary.

## Early browser feasibility

`sdp feasibility --plan <file> --catalog <file> --confirm-plan-sha256 <hash>` reuses the same exact
`demo-plan.v1` approval as `sdp demo`; it does not introduce another approval record or hash contract.
The first browser scene is the essential feasibility scene. It must have 1-5 fixed browser actions
(`goto`, `click`, `fill`, `press` or `wait`); interaction helpers and other adapters are rejected before
launch. The full catalog, storyboard, target content, derived authorization, executable, loopback
service ownership and evidence checks remain in force. Only that scene is executed, every other scene
is explicitly recorded as skipped, and each action gets one attempt even if the full approved run
allows retries.

The attempt deadline is the lesser of 180 seconds and the approved `estimate.maxRunSeconds`; the
service readiness and browser action limits still apply. The result distinguishes unsupported
interactions, missing prerequisites, timeout, completed actions whose approved expectation failed
(`product-error`), cancellation, authority-boundary failures and other run failures. It never presents
a failed or skipped scene as observed, and a pass is feasibility evidence only, not a narrated export.
The full `demo` command must still produce its own complete run under the same approved plan before
exporting.

## During a run

- Scenes run in order. The first failed action, a cancellation (Ctrl-C) or an exceeded limit stops the run;
  remaining actions are recorded as skipped.
- An action passes only when it meets every expectation. A process must also exit 0 unless the scene sets
  an explicit `exitCode` expectation, and an HTTP response must be 2xx unless the scene sets an explicit
  `status` expectation (`expect.result` ids `implicit.exit-zero` and `implicit.status-2xx`). An empty
  `expect` list therefore never turns a failed command into a success.
- Cited catalog evidence is re-read and re-hashed at run start; a mismatch stops the run with
  `evidence-mismatch`.
- If an adapter throws, the attempt is recorded as `adapter-error` with a `failed` cleanup record. Any other
  unexpected error is recorded as `internal-error`. Either way the run ends `failed` and still writes its
  cleanup records, `run.end` and the manifest.
- Retries apply only when a completed attempt fails its expectations. Spawn errors, refused requests,
  redirects (never followed), timeouts, caps and cancellations are not retried.
- Processes get `SIGTERM`, then `SIGKILL` after the grace period; the whole process group is killed on exit.
- HTTP uses no connection pooling; every socket is closed after its request.

## Cleanup

Every process attempt, request and the event log has a cleanup record in the manifest. Runs are written once
under `<runDir>/<runId>/` and are never overwritten. Delete old runs yourself only when the human agrees.
