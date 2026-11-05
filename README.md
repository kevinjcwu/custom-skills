# Custom Skills

Reusable agent skills for turning real software into honest, evidence-backed product demos.

The first skill, **Stakeholder Demo Producer**, helps an agent inspect a repository, propose a
walkthrough, record the running application and deliver a narrated video with captions and provenance.
It shows what the product actually does, rather than inventing responses or treating a slide deck as
product evidence.

**Status: experimental.** The skill includes working commands, tests and reusable browser/media
utilities, but a new application can still require an approved, app-specific integration. It is not a
universal one-command demo generator.

## What's included

| Skill | Purpose |
|---|---|
| [Stakeholder Demo Producer](.github/skills/stakeholder-demo-producer/SKILL.md) | Repository discovery, an approved showcase, real interactions, narration, captions, recording, export and evidence-backed review. |

Depending on the approved workflow, a delivery includes H.264/AAC MP4 video, WebVTT captions, original
captures, coverage/omission notes and run records with artifact hashes. A structural check is not a
claim that the final video is good: a person must watch and listen to the exact file.

## Getting started

### Use the skill with an agent

Clone this repository:

```sh
git clone https://github.com/kevinjcwu/custom-skills.git
cd custom-skills
```

Give an agent that supports `SKILL.md` instructions access to the
[skill folder](.github/skills/stakeholder-demo-producer) and your authorized target repository.
This repository uses the project-local `.github/skills/` layout. To use it in another project,
copy the complete `stakeholder-demo-producer` folder from a fresh checkout into that project's
supported skills directory, including its license and third-party notices. Do not copy installed
`.runtime/` directories or past `.runs/` outputs from a used checkout.

An example request:

```text
Use stakeholder-demo-producer to inspect this repository and propose a short
product walkthrough for a non-technical audience.

Start with discovery and a showcase plan. Do not change the application,
install tools, record, use paid services or publish anything without approval.
Identify confidential information and any app-specific integration needed.
```

The agent still needs its host's normal permissions to read files, run commands and control a browser.
Installing this skill does not grant those permissions or provide an agent runtime.

### Try passive discovery

The core CLI needs **Node.js 24** and uses Node built-ins; there is no root `npm install` step.
From the repository root:

```sh
cd .github/skills/stakeholder-demo-producer
mkdir -p .runs/readme-example
node scripts/sdp.mjs discover \
  --root fixtures/inventory-recon \
  --out .runs/readme-example/catalog.json
```

This inspects the bundled fictional inventory fixture without starting its application or recording a
demo. A generated catalog is a starting point for investigation, not exhaustive feature discovery.
See the [fixture README](.github/skills/stakeholder-demo-producer/fixtures/inventory-recon/README.md)
for its own commands.

### Prepare browser, narration and export tools

The media toolchain is verified only on **Ubuntu 22.04, Linux x64**. Other platforms are reported as
blocked rather than assumed to work. Setup also needs an available **Python 3.12**, **uv** and
**dpkg-deb**; it does not download a Python interpreter.

From the skill folder:

```sh
node scripts/sdp.mjs setup check

# Only after authorizing the tool downloads:
node scripts/sdp.mjs setup install
node scripts/sdp.mjs setup check
```

A fresh checkout can return exit code `3` from `setup check` because tools are not installed yet.
Installation downloads the locked browser/media tools, Python packages, voice model and required
shared libraries into the skill-local `.runtime/`; it does not install system packages globally.
Narration then runs locally with Piper. The skill itself needs no cloud speech subscription or API key,
although a target application may require its own authorized services, credentials and spending.

Most downloads have recorded content identities. Chromium is version-selected by Playwright, but its
executable hash is recorded on first installation and checked subsequently: **trust on first use**,
not an independently preverified browser download.

## How a demo is produced

1. **Discover:** inspect actual source, tests, startup and user-visible behavior.
2. **Agree:** propose the audience, story, shown/omitted features, confidentiality, integrations,
   external services and execution limits.
3. **Approve:** obtain permission for the specific preparation and production scope.
4. **Record:** exercise the real application using the existing CLI adapters or a bounded,
   approved per-demo driver.
5. **Verify and deliver:** preserve originals and failures, check the exact export, report limitations
   and obtain human watch/listen review. Nothing is published automatically.

The existing `sdp` workflow supports process, HTTP and fixed browser interactions. When an essential
interaction does not fit those contracts, an agent can compose the existing utilities into an
app-specific driver. That driver is not a new generic capability or a sandbox.

Voice applications can use generated audio input and continuous browser-output capture primitives.
They still need application-specific handling for controls, transcripts, turn attribution,
interruptions and media tools. Generated participant audio is labelled; it is not a physical microphone
test or a replacement for the application's own response.

## Documentation

| Guide | Covers |
|---|---|
| [Skill instructions and CLI](.github/skills/stakeholder-demo-producer/SKILL.md) | Commands, approval flow, claim rules and stop conditions. |
| [Repository-to-demo workflow](.github/skills/stakeholder-demo-producer/references/repository-workflow.md) | Bounded agent-generated integrations and exact recording scope. |
| [Platform support](.github/skills/stakeholder-demo-producer/references/platform-support.md) | Implemented capabilities and explicit unsupported cases. |
| [Voice integration](.github/skills/stakeholder-demo-producer/references/voice-integration.md) | Reusable voice primitives and responsibilities left to each adapter. |
| [Evidence and QA](.github/skills/stakeholder-demo-producer/references/evidence-and-qa.md) | Run records, structural checks and evidence limitations. |
| [Storytelling](.github/skills/stakeholder-demo-producer/references/storytelling.md) | Audience-focused narrative and honest coverage. |

## Safety and limitations

- Run only against repositories, services and data you are authorized to use. Commands and generated
  helpers have their process's permissions; there is **no filesystem or process-network sandbox**.
- Review the recording scope before capture. Screens, transcripts, originals and logs can contain
  sensitive data. Use fictional fixtures where possible and keep `.runtime/`, `.runs/`, credentials
  and private recordings out of commits, archives and public releases.
- The static helper is for an intentionally public asset directory, not an entire private checkout.
  Use its exact printed `127.0.0.1:<port>` origin; other Host authorities are rejected.
- Automated checks do not prove physical audio, provider-side causality, synchronization throughout
  a video, complete feature coverage or accessibility. Disclose what was actually observed.
- Native Windows/macOS, desktop/mobile capture and a universal conversational caller are not supplied.
  A successful demo on one application does not establish support for every repository.

## Development

From the skill folder, run the ordinary suite without installing media tools:

```sh
node --test tests/*.test.mjs
```

Browser/media cases skip when no runtime is supplied. After approved setup, include the offline
browser/media fixtures with:

```sh
SDP_RUNTIME_DIR="$PWD/.runtime" SDP_FIXTURE_PRODUCTION=approved \
  node --test tests/*.test.mjs
```

These are synthetic local fixtures, not live cloud or physical-audio acceptance tests.

Contributions should stay focused, include tests for changed behavior, preserve approval and cleanup
boundaries, and distinguish implemented features from proposals. Bug reports should include platform,
reproduction steps and redacted diagnostics, not credentials or private recordings. For vulnerabilities,
use GitHub private vulnerability reporting when available; do not post exploit details or secrets in
public issues.

## License

Repository-authored code and documentation are available under the [MIT License](LICENSE).
The portable skill includes its own [license copy](.github/skills/stakeholder-demo-producer/LICENSE).
Downloaded tools, voices and their dependencies retain their own licenses; see
[third-party notices](.github/skills/stakeholder-demo-producer/THIRD_PARTY_NOTICES.md) before
redistributing a runtime, container, model or other bundled artifact.
