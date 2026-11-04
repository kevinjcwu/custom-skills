# Discovery

Goal: learn what the target repository can actually do before anyone writes a story. Discovery has two
halves, and they must stay distinguishable in the catalog.

## What the helper does (passive inventory)

`node scripts/sdp.mjs discover --root <target>` walks the target without executing anything and without
invoking version control. It:

- records each readable file as evidence with a relative path and the SHA-256 of its bytes;
- finds manifests (for example `package.json`), declared run scripts (recorded with `executed: false`,
  never run), `bin`/`main` entry points, HTML pages, shebang CLI candidates, server candidates, test titles,
  documentation headings and the key names (never the values) of config example files;
- derives platform hints from a fixed signal table (class `inferred`, with a reason) and capabilities only
  from entry points (class `fact`, provenance `inventory`);
- emits default `forbiddenClaims` (unevidenced metrics, absolute quality) and `unknowns` (audience,
  confidentiality, execution authority, and tests when none were found);
- produces a content digest of all inventoried files, later used to detect target changes.

Deny rules: it never reads `.env` files (except `.env.example`, `.env.sample`, `.env.template`), keys,
certificates, credential files, package-manager auth files, version-control internals, dependency
directories, SSH/GPG/cloud-CLI configuration directories, or anything matched by the repository's
`.gitignore` files (a documented subset: comments, negation, anchoring, `*`, `**`, `?`, and character
classes with literal characters, `a-z` ranges and `!`/`^` negation). Discovery fails closed: a `.gitignore`
it cannot apply exactly (POSIX classes such as `[[:digit:]]`, reversed ranges, unclosed classes, a trailing
backslash, invalid UTF-8), one that is unreadable or not a regular file, or one larger than the per-file limit stops
discovery with `gitignore-unsupported`, `gitignore-unreadable` or `gitignore-too-large` (exit 1) and names the
file; nothing is exported. Simplify the rule or raise `--max-file-bytes` and run again.
Like Git, it skips a leading UTF-8 byte-order mark, accepts CRLF line endings, and trims only unescaped
trailing spaces (tabs and other whitespace stay part of the pattern).
Build output is excluded only when `.gitignore` excludes it. Symlinks are recorded and never followed. Names with
control characters or backslashes are counted, not listed. File count, per-file size and total size are
bounded; skipped items are recorded with a reason. Git is never invoked, so global excludes and
`.git/info/exclude` are not seen; the fixed deny rules still apply.

## What you do (reading and inference)

Read the evidence the helper listed: entry points, source, tests, docs. Then extend the catalog:

- capabilities, with `class` and `evidence` ids (or a `reason` when inferred or unknown). Set
  `userVisible: true` on everything a user can see or do; the demo plan must show each of those or say
  why it is left out;
- components and edges of the main code path, marked `inferred` unless a run will exercise them;
- complete user workflows, not isolated functions: what a person starts with, does and gets.

Evidence classes:

- `fact`: directly present in the inventory (a file, a declared entry point).
- `source-backed`: you read the code that does it; cite the source evidence.
- `documented`: the project's own docs say it; cite the doc evidence.
- `observed`: a run in this workflow demonstrated it (only after a run).
- `inferred`: plausible from structure; never narrated as true.
- `unknown`: you could not tell; list it in `unknowns`.

Also work out how the app is started on this machine (its own start script or server, which port it
announces, which environment variables it reads, whether it signs in to a cloud service), which outside
services it calls, and which user interactions the browser, terminal and HTTP adapters cannot perform
(for example speaking to the app, or a device or file the page waits for). For each such gap, find out
how the app receives that input and how you could tell that its response belongs to it; that is what a
run-local helper will need ([run-local-helpers.md](run-local-helpers.md)).

## When to ask

Ask the human only what the repository cannot tell you: the audience (business, engineering or both),
business context, confidentiality of anything on screen, which features matter most or may be left out,
how the app is started here (including any sign-in they need to do themselves) and whether paid services
may be used. Never ask them for a feature list; discovering features is your job. Validate the extended
catalog with `validate catalog.json` before writing the demo plan ([demo-plan.md](demo-plan.md)).
