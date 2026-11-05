# Third-party tools and notices

The [MIT License](LICENSE) covers repository-authored skill code and documentation, not the
independently downloaded tools, models or dependencies listed below. Keep this file and the license
when copying the portable skill.

This is a source-only distribution. Installed `.runtime/` files, generated `.runs/` outputs and
`.test-runs/` scratch data are not included. Setup downloads tools from their upstream distributors;
this repository does not supply a bundled runtime or a complete binary-redistribution compliance kit.

## Runtime inventory

Exact versions, download locations, content identities and declared terms are recorded in
[tool-lock.json](runtime/tool-lock.json), [package-lock.json](runtime/package-lock.json) and
[piper-requirements.txt](runtime/piper-requirements.txt). The following summarizes the main components;
it is not a substitute for their actual licenses and bundled notices.

| Component | Upstream / declared terms |
|---|---|
| Playwright Core | [Microsoft Playwright](https://github.com/microsoft/playwright), Apache-2.0. |
| Chromium | Downloaded by Playwright; BSD-style licensing plus bundled third-party licenses and notices. |
| `ffmpeg-static` and selected Linux FFmpeg binary | [ffmpeg-static](https://github.com/eugeneware/ffmpeg-static); the selected static build is GPL-3.0. The package and individual binary have their own licensing/build records. |
| FFprobe | `@ffprobe-installer/ffprobe` wrapper declares LGPL-2.1; the selected `@ffprobe-installer/linux-x64` binary declares GPL-3.0. Do not assume the wrapper's license covers its binary. |
| Piper TTS | [Open Home Foundation Piper](https://github.com/OHF-Voice/piper1-gpl); the pinned `piper-tts` 1.8.0 release declares GPL-3.0-or-later and includes espeak-ng components/data. |
| `en_US-ljspeech-high` voice | The pinned [Piper voices repository](https://huggingface.co/rhasspy/piper-voices/blob/5041a7a49ae5b3a0f30e6837769eb03fdbb231bd/README.md) declares MIT. Its [model card](https://huggingface.co/rhasspy/piper-voices/blob/5041a7a49ae5b3a0f30e6837769eb03fdbb231bd/en/en_US/ljspeech/high/MODEL_CARD) identifies the LJ Speech dataset as public domain. |
| Python dependencies | ONNX Runtime: MIT; NumPy and protobuf: BSD-3-Clause; FlatBuffers: Apache-2.0; packaging: Apache-2.0 OR BSD-2-Clause; pathvalidate: MIT. Consult each installed distribution's complete notices. |
| Ubuntu shared libraries | NSS/NSPR: MPL-2.0; ALSA libraries/data: LGPL-2.1-or-later, as recorded in the lock. Extracted package copyright/license files retain the authoritative details. |
| Other npm dependencies | Individual terms are recorded in the npm lock and installed packages; they are not relicensed by this project. |

The [LJ Speech publisher](https://keithito.com/LJ-Speech-Dataset/) describes its text and recordings as
public domain in the US. Dataset, model, voice/personality and output-use questions are distinct;
do not generalize this statement to other voices or every jurisdiction.

## Using tools versus redistributing them

The skill invokes external tools as separate processes. This does not by itself establish that every
program involved is one combined work, or that generated videos inherit a tool's license. The
[GNU GPL FAQ](https://www.gnu.org/licenses/gpl-faq.html#MereAggregation) explains that both the
communication mechanism and its semantics matter. Its
[output guidance](https://www.gnu.org/licenses/gpl-faq.html#WhatCaseIsOutputGPL) also distinguishes
ordinary generated output from copying covered artwork, audio or other material.

If you redistribute installed tools, model files, a container or an archive containing them, review
the exact components and retain applicable copyright notices and licenses. GPL/LGPL obligations may
include corresponding source, source-delivery arrangements and other conditions. A notice file or
an upstream link alone is not proof that those obligations have been satisfied.

Use the upstream FFmpeg license/build records downloaded by setup, Piper's installed license files,
the selected voice's model card and the browser's bundled notices. Changing a version, build or voice
requires checking its terms again. This document does not provide legal clearance, patent clearance
or rights to publish a target application's code, data, screenshots or audio.

## Download verification

The lock records npm/Python package identities and identities for downloaded media tools, voice files
and Ubuntu packages. Chromium is selected by a pinned Playwright version, but its executable hash is
recorded on first installation and verified on subsequent checks. That browser bootstrap is
**trust on first use**, not a pre-download checksum guarantee.
