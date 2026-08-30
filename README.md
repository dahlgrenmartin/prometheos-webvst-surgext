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
| `CMakeLists.txt`, `cmake/` | The Emscripten build graph for the module |
| `src/` | The WebVST ABI v1 implementation over Surge's engine |
| `scripts/build.ts` | The deterministic build driver (Bun) |
| `vendor/surge` | Surge XT, pinned at `2644c613fb729cf2ce924c39dc75cf6a61ee9324` (GPL-3.0-or-later) |
| `vendor/webvst-sdk` | Prometheos WebVST SDK, pinned at `777b4077aee6d88aa66e0c07d328de7450b69458` (MIT) |
| `tests/` | Provenance and ABI-surface verification (`vitest`) |

## Working with the submodules

```sh
git submodule update --init vendor/webvst-sdk
git submodule update --init vendor/surge
```

Surge's own nested submodules are intentionally left uninitialized here.
`scripts/build.ts` initializes only the ones the JUCE-free `src/common` build
needs, and does so in a throwaway checkout, so `vendor/surge` stays pristine.

## Build

### Prerequisites

All five must be on `PATH`. The versions the published artifact was produced
with are recorded in `PROVENANCE.md` section 6.

| Tool | Notes |
|---|---|
| **Bun** | `scripts/build.ts` is a Bun script (`Bun.spawnSync`, `Bun.which`). Without it, `pnpm run build` fails immediately. |
| **Emscripten (emsdk)** | `em++` on `PATH`, or `EMSDK_EMSCRIPTEN_BIN` set. The build script finds the emsdk's own Python itself, so no `emsdk_env` activation is needed. |
| **CMake** | Configures the build graph. |
| **Ninja** | The generator CMake drives. |
| **git** | Materializes the pinned Surge checkout, initializes its submodules and applies the patches. |

Node.js and pnpm are needed only to run the tests.

### Building

```sh
pnpm install
pnpm run build      # == bun scripts/build.ts
```

This produces `build/surgext-webvst.wasm`. The first run clones Surge's
submodules over the network and compiles the whole engine, which takes several
minutes; later runs are incremental.

Intermediate build state (the Surge checkout and the object tree, together over
1 GB) is kept outside the repository, under the system temp directory. Set
`SURGEXT_WEBVST_WORK_DIR` to place it elsewhere, for example on a volume with
more room. Only the finished module is written into `build/`.

## Verify

```sh
pnpm install
pnpm test                                       # provenance + ABI surface
pnpm exec vitest run tests/provenance.test.ts   # provenance only
```

The ABI-surface suite needs `build/surgext-webvst.wasm`, so run the build
first; the provenance suite does not.

The WebVST SDK is currently an unpublished local repository referenced by a
relative path in `.gitmodules`; that URL must be updated to the public URL once
the SDK is published. The commit pin makes the dependency immutable regardless
of URL.
