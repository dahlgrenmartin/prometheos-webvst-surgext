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
# WebVST editor development

The optional WebVST editor is built independently of the Surge DSP. With an
existing `build/surgext-webvst.wasm`, select an SDK checkout containing the new
UI framework and run:

```powershell
$env:WEBVST_SDK_DIR = (Resolve-Path ../prometheos-vst3-wasm-sdk).Path
pnpm run build:ui
pnpm test
```

On POSIX shells use `WEBVST_SDK_DIR=../prometheos-vst3-wasm-sdk pnpm run build:ui`.
This probes the existing DSP, generates `ui.json` and C++ parameter metadata,
compiles only the small editor module, packs and verifies
`dist/SurgeXT-UI.webvst`, and writes its SHA-256 sidecar. Emscripten is required.
The selected SDK's tools must be built after SDK source changes. Without the
environment override the existing vendored SDK remains the default; its current
pin predates UI support, so `build:ui` requires the explicit override. Neither
vendor pin is changed. `bun scripts/build.ts --package-only` also rebuilds the
original DSP-only package without a DSP compile. `--with-ui` can be added to a
full build.

`scripts/generate-ui.ts` derives all bindings from probed parameter IDs. The
complete declarative fallback currently covers all 573 exposed parameters,
grouped into global/output, effects, both scenes, oscillators, mixer, filters,
envelopes and voice/scene LFOs. Every control has an authored `surge-param-N`
component ID and the matching numeric string parameter binding. Scene grouping
uses the two probed `Octave` anchors in stable ID order; ambiguous anchors fail
generation instead of inventing a scene. A host displays the tall fallback in
a scrollable editor container.

`src/ui/SurgeEditor.cpp` ports the upstream JUCE editor to the WebVST UI
toolkit. It is data-driven the same way upstream is: `scripts/generate-ui.ts`
reads the pinned upstream `src/common/SkinModel.cpp` (every control's position
in the 905x569 design), the slider styles in `SurgePatch.cpp` (bipolar,
semitone, mini), `resource.h` and `fx_type_acronyms`, and binds each probed
parameter to its upstream connector; generation fails if any parameter has no
connector. Each widget class mirrors the upstream widget it replaces
(`ModulatableSlider`, `MultiSwitch`, `Switch`, `NumberField`,
`MenuForDiscreteParams`, `EffectChooser`, `ModulationSourceButton`,
`LFOAndStepDisplay`, `PatchSelector`) and draws the dark-mode skin's SVG
sprites with the same offsets and clip regions. The editor zooms the design to
the host's size like Surge's zoom. The shown scene follows the canonical
`Active Scene` parameter; oscillator, LFO (via the modulation buttons) and FX
slot selection are editor view state that rebinds the controls, so all 573
parameters are reachable. Custom UI failure leaves the complete declarative
editor available.

The patch browser uses the host program service (`host.programs/1`): it shows
the current preset and category, steps with the category/patch jogs (or the
mouse wheel over the name), and opens a browser with category lists and a
typeahead search across all factory presets. The host loads the preset; hosts
that read parameters back after a load (buzz-remote does) update every control.

With the SDK's optional plugin-message channel (`webvst-ext-message-1`, see
`src/surge_messages.cpp`), the editor asks the running synth for what only it
knows: live parameter names and value text (so oscillator and FX controls are
labelled for the current type), typed-value parsing, filter subtype counts, the
oscillator and LFO displays (the upstream display code paths, rendered by the
DSP), and modulation routings. Clicking a modulation source selects it (LFOs open
in the LFO panel); clicking it again arms modulation editing, where slider drags
set depth through Surge's own `setModDepth01`. Routings live in the synth's
state and are saved with it. Controls show upstream hover art, double-click
resets to default, and right-click opens a context menu (value, default, typed
entry, clearing a routing). The 192 FX slot parameters are exposed as generic
automatable parameters (`FX A1 Param 1` ...), so the package has 765.

Remaining gaps against upstream: wavetable browsing and import, favorites and
patch saving, formula (Lua) modulators, MSEG/step-sequencer editing, tuning/MPE
tools, dialogs, and undo for modulation-routing edits (they live in the synth's
state, not in host parameters). The
oscillator and LFO displays are sketches from parameter values, not DSP renders.
FX per-slot parameters are not exposed by the DSP probe, so the FX panel shows
the slot grid and type only. Control labels use the probed (default oscillator
type) names.

The ordinary test suite still checks the pinned baseline package. When
`SurgeXT-UI.webvst` exists, `tests/ui-package.test.ts` additionally instantiates the
actual UI WASM and checks complete navigation coverage, parameter gesture and
canonical-value behavior, teardown, hashes, fallback content, and unchanged
DSP/preset/license payloads. Those three tests are skipped until `build:ui` has
produced the optional artifact. `tests/ui.test.ts` checks the skin-model parsing
and parameter binding against the vendored upstream checkout.
