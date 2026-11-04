# inventory-recon

Synthetic demo fixture: reconciles an expected stock ledger against
physical counts and shows the variances in a small read-only web viewer.
All data in `data/` is invented; the numbers describe nothing real.

## Command line

```sh
node bin/recon.mjs --ledger data/ledger.csv --counts data/counts.csv --out reports/today.json
```

Exit codes:

| Code | Meaning |
|------|---------|
| 0 | Reconciled; report written (never overwrites an existing file) |
| 2 | Invalid input: usage error, or malformed CSV reported as `file:line:column: message`; no report is written |
| 1 | Unexpected internal error |

Each SKU is classified as `match`, `short`, `over`, `not-counted` or
`unexpected`. Report ids are derived from the input content, so the same
inputs always produce the same report.

## Viewer

```sh
node src/server.mjs --reports reports
```

Binds `127.0.0.1` on a free port and prints one JSON readiness line with
its origin. Read-only routes: `GET /`, `GET /api/reports`,
`GET /api/reports/<id>`. Requests with a non-loopback `Host` are refused.

## Architecture

`bin/recon.mjs` → `src/csv.mjs` (RFC 4180 subset parser with line and
column diagnostics) → `src/reconcile.mjs` (per-SKU variance) → JSON report
file → `src/server.mjs` (report API) → `public/index.html` (viewer).

## Tests

```sh
node --test "test/*.test.mjs"
```
