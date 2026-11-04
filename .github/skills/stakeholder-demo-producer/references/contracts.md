# Contracts

Eleven versioned JSON contracts live in `schemas/`. Each document names its contract in a `schema` field
(for example `"schema": "storyboard.v1"`); events carry `"schema": "event.v1"` per line.

- `demo-plan.v1`: the one document the human approves: narrator label, feature coverage, helpers, outside
  destinations, cost estimate and time limit, architecture-card switch, a full storyboard and the runtime
  (an authorization without its own hash fields). See [demo-plan.md](demo-plan.md).
- `capability-catalog.v1`: evidence (relative path + SHA-256), inventory, run commands, platforms,
  capabilities, components, edges, forbidden claims, unknowns, skipped items, target content digest.
- `storyboard.v1`: catalog hash, title, goal, audiences, confidentiality, data provenance, claims, scenes.
- `run-authorization.v1`: storyboard hash, subject, bindings, commands, network mode, HTTP requests, limits,
  stop conditions, browser service, run-local helper interactions, optional informational approval record.
- `preflight.v1`: contract hashes, checks, per-scene adapter support, verdict `ready` or `blocked`.
- `adapter-descriptor.v1`: what an adapter supports or why it is not implemented. The process and HTTP
  adapters export descriptors (`PROCESS_DESCRIPTOR`, `HTTP_DESCRIPTOR`) that are tested against this schema;
  limit names use the run-authorization `limits` keys.
- `event.v1`: one run event (sequence number, monotonic clock offset, producer, type, disposition).
- `artifact-manifest.v1`: run id, subject, status, contract hashes, artifacts with SHA-256 and size,
  transformations, failures, cleanup.
- `claim-ledger.v1`: per-claim verdict (`supported`, `unsupported`, `not-asserted`) with evidence links and
  the narration lines that cite the claim.
- `qa-report.v1`: checks, reviewer, verdict (`fail`, `blocked`, `structural-pass`, `release`) and limitations.
- `export-manifest.v1`: one `produce` export: bound run manifest, QA report, claim ledger and calibration
  hashes, export profile, contiguous segments (each with its hashed source and clip window), narration
  placement, output files with SHA-256, structural checks and a verdict that is never `release`. Exports
  with helper media also record each interaction clip's media, labels, provenance and timing source.

Validate any contract with `validate <file>`; give `--catalog`, `--storyboard` or `--manifest` to check
cross-document rules.

## Hash chain

JSON contracts are hashed as canonical JSON (keys sorted, compact), so formatting does not change a hash;
`hash <file>` prints it. Artifacts are hashed as raw bytes.

catalog → `storyboard.catalogSha256` → `authorization.storyboardSha256` → human confirmation of the
authorization hash (in the main workflow: of the demo plan hash, which fixes the catalog hash, the
storyboard and the derived authorization) → manifest (`catalogSha256`, `storyboardSha256`, `authorizationSha256`,
`targetContentSha256`) → `claimLedger.manifestSha256` → `qaReport.manifestSha256` and `claimLedgerSha256`.
Any edit after approval breaks the chain and must be re-approved.

## Paths

- Contract paths are relative, use `/`, and are checked for traversal (`..`), absolute POSIX or Windows forms,
  UNC prefixes, backslashes and control characters. Run files are resolved and checked for symlink escapes.
- Absolute host paths appear only in the authorization `bindings` (`targetRoot`, `runDir`, executables).
  Run outputs replace binding values with `<binding:id>` and record a `redact-bindings` transformation; a
  manifest containing a binding value is rejected.

## Validator scope

The bundled validator implements a restricted subset of JSON Schema: `type`, `properties`, `required`,
`additionalProperties`, `items`, `enum`, `const`, `pattern`, `minLength`, `maxLength`, `minimum`,
`maximum`, `minItems`, `maxItems`, `uniqueItems`, local `$ref` to `$defs`, plus the custom `x-sdp-path`
(relative, relative-dir, approved-absolute). Unsupported keywords are rejected when a schema is compiled,
not silently ignored. It is not a general JSON Schema implementation. Every object in the bundled schemas is
closed (`additionalProperties: false`), so unknown fields, such as API keys, are rejected.

Rules that JSON Schema cannot express (unique ids, reference resolution, claim classes, adapter/op
matching, origin rules, release requirements) are implemented in `scripts/lib/contracts.mjs` and run only
when the document's shape is valid.
