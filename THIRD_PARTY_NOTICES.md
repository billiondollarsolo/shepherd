# Third-party notices

Flock is distributed under the MIT License. It also bundles or loads the
following third-party assets under their own licenses.

## Agent command-line tools

The production orchestrator image includes the current releases available at build
time of:

- [OpenAI Codex CLI](https://github.com/openai/codex), copyright 2025 OpenAI and
  licensed under Apache-2.0. The orchestrator image includes the Apache-2.0 text at
  `/usr/share/common-licenses/Apache-2.0`.
- [OpenCode](https://github.com/anomalyco/opencode), copyright 2025 opencode and
  licensed under the MIT License:

  > Permission is hereby granted, free of charge, to any person obtaining a copy of
  > this software and associated documentation files (the "Software"), to deal in
  > the Software without restriction, including without limitation the rights to
  > use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
  > the Software, and to permit persons to whom the Software is furnished to do so,
  > subject to the following conditions: The above copyright notice and this
  > permission notice shall be included in all copies or substantial portions of
  > the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
  > EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
  > MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO
  > EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR
  > OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
  > FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
  > THE SOFTWARE.

On first container start, Flock runs Anthropic's official installer to download the
latest Claude Code directly to the user's container. Flock does not redistribute the
Claude Code binary. Claude Code remains subject to Anthropic's applicable commercial
or consumer terms and is not covered by Flock's MIT License.

## Runtime libraries

Production JavaScript dependencies retain their upstream license files. Notably,
`web-push` is distributed under the Mozilla Public License 2.0. A generated dependency
SBOM accompanies release container images.

## JetBrains Mono Nerd Font Mono

The terminal includes patched JetBrains Mono webfonts from Nerd Fonts v3.4.0.
JetBrains Mono is copyright the JetBrains Mono Project Authors and licensed
under the SIL Open Font License 1.1. Nerd Fonts adds glyphs from several
upstream icon projects; their license inventory is maintained in the
[Nerd Fonts license audit](https://github.com/ryanoasis/nerd-fonts/blob/master/license-audit.md).

Sources:

- https://github.com/JetBrains/JetBrainsMono
- https://github.com/ryanoasis/nerd-fonts

## Noto Sans Symbols 2

Copyright 2022 The Noto Project Authors. Licensed under the SIL Open Font
License 1.1.

Source: https://github.com/notofonts/symbols

The SIL Open Font License text shipped with these fonts is included at
[`apps/web/src/styles/fonts/OFL.txt`](apps/web/src/styles/fonts/OFL.txt).
