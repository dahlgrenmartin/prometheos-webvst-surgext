# Provenance

This repository builds **Surge XT** into a separately distributed, GPLv3
`.webvst` package. It exists so the GPL-licensed synthesis engine is conveyed
with its complete corresponding source, independent of any consumer.

Everything below is machine-checked by `tests/provenance.test.ts`.

---

## 1. Pinned sources

| Component | Path | Upstream | Pinned commit | License |
|---|---|---|---|---|
| Surge XT | `vendor/surge` | `https://github.com/surge-synthesizer/surge.git` | `2644c613fb729cf2ce924c39dc75cf6a61ee9324` | GPL-3.0-or-later |
| Prometheos WebVST SDK | `vendor/webvst-sdk` | local relative path `../prometheos-vst3-wasm-sdk` | `777b4077aee6d88aa66e0c07d328de7450b69458` | MIT |

Both are Git submodules. Neither entry in `.gitmodules` carries a `branch =`
key: each is pinned to an immutable commit, never a moving ref. Surge's own
nested submodules (JUCE, LuaJIT, clap-juce-extensions, MTS-ESP, pybind11,
melatonin_inspector, and the rest) are deliberately **not** initialized here;
a later task initializes only the ~15 that `src/common` actually needs.

### The WebVST SDK is an unpublished local repository

The WebVST SDK is currently an unpublished local repository, pinned by immutable commit; the `.gitmodules` URL is a local relative path and must be updated to the public URL when the SDK is published. Immutability is guaranteed by the commit pin regardless of URL.

The SDK commit `777b4077aee6d88aa66e0c07d328de7450b69458` is the completed
ABI-v1 state (ABI string `prometheos-vst3-wasm-1`). The SDK has no tags; this
commit *is* the release. Its public ABI header is
`vendor/webvst-sdk/include/prometheos/webvst.h`. The SDK is MIT-licensed
(`vendor/webvst-sdk/LICENSE`); its own `NOTICE.md` records the Steinberg VST3
SDK source pin it references and is retained verbatim in the submodule. See
this repository's `NOTICE.md`.

---

## 2. Origin

This tree supersedes and expands the provenance narrative that previously lived
at `apps/buzz-remote/native/surgext` in the Prometheos apps repository (the
built-in Surge integration in Buzz-Web). The Surge commit pinned there and the
three patches carried there are reproduced here byte-for-byte:

- old location: `apps/buzz-remote/native/surgext/PROVENANCE.md`,
  `apps/buzz-remote/native/surgext/patches/`
- old Surge pin: `2644c613fb729cf2ce924c39dc75cf6a61ee9324` (unchanged)
- the deterministic build script there was
  `apps/buzz-remote/scripts/generate-surgext.ts`; its `PATCHES` array is the
  authority for the apply order and working directory of each patch, restated
  in section 5 below.

A later task removes the built-in Surge integration from Buzz entirely; this
package becomes the single source of the engine.

---

## 3. Build approach

Surge XT ships an upstream-supported, JUCE-free build mode:
`SURGE_SKIP_JUCE_FOR_RACK` (the flag backing the VCV Rack port) skips
`add_subdirectory(JUCE)` and the JUCE-hosted targets (`surge-testrunner`,
`surge-fx`, `surge-xt`) while still building `src/common`
(`surge::surge-common` alias), `src/lua` (a Lua-prelude-to-C++-string embed
with no interpreter) and `src/platform` unconditionally. None of
`src/common`'s `.cpp`/`.h` files include a JUCE header; `surge-juce` as linked
there is an `INTERFACE` library carrying only preprocessor defines, not real
JUCE.

The package build `add_subdirectory()`s the pinned checkout with
`SURGE_SKIP_JUCE_FOR_RACK`, `SURGE_SKIP_LUA` (LuaJIT has no WASM/DynASM
backend), `SURGE_SKIP_ODDSOUND_MTS`, and every JUCE-hosted `SURGE_BUILD_*`
target forced off, then links a narrow C-ABI host executable against
`surge::surge-common` and compiles the result to a standalone WebAssembly
module with Emscripten. There is no VST3/CLAP wrapper hosting: only Surge XT's
DSP engine is compiled.

This is a direct source-engine → Emscripten WASM integration. Patches may
remove GUI/plugin-wrapper build dependencies or add an Emscripten/headless
build entry point, but must not change synthesis behavior merely to simplify
the port. All three patches below are build-time portability fixes; none
changes a sample of output.

---

## 4. Local patches

Applied on top of the Surge pin. Each is present verbatim under `patches/`.

### `patches/0001-emscripten-build-portability.patch`

- **Applies at:** the main Surge checkout root (`vendor/surge`).
- **Upstream files:** `src/common/CMakeLists.txt`, `src/common/dsp/SurgeVoice.cpp`.
- **SHA-256:** `d000131f6825b819222a82f933c1bc7bb66e7346890a139e5fbe4bffdb729f7c`
- **Purpose:**
  - `src/common/CMakeLists.txt`: `${CMAKE_SOURCE_DIR}/libs/r8brain-free-src`
    → `${SURGE_SOURCE_DIR}/...` for the r8brain source/include paths.
    `CMAKE_SOURCE_DIR` is the outermost CMake project's root; Surge assumes it
    *is* that root, which is only true as the top-level project, not when
    `add_subdirectory()`'d into a wrapper. `SURGE_SOURCE_DIR` is Surge's own
    correctly-scoped variable, already used everywhere else in this file.
  - `src/common/CMakeLists.txt`: the non-`SKBUILD` Linux link branch adds
    `-Wl,--no-undefined`, a GNU-ld-only flag `wasm-ld` rejects outright. The
    existing `SKBUILD` bypass is extended to `SKBUILD OR EMSCRIPTEN` so
    Emscripten takes the same skip path.
  - `src/common/dsp/SurgeVoice.cpp`: one call site (`channelKeyEquivalent`,
    computing `MTS_GetMapSize(...)`) is missing the
    `#ifndef SURGE_SKIP_ODDSOUND_MTS` guard every other MTS call site in this
    file already has — an upstream gap in a rarely-built configuration. The
    matching guard is added; behavior with MTS enabled is unchanged, and
    `oddsound_mts_active_as_client` can never be true when MTS is skipped.

### `patches/0002-sst-plugininfra-emscripten-stacktrace.patch`

- **Applies at:** the `libs/sst/sst-plugininfra` submodule inside the Surge
  checkout (`vendor/surge/libs/sst/sst-plugininfra`).
- **Upstream files:** `src/misc_linux.cpp`.
- **SHA-256:** `b496512a6dd85c4c4695d7a164fe2feac7c873d2d4b417c526b954f58993b577`
- **Purpose:** the Linux branch (`UNIX AND NOT APPLE`) unconditionally builds
  `misc_linux.cpp`, which `#include`s glibc's `<execinfo.h>` for a diagnostic
  `stackTraceToString()` helper — unrelated to synthesis, used only for crash
  logs. Emscripten reports as `UNIX` but has no `execinfo.h`; the include is
  guarded and `stackTraceToString()` gets an `__EMSCRIPTEN__` fallback that
  returns a placeholder string instead of walking a real stack.

### `patches/0003-sst-plugininfra-emscripten-shared-library-path.patch`

- **Applies at:** the `libs/sst/sst-plugininfra` submodule inside the Surge
  checkout (`vendor/surge/libs/sst/sst-plugininfra`).
- **Upstream files:** `src/paths_linux.cpp`.
- **SHA-256:** `aabe251d83277ce6e60c4f48ba7e45551f54543ec6c5a4a481fba859d5ae8e3b`
- **Purpose:** `sharedLibraryBinaryPath()` calls `dladdr(3)` to find where the
  running shared object is installed (used only to probe for a portable data
  folder next to it) and throws when that fails. There is no dynamic linker in
  a standalone wasm module, so `dladdr` always fails; the throw was the
  proximate cause of the `sx_create()` abort described in section 7. Guarded
  with `__EMSCRIPTEN__` to return a fixed placeholder path instead — the
  downstream portable-folder probe then correctly finds nothing, matching a
  real machine with no portable install.

---

## 5. Applying the patches

The apply order and the working directory of each patch are taken verbatim
from the `PATCHES` array in `apps/buzz-remote/scripts/generate-surgext.ts`
(patch 0001 at the Surge root; 0002 and 0003 inside the
`libs/sst/sst-plugininfra` submodule). From the repository root, with the
Surge submodule checked out at the pin and its `libs/sst/sst-plugininfra`
nested submodule initialized:

```sh
git -C vendor/surge apply "$PWD/patches/0001-emscripten-build-portability.patch"
git -C vendor/surge/libs/sst/sst-plugininfra apply "$PWD/patches/0002-sst-plugininfra-emscripten-stacktrace.patch"
git -C vendor/surge/libs/sst/sst-plugininfra apply "$PWD/patches/0003-sst-plugininfra-emscripten-shared-library-path.patch"
```

Each apply can be made idempotent by first running
`git apply --reverse --check <patch>` in the same directory and skipping the
apply when it succeeds (the patch is already present). This mirrors what
`generate-surgext.ts` does.

---

## 6. Toolchain

Complete build prerequisites, with the versions that produced the artifact
whose provenance this file records. GPL-3.0 section 6 requires the build
scripts, the toolchain used, and installation information to be conveyed with
the binary, so this table is the toolchain record, not a summary.

| Tool | Version | Why it is required |
|---|---|---|
| Emscripten (emsdk) | `4.0.10` | Compiles and links the WebAssembly module (`em++`, and the CMake toolchain file `cmake/Modules/Platform/Emscripten.cmake`). |
| CMake | `3.31.0` | Configures the build graph (`CMakeLists.txt`, `cmake/SurgeWebVst.cmake`). |
| Ninja | `1.13.2` | The generator CMake drives. |
| Bun | `1.2.16` | Runs `scripts/build.ts`, which uses `Bun.spawnSync` / `Bun.which`. `pnpm run build` is `bun scripts/build.ts`; without Bun on PATH it fails immediately. |
| Git | `2.55.0` | Materialises the pinned Surge checkout, initialises its submodules, and applies the three patches. |
| Node.js + pnpm | `24.2.0` / `9.15.9` | Only for the test suites (`pnpm test`); not needed to produce the module. |

Emscripten's Windows entry points run `%EMSDK_PYTHON%`, falling back to a bare
`python`; `scripts/build.ts` resolves the interpreter the emsdk ships with and
injects `EMSDK_PYTHON` itself, so no `emsdk_env` activation is required beyond
having `em++` on PATH (or `EMSDK_EMSCRIPTEN_BIN` set).

### Build reproducibility

The build does **not** need `SOURCE_DATE_EPOCH`: Surge stamps build date, time
and host into a generated `version.cpp`, but nothing in this package references
those symbols, so `wasm-ld --gc-sections` drops them before they reach the
module. Two things did leak absolute build paths into the binary and are
suppressed in `cmake/SurgeWebVst.cmake`:

- `CMAKE_INSTALL_PREFIX` is forced to `/webvst`. Surge and sst-plugininfra both
  `configure_file()` it into generated C++ string literals, and under the
  Emscripten toolchain its default value is the emsdk's sysroot -- an absolute
  path inside the developer's home directory.
- `-ffile-prefix-map` remaps the Surge checkout to `/surge`, this repository to
  `/pkg`, and the emsdk root to `/emsdk`, so `__FILE__` (expanded through
  sst-effects' adapter headers in Surge's effect sources) cannot embed the
  build tree's location. Because `scripts/build.ts` works in a temporary
  directory, that path differed between runs on the same machine and was the
  main reason two builds were not byte-identical.

`tests/abi_surface.test.ts` asserts the published module contains no absolute
path at all.

---

## 7. Runtime construction (`sx_create` / `pvst_create`)

`SurgeStorage`'s constructor resolves a config/data path before anything else,
touching real POSIX filesystem and environment APIs (`std::getenv("HOME")`,
several `std::filesystem::exists`/`is_directory` checks, `dladdr(3)`). None of
that has a natural answer in a browser sandbox, and this build has no WASM
exception handling enabled, so any uncaught C++ exception anywhere in the call
graph traps as a bare `unreachable` instead of unwinding. Diagnosing it
required real symbolicated stack traces; the throw site changed three times as
each earlier one was fixed:

1. `homePath()`: `std::getenv("HOME")` returned null. In the Buzz integration
   this was fixed on the JS host side (no patch): the host's `environ_sizes_get`
   / `environ_get` imports reported one variable, `HOME=/`. **This package does
   not depend on that.** Hosts disagree about the WASI environment -- the SDK's
   own probe supplies only `PATH=/usr/bin` and no `HOME` -- so a module that
   needed the host to inject `HOME` would trap under a conforming consumer.
   `src/surge_webvst.cpp` therefore installs its own defaults
   (`setenv("HOME", "/", 0)`, `setenv("PATH", "/usr/bin", 0)`) immediately
   before every `SurgeSynthesizer` construction. The `0` overwrite flag means a
   host that does supply a value still wins. This is package-owned C++, not a
   fourth upstream patch and not a host hook.
2. `getOverridenUserPath()`: `std::filesystem::exists()` threw because a
   no-filesystem `stat` stub returned an errno `<filesystem>` did not
   recognize as "not found". Fixed by building with `-sWASMFS=1` (a real,
   empty, in-memory filesystem), which also shrank the import surface from 23
   functions to 8.
3. `sharedLibraryBinaryPath()`: `dladdr(3)` has no dynamic linker to ask.
   Fixed with `patches/0003-...` above.

With all three resolved, engine construction returns a real handle, parameter
enumeration reports the full parameter set (766 parameters, e.g.
`"Send FX 1 Return"`), a note-on followed by a process call produces audible
output, and state save/restore round-trips while an invalid blob is rejected
without disturbing the last valid state.

---

## 8. Non-patch build-graph fixes (for the record)

These live in the package's own CMake wrapper (added by a later task), not in
upstream source, and are recorded here so the full picture is in one place:

- `SURGE_BUILD_32BIT_LINUX=ON`: wasm32 has 4-byte pointers, tripping Surge's
  own 32-bit-Linux guard. Upstream's own documented override.
- `ZSTD_BUILD_STATIC=ON` / `ZSTD_BUILD_SHARED=OFF` forced as CACHE variables
  before `add_subdirectory`: Surge sets these as plain variables, which zstd's
  `option()` calls silently clear under old CMP0077 behavior, producing two
  `libzstd.a` targets and a Ninja "multiple rules generate" error.
- `pffft` target gets `-Wno-error=#warnings`: pffft's own scalar-fallback
  `#warning` is promoted to a hard error by Surge's inherited `-Werror`.
- `project(... VERSION 1.4.0 ...)` on the wrapper: Surge's version-info step
  reads `CMAKE_PROJECT_VERSION_*`, which name the outermost project; giving the
  wrapper Surge's version keeps that step correct without patching Surge.
- `-sWASMFS=1` link option: see section 7.

---

## 9. Package ABI identity

The module exposes Surge XT through the generic WebVST ABI v1 declared in
`vendor/webvst-sdk/include/prometheos/webvst.h`. The identity below is fixed
and reproducible; nothing in it is random, time-based, or machine-dependent.

| Field | Value |
|---|---|
| Package ID | `org.prometheos.webvst.surgext` |
| ABI | `prometheos-vst3-wasm-1` (`pvst_abi_version()` returns `1`) |
| Class count | `1` |
| Class UID | `b048fd6e0a4b628de039d7291fa13abd` |
| Class name | `Surge XT` |
| Class vendor | `Surge Synth Team` |
| Class kind | `1` (instrument) |
| Module | `build/surgext-webvst.wasm` |

### Class UID derivation

The 128-bit class UID is the first 16 bytes of the SHA-256 digest of a
canonical preimage, rendered as 32 lowercase hexadecimal characters (the form
`schema/plugin.schema.json` requires). The preimage is these four fields joined
by a single newline byte (`0x0a`), with no trailing newline:

```
prometheos-vst3-wasm-1
org.prometheos.webvst.surgext
surge:2644c613fb729cf2ce924c39dc75cf6a61ee9324
class:0
```

giving `sha256 = b048fd6e0a4b628de039d7291fa13abda12e7b15537fcc49a44be95a599464e6`
and therefore `classUid = b048fd6e0a4b628de039d7291fa13abd`.

Every field is either a constant of this repository or an immutable commit
pin, so the UID moves only when the ABI, the package identity, the Surge pin,
or the class index moves -- exactly the events that should mint a new identity.
The value is a literal in `src/surge_webvst.h` (the module carries no SHA-256
implementation); `tests/abi_surface.test.ts` recomputes the digest from those
same four fields and fails if the literal ever drifts. Anything reading the
module through the SDK probe must observe this same value.

### Parameter identity

Parameter IDs are Surge's own stable IDs: the index into `SurgePatch`'s flat
`param_ptr` vector (global parameters, then per-scene parameters, then global
post parameters). That order is fixed by Surge's patch construction for a given
Surge commit, and the commit is part of the class UID, so a pin change mints a
new class rather than silently renumbering an existing one. Values crossing the
ABI are normalized `0..1` via Surge's own `getParameter01` / `setParameter01`.

### Class metadata without a handle

`pvst_class_param_*` take a class index and no instance handle, but Surge has
no static parameter table: its parameter list exists only on a live
`SurgeSynthesizer`, built by `SurgePatch`'s constructor. The module therefore
lazily constructs **one** `SurgeSynthesizer` used solely for metadata --
never processed, never mutated, never destroyed. Surge's factory init patch is
deterministic, so its parameter layout, ranges and defaults are a faithful and
stable description of the class. Keeping it separate from every live instance
is deliberate: class metadata must describe the class, not whatever patch some
instance currently holds. Value text for a normalized value is read with
Surge's own `Parameter::get_display(external = true, ef = normalized)`, which
formats `ef` rather than the stored value, so this stays side-effect free.

### Surface

Exports are the SDK's `PROMETHEOS_WEBVST_EXPORTS` list
(`vendor/webvst-sdk/cmake/WebVstExports.cmake`) -- the 29 `pvst_*` entry points
plus `_initialize`, `malloc` and `free` -- together with `memory`, the
`__indirect_function_table`, and two Emscripten runtime helpers,
`emscripten_stack_get_current` and `_emscripten_stack_restore`. Those last two
are emitted by the toolchain in every standalone build (Emscripten's JS library
`$stackSave`/`$stackRestore` depend on them) and are not package API; there is
no supported `emcc` setting that suppresses them, and the SDK's probe and
package consumer resolve exports by name, so they are inert. No `sx_*`, no
mangled C++ symbol, and nothing else engine-private is exported.

Imports are exactly eight, all inside the SDK's AudioWorklet-compatible
allowlist (`vendor/webvst-sdk/docs/security-model.md`):
`env.__cxa_rethrow`, `env.emscripten_notify_memory_growth`, and the WASI
preview-1 calls `fd_write`, `fd_read`, `clock_time_get`, `environ_sizes_get`,
`environ_get` and `random_get`.

Both surfaces are asserted by `tests/abi_surface.test.ts`.

### Placeholder parameters

Surge's init patch exposes 766 parameters, of which 193 are `ct_none`
placeholders: the parameter slots of the FX units, which carry no meaning until
an effect type is chosen. They keep their IDs (dropping them would renumber the
stable ID space) and are reported with `PVST_PARAMETER_READ_ONLY`, a zero
default and zero steps. Their raw integer bounds span the whole `int` range, so
the step-count computation is done in 64-bit arithmetic rather than overflowing
a signed `int`.

### Deliberate Task-2 limit

`pvst_process` accepts only frame counts that are exact multiples of Surge's
compile-time block size (`SURGE_COMPILE_BLOCK_SIZE=32`) and rejects anything
else with `PVST_ERROR_FRAME_COUNT`. Generalising to arbitrary block sizes is a
later task's FIFO, not a silent mis-render here.
