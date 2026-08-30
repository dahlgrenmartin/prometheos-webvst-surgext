# Notices

## This package as a whole is GPLv3

This repository produces a distributable Surge XT `.webvst` package. Surge XT
is licensed under the **GNU General Public License, version 3 or later**
(GPL-3.0-or-later). The combined work distributed from this repository — the
Surge XT engine plus the thin C-ABI host that adapts it to the WebVST ABI — is
therefore conveyed under **GPLv3**. The full license text is in `LICENSE`.

The complete corresponding source is this repository together with its pinned
submodules; see `PROVENANCE.md` for the exact upstream commit, the three local
patches (with SHA-256), the toolchain versions, and the command sequence that
reproduces the build.

## Bundled and referenced components

### Surge XT — GPL-3.0-or-later

- Upstream: `https://github.com/surge-synthesizer/surge.git`
- Pinned commit: `2644c613fb729cf2ce924c39dc75cf6a61ee9324`
- Submodule path: `vendor/surge`
- Copyright 2018-2025 the Surge Synthesizer Team and contributors, as recorded
  in the upstream `AUTHORS` file and Git history.

### Prometheos WebVST SDK — MIT License

- Source: local relative path `../prometheos-vst3-wasm-sdk` (an unpublished
  local repository; the `.gitmodules` URL must be changed to the public URL
  once the SDK is published — immutability is guaranteed by the commit pin
  regardless of URL)
- Pinned commit: `777b4077aee6d88aa66e0c07d328de7450b69458`
- Submodule path: `vendor/webvst-sdk`
- The WebVST SDK is **MIT-licensed**. Its license notice is retained verbatim
  at `vendor/webvst-sdk/LICENSE` (MIT License, Copyright (c) 2026 Prometheos
  contributors), and its own `vendor/webvst-sdk/NOTICE.md` is retained
  unmodified in the submodule.
- Per that SDK `NOTICE.md`: the SDK fetches the Steinberg VST3 SDK root at
  immutable revision `3cdf9ca5d1f5b1b21e0a86832aa4abe55607bd96` (upstream
  `v3.8.1_build_84`) and only its `pluginterfaces` submodule at
  `4f547e8e102b47de4a8b8aaf343c73b700786372`; both are MIT-licensed by
  Steinberg Media Technologies GmbH, and their notices remain in the fetched
  source trees. The SDK does not fetch the `base`, `cmake`, `doc`,
  `public.sdk`, `tutorials`, or `vstgui4` submodules.

## Licensing interaction

The WebVST SDK's own files remain independently MIT-licensed and their MIT
notice is preserved as required by that license. When the MIT-licensed SDK
adapter is compiled and linked together with the GPL-3.0 Surge XT engine to
form the distributed `.webvst` package, the resulting combined work is covered
by GPLv3 as a whole. MIT permits this; GPLv3 requires it. No trademark claim is
made about the `.webvst` suffix; a naming/trademark review remains required
before any public release or tag.
