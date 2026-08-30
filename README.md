# prometheos-webvst-surgext

Surge XT, packaged as a separately distributed **GPLv3** `.webvst` package for
the Prometheos WebVST runtime.

This repository is the GPL boundary for the Surge XT engine: it carries the
pinned upstream source, the small set of build-portability patches, and the
build recipe, so the engine is always conveyed with its complete corresponding
source. It is a **standalone repository** — not a submodule of any other
Prometheos repo.

## Layout

| Path | What |
|---|---|
| `LICENSE` | GNU GPL v3 — the license of the distributed package |
| `NOTICE.md` | Component licenses and the GPL/MIT interaction |
| `PROVENANCE.md` | Machine-checkable provenance: pins, patches, SHA-256, toolchain, build steps |
| `patches/` | The three Emscripten build-portability patches applied to Surge |
| `vendor/surge` | Surge XT, pinned at `2644c613fb729cf2ce924c39dc75cf6a61ee9324` (GPL-3.0-or-later) |
| `vendor/webvst-sdk` | Prometheos WebVST SDK, pinned at `777b4077aee6d88aa66e0c07d328de7450b69458` (MIT) |
| `tests/` | Provenance verification (`vitest`) |

## Working with the submodules

```sh
git submodule update --init vendor/webvst-sdk
git submodule update --init vendor/surge
```

Surge's own nested submodules are intentionally left uninitialized; a later
task initializes only the ones the JUCE-free `src/common` build needs.

## Verify provenance

```sh
pnpm install
pnpm exec vitest run tests/provenance.test.ts
```

The WebVST SDK is currently an unpublished local repository referenced by a
relative path in `.gitmodules`; that URL must be updated to the public URL once
the SDK is published. The commit pin makes the dependency immutable regardless
of URL.
