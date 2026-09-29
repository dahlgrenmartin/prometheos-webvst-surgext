# Surge XT WebCLAP Headless Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a headless `SurgeXT.wclap` that exposes pinned Surge XT directly through the official CLAP C ABI, runs as `wasm32` under WASI, and requires no Surge-specific host glue.

**Architecture:** A new sibling repository, `prometheos-webclap-surgext`, builds only the JUCE-free Surge engine plus one direct `SurgeClapPlugin` implementation and one CLAP preset-discovery provider. The WCLAP bundle contains `module.wasm` plus untransformed Surge data files; arbitrary host block sizes are handled inside `SurgeClapPlugin::process()` against Surge's fixed 32-frame DSP block.

**Tech Stack:** C++20, CMake 3.28+, wasi-sdk 34, official CLAP headers, pinned Surge XT, CTest, Node.js for WASM ABI inspection, and pinned `WebCLAP/wclap-bridge` as a test-only generic host.

**Spec:** `docs/superpowers/specs/2026-09-29-surgext-webclap-headless-design.md`

## Global Constraints

- Target repository: `prometheos-webclap-surgext`.
- Surge pin: `2644c613fb729cf2ce924c39dc75cf6a61ee9324`.
- CLAP headers pin: `a47f6badb49d948fd009998f28309cdab78979c9`.
- Canonical toolchain release: `wasi-sdk-34`; the Linux x86_64 release artifact SHA-256 must be recorded in `toolchains/wasi-sdk.lock` and verified before use.
- WCLAP output architecture: `wasm32`, reactor style, no `main()`.
- Product module is built with `-mexec-model=reactor` and exports `_initialize`, `clap_entry`, exactly one growable function table, exported growable memory, and `malloc()`.
- Product memory envelope: 128 MiB initial memory, 2 GiB maximum memory, 5 MiB stack.
- Product bundle path: `dist/SurgeXT.wclap/module.wasm`.
- Plugin ID: `org.surge-synth-team.surge-xt`.
- Runtime product dependencies must not include JUCE, WebVST SDK, Emscripten runtime, `clap-helpers`, or plugin-specific JavaScript.
- Resources remain ordinary WASI-visible files copied from pinned Surge `resources/data`; do not embed or transform them.
- `clap_id` for engine parameters is `SurgeSynthesizer::idForParameter()`.
- `clap.state` is raw Surge serialized state with no wrapper format.
- v1 exposes one stereo output, one note/MIDI input, params, state, transport, and CLAP preset discovery only.
- v1 excludes GUI, sidechain, Scene A/B outputs, polyphonic modulation, note expression, OSC, user preset writing, custom CLAP extensions, WebVST ID compatibility, and JUCE/CLAP automation-ID compatibility.
- Test-only generic WCLAP host pin: `WebCLAP/wclap-bridge@cd11d22afbe2af350f24cd56e6e0536e5ca86452`.

## Review Focus

1. Missing or mis-mounted bundle resources: `clap_plugin.init()` must fail cleanly without exposing a half-initialized synth; Task 3 owns the regression test.
2. Events around Surge's 32-frame boundary: note/parameter events must affect the same internal block timing as upstream `SurgeSynthProcessor`; Task 5 owns frame 31/32/33 tests.
3. Malformed or truncated CLAP state streams: load must fail without partially mutating the active state; Task 4 owns before/after state comparison tests.
4. Degenerate/placeholder Surge parameters: metadata and defaults must remain finite, IDs stable, and unsupported placeholders non-misleading; Task 4 owns the `ct_none` and finite-value tests.
5. Malformed preset files: one bad `.fxp` must report a discovery error without breaking subsequent discovery or plugin instantiation; Task 6 owns the isolation test.

---

### Task 1: Bootstrap the sibling repo and prove the WCLAP module contract

**Files:**
- Create repository: `dahlgrenmartin/prometheos-webclap-surgext`
- Create: `CMakeLists.txt`
- Create: `.gitmodules`
- Create: `vendor/clap` submodule at `a47f6badb49d948fd009998f28309cdab78979c9`
- Create: `vendor/surge` submodule at `2644c613fb729cf2ce924c39dc75cf6a61ee9324`
- Create: `toolchains/wasi-sdk.lock`
- Create: `cmake/VerifyWasiSdk.cmake`
- Create: `cmake/wasi-sdk.cmake`
- Create: `src/SurgeClapPlugin.h`
- Create: `src/SurgeClapPlugin.cpp`
- Create: `tests/wasm_contract.test.mjs`
- Copy: approved spec to `docs/superpowers/specs/2026-09-29-surgext-webclap-headless-design.md`
- Copy: this plan to `docs/superpowers/plans/2026-09-29-surgext-webclap-headless.md`
- Create: `PROVENANCE.md`

**Interfaces:**
- Produces: exported `extern "C" const clap_plugin_entry_t clap_entry`
- Produces: plugin factory descriptor with ID `org.surge-synth-team.surge-xt`
- Produces: CMake target `SurgeXTWclap` whose output is `dist/SurgeXT.wclap/module.wasm`
- Produces: `toolchains/wasi-sdk.lock` containing `version=wasi-sdk-34`, release URL, and verified SHA-256

- [ ] **Step 1: Create the new repository and copy the approved planning artifacts**

Create `prometheos-webclap-surgext` with an empty `main`, then add only the approved spec/plan and a README identifying the project as headless direct WCLAP.

Expected result: no product source exists before the planning artifacts are present.

- [ ] **Step 2: Pin Surge and CLAP as submodules**

Add `vendor/surge` at `2644c613fb729cf2ce924c39dc75cf6a61ee9324` and `vendor/clap` at `a47f6badb49d948fd009998f28309cdab78979c9`.

Run:

```bash
git submodule status
```

Expected: both paths show exactly those SHAs.

- [ ] **Step 3: Pin wasi-sdk 34 by checksum**

Download the canonical Linux x86_64 `wasi-sdk-34` release artifact once, compute `sha256sum`, and record the exact URL and digest in `toolchains/wasi-sdk.lock`. `cmake/wasi-sdk.cmake` must refuse a toolchain whose version/path does not match the lock.

Run:

```bash
cmake -DLOCK="$PWD/toolchains/wasi-sdk.lock" -DARCHIVE="$WASI_SDK_ARCHIVE" -P cmake/VerifyWasiSdk.cmake
```

Expected: exits 0 and prints `Verified wasi-sdk-33`.

- [ ] **Step 4: Write the failing WASM contract test**

`tests/wasm_contract.test.mjs` must assert:

```js
assert(exports.some(e => e.name === "_initialize" && e.kind === "function"));
assert(exports.some(e => e.name === "clap_entry" && e.kind === "global"));
assert.equal(exports.filter(e => e.kind === "table").length, 1);
assert.equal(exports.filter(e => e.kind === "memory").length, 1);
assert(exports.some(e => e.name === "malloc" && e.kind === "function"));
assert(!exports.some(e => e.name === "_start" || e.name === "main" || e.name === "_main"));
```

It must instantiate the module with stubbed WASI imports, assert that the exported `clap_entry` global has a non-zero integer value, call `table.grow(1)` on the sole exported function table, call `memory.grow(1)` on the sole exported memory, and assert both growth operations succeed.

Run:

```bash
node tests/wasm_contract.test.mjs build-wasi/SurgeXT.wclap/module.wasm
```

Expected: FAIL because the module does not exist.

- [ ] **Step 5: Add the minimal direct CLAP entry/factory shell**

In `src/SurgeClapPlugin.h`, declare:

```cpp
class SurgeClapPlugin final {
public:
    explicit SurgeClapPlugin(const clap_host *host) noexcept;
    const clap_plugin *clapPlugin() noexcept;
};
```

In `src/SurgeClapPlugin.cpp`, define the CLAP descriptor, plugin factory enumeration, `clap_entry.init/deinit/get_factory`, and a temporary factory `create_plugin` that returns `nullptr` until Task 3.

Use official CLAP headers directly. Do not introduce a CLAP wrapper/helper library. Build the WASI target with `-mexec-model=reactor`; keep `_initialize` as the WASI reactor initializer and do not add `main()`.

- [ ] **Step 6: Add the wasi-sdk reactor link surface**

`CMakeLists.txt`/ `cmake/wasi-sdk.cmake` must use these product link properties:

```text
-mexec-model=reactor
--no-entry
--export=clap_entry
--export=malloc
--export-table
--export-memory
--initial-memory=134217728
--max-memory=2147483648
-z stack-size=5242880
```

The module output path is `build-wasi/SurgeXT.wclap/module.wasm` during build and `dist/SurgeXT.wclap/module.wasm` when staged.

- [ ] **Step 7: Build and verify the WCLAP shell**

Run:

```bash
cmake -S . -B build-wasi -G Ninja -DCMAKE_TOOLCHAIN_FILE="$WASI_SDK_PATH/share/cmake/wasi-sdk-p1.cmake"
cmake --build build-wasi --target SurgeXTWclap
node tests/wasm_contract.test.mjs build-wasi/SurgeXT.wclap/module.wasm
```

Expected: build succeeds and the contract test prints PASS.

- [ ] **Step 8: Commit**

```bash
git add .
git commit -m "build: bootstrap direct WCLAP module"
```

### Task 2: Port the JUCE-free Surge engine to wasi-sdk and stage upstream resources

**Files:**
- Create: `cmake/SurgeWasi.cmake`
- Create: `cmake/PackageWclap.cmake`
- Create/omit as proven necessary: `patches/surge/*.patch`
- Create: `tests/package_surface_test.cmake`
- Modify: `CMakeLists.txt`
- Modify: `PROVENANCE.md`

**Interfaces:**
- Consumes: wasi-sdk/Surge/CLAP pins from Task 1
- Produces: CMake target `surge-wasi-engine` linking `surge::surge-common`
- Produces: staged resource root `dist/SurgeXT.wclap/resources/`
- Produces: build-time definition `SURGE_WCLAP_RESOURCE_SUBDIR="resources"`

- [ ] **Step 1: Write the failing package-surface test**

`tests/package_surface_test.cmake` must fail unless all of these exist:

```text
dist/SurgeXT.wclap/module.wasm
dist/SurgeXT.wclap/resources/configuration.xml
dist/SurgeXT.wclap/resources/patches_factory/
dist/SurgeXT.wclap/resources/wavetables/
```

It must also fail if a symlink exists anywhere under `dist/SurgeXT.wclap`.

Run:

```bash
ctest --test-dir build-wasi -R package_surface --output-on-failure
```

Expected: FAIL because resources are not staged.

- [ ] **Step 2: Add the narrowed Surge build graph**

`cmake/SurgeWasi.cmake` must force the same headless exclusions as the proven WebVST engine path:

```text
SURGE_SKIP_JUCE_FOR_RACK=ON
SURGE_SKIP_LUA=ON
SURGE_SKIP_ODDSOUND_MTS=ON
SURGE_BUILD_TESTRUNNER=OFF
SURGE_BUILD_FX=OFF
SURGE_BUILD_XT=OFF
SURGE_BUILD_CLAP=OFF
SURGE_BUILD_RS=OFF
SURGE_BUILD_PYTHON_BINDINGS=OFF
SURGE_COPY_TO_PRODUCTS=OFF
BUILD_TESTING=OFF
ENABLE_LTO=OFF
SURGE_COMPILE_BLOCK_SIZE=32
SURGE_BUILD_32BIT_LINUX=ON
```

Link the product only to `surge::surge-common` and dependencies transitively required by that target. Compile the WASI product with `-fwasm-exceptions` so C++ construction/filesystem failures can be caught at CLAP ABI boundaries; no exception may escape a CLAP callback or occur intentionally on the realtime path.

- [ ] **Step 3: Re-evaluate the three existing portability patch classes under WASI**

For each existing WebVST patch area—CMake/MTS/wasm link assumptions, stacktrace/execinfo fallback, and shared-library-path/`dladdr` fallback—attempt the wasi-sdk build without the patch first.

For each area:
- if the build succeeds and runtime code path is not referenced, do not add a patch; record “not required under wasi-sdk 34” in `PROVENANCE.md`;
- if it fails, add the smallest WASI-specific patch under `patches/surge/`, hash it, and record the reason.

No Emscripten-specific preprocessor branch may be copied as-is.

- [ ] **Step 4: Stage upstream `resources/data` verbatim**

`cmake/PackageWclap.cmake` must copy the complete contents of pinned Surge `resources/data/` to `dist/SurgeXT.wclap/resources/` without rewriting filenames or contents.

Do not add any resource tree outside pinned `resources/data`. Copy that directory verbatim—even if it contains inert upstream skin data—rather than inventing a custom resource-curation layer for v1.

- [ ] **Step 5: Build and run the package-surface test**

Run:

```bash
cmake --build build-wasi --target package_wclap
ctest --test-dir build-wasi -R package_surface --output-on-failure
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add CMakeLists.txt cmake patches tests PROVENANCE.md
git commit -m "build: port Surge engine to wasi-sdk"
```

### Task 3: Implement plugin lifecycle, bundle-path resolution, and ports

**Files:**
- Modify: `src/SurgeClapPlugin.h`
- Modify: `src/SurgeClapPlugin.cpp`
- Create: `tests/ClapTestHost.h`
- Create: `tests/plugin_lifecycle_test.cpp`
- Modify: `CMakeLists.txt`

**Interfaces:**
- Consumes: `surge::surge-common`, staged resource layout
- Produces:
  - `bool SurgeClapPlugin::init() noexcept`
  - `bool SurgeClapPlugin::activate(double sampleRate, uint32_t minFrames, uint32_t maxFrames) noexcept`
  - `void SurgeClapPlugin::deactivate() noexcept`
  - `bool SurgeClapPlugin::startProcessing() noexcept`
  - `void SurgeClapPlugin::stopProcessing() noexcept`
  - `void SurgeClapPlugin::reset() noexcept`
  - `const void *SurgeClapPlugin::getExtension(const char *id) noexcept`
  - one `clap.audio-ports` extension with one stereo output
  - one `clap.note-ports` extension with one input supporting CLAP note dialect and MIDI
- `SurgeClapPlugin` owns exactly one `std::unique_ptr<SurgeSynthesizer>`

- [ ] **Step 1: Write failing lifecycle/port tests**

`tests/plugin_lifecycle_test.cpp` must assert:

```cpp
CHECK(factory->get_plugin_count(factory) == 1);
CHECK(std::string(descriptor->id) == "org.surge-synth-team.surge-xt");
CHECK(plugin->init(plugin));
CHECK(audioPorts->count(plugin, false) == 1);
CHECK(notePorts->count(plugin, true) == 1);
CHECK(plugin->activate(plugin, 48000.0, 1, 128));
CHECK(plugin->start_processing(plugin));
plugin->stop_processing(plugin);
plugin->deactivate(plugin);
plugin->destroy(plugin);
```

Add a second test that calls entry/plugin initialization with a bundle path whose `resources/configuration.xml` is missing and asserts `plugin->init(plugin) == false`.

Run:

```bash
ctest --test-dir build-native -R plugin_lifecycle --output-on-failure
```

Expected: FAIL because `create_plugin` still returns `nullptr`.

- [ ] **Step 2: Implement bundle-root resolution inside `SurgeClapPlugin.cpp`**

Store the path received by `clap_entry.init(plugin_path)`. Resolve:
- `.../SurgeXT.wclap/module.wasm` -> bundle root `.../SurgeXT.wclap`;
- a directory path -> that directory.

Construct Surge with the pinned engine's supplied-data-path constructor:

```cpp
std::make_unique<SurgeSynthesizer>(nullptr, (<bundle-root> / "resources").string())
```

Do not search `HOME`, developer paths, or native install locations for factory data.

Before construction under WASI, provide deterministic writable defaults without overriding host-provided values: `HOME=/var` and `PATH=/usr/bin`. The generic-host smoke test must mount a writable `/var`; native tests point `HOME` at a temporary writable directory.

For native tests, `ClapTestHost` passes the staged bundle path explicitly.

- [ ] **Step 3: Construct and own `SurgeSynthesizer` in `init()`**

Create `SurgeSynthesizer` only after validating mandatory resources. Catch construction failures at the callback boundary and return false; do not let exceptions escape the CLAP ABI.

`activate()` calls `setSamplerate(sampleRate)` and clears block/transport state.

`reset()` calls `allNotesOff()` and resets the 32-frame cursor.

- [ ] **Step 4: Implement the two standard port extensions**

Audio: exactly one output, stereo, main port, no input port. Do not set `CLAP_AUDIO_PORT_SUPPORTS_64BITS`; v1 accepts `data32` processing only.

Notes: exactly one input. Set `supported_dialects = CLAP_NOTE_DIALECT_CLAP | CLAP_NOTE_DIALECT_MIDI`, `preferred_dialect = CLAP_NOTE_DIALECT_CLAP`, and expose no note output.

- [ ] **Step 5: Run lifecycle tests**

Run:

```bash
cmake -S . -B build-native -G Ninja -DBUILD_NATIVE_TESTS=ON
cmake --build build-native
ctest --test-dir build-native -R plugin_lifecycle --output-on-failure
```

Expected: PASS, including the missing-resource failure test.

- [ ] **Step 6: Rebuild WCLAP contract after engine integration**

Run:

```bash
cmake --build build-wasi --target package_wclap
node tests/wasm_contract.test.mjs build-wasi/SurgeXT.wclap/module.wasm
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src tests CMakeLists.txt
git commit -m "feat: add Surge CLAP lifecycle and ports"
```

### Task 4: Implement direct parameters and raw Surge state

**Files:**
- Modify: `src/SurgeClapPlugin.h`
- Modify: `src/SurgeClapPlugin.cpp`
- Create: `tests/params_state_test.cpp`
- Modify: `CMakeLists.txt`

**Interfaces:**
- Produces: `clap_plugin_params_t` from `getExtension(CLAP_EXT_PARAMS)`
- Produces: `clap_plugin_state_t` from `getExtension(CLAP_EXT_STATE)`
- Parameter lookup rule: `clap_id == synth_->idForParameter(parameter)`
- Parameter cookies: `nullptr` in v1; lookup uses the direct ID table
- State save: `SurgeSynthesizer::saveRaw()` -> CLAP ostream
- State load: complete CLAP istream -> temporary byte vector -> Surge queued state-loading path

- [ ] **Step 1: Write failing parameter identity/metadata tests**

The test must enumerate every reported parameter and assert:
- `info.id` equals `synth.idForParameter(p)`;
- IDs are unique;
- `info.min_value == 0.0`, `info.max_value == 1.0`;
- `info.default_value` is finite and inside `[0,1]`;
- names are non-empty;
- `ct_none` placeholders never report invalid ranges or NaNs.

Also assert value-to-text for one continuous, one integer, and one boolean parameter matches Surge's own display string for the same normalized value.

Run:

```bash
ctest --test-dir build-native -R params_state --output-on-failure
```

Expected: FAIL because `CLAP_EXT_PARAMS` is absent.

- [ ] **Step 2: Implement direct parameter enumeration and value conversion**

Build a stable `std::vector<Parameter *>` from `storage.getPatch().param_ptr` during `init()`.

Implement `count`, `get_info`, `get_value`, `value_to_text`, `text_to_value`, and `flush`.

Use Surge's own normalized conversion/display/parsing methods. Sanitize non-finite defaults to a finite in-range value exactly as required by the tests.

Do not create JUCE-style parameter adapter objects.

- [ ] **Step 3: Write failing state round-trip and malformed-stream tests**

The state test must:
1. save state A;
2. mutate at least one parameter and verify the saved bytes now differ;
3. load state A;
4. save state B and assert A == B.

The malformed-state test must cover at least:
- fewer than 4 bytes;
- a truncated `patch_header`;
- a `sub3` header whose `xmlsize` runs past the buffer;
- a valid state truncated inside appended wavetable/arbitrary-block storage.

For each case:
1. save current valid state;
2. call state load with the malformed bytes;
3. assert load returns false;
4. save state again and assert it still equals the original valid state.

- [ ] **Step 4: Implement raw state save/load**

`save` calls `populateDawExtraState()`, then `saveRaw()`, then writes all bytes through `clap_ostream::write` until complete or failure.

`load` reads the entire CLAP stream into a temporary vector before calling Surge's queued state-load path. Do not apply bytes incrementally.

Because pinned `SurgePatch::load_patch()` returns `void` and can return early after `loadRaw()` has already reset the active patch, add an internal `bool validateSurgeStateBlob(std::span<const std::byte>) noexcept` in `SurgeClapPlugin.cpp`. It must perform the same top-level bounds checks needed to prove the raw patch is structurally complete before enqueueing: minimum size, `sub3` header size, XML extent, appended wavetable extents, and claimed trailing arbitrary-block extent. For XML-only legacy states, parse the XML into a temporary TinyXML document and require a root patch element before enqueueing.

Only after validation succeeds call `enqueuePatchForLoad()`. When audio is unavailable, immediately run Surge's normal `processAudioThreadOpsWhenAudioEngineUnavailable()` path; when processing is active, leave the validated state queued for the audio thread.

Use the pinned processor's non-realtime state-application sequence as the behavioral reference, but do not instantiate `SurgeSynthProcessor`.

- [ ] **Step 5: Run parameter/state tests**

Run:

```bash
cmake --build build-native
ctest --test-dir build-native -R params_state --output-on-failure
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src tests CMakeLists.txt
git commit -m "feat: expose Surge params and raw state"
```

### Task 5: Implement note/MIDI events, 32-frame processing, and transport

**Files:**
- Modify: `src/SurgeClapPlugin.h`
- Modify: `src/SurgeClapPlugin.cpp`
- Create: `tests/audio_process_test.cpp`
- Create: `tests/transport_test.cpp`
- Modify: `CMakeLists.txt`

**Interfaces:**
- Produces: `clap_process_status SurgeClapPlugin::process(const clap_process *process) noexcept`
- Persistent DSP cursor: `uint32_t blockPos_` in `[0,31]`
- Uses `synth_->output[0/1][blockPos_]` as the persisted generated 32-frame block; no separate FIFO/helper class
- Event rule: process all events at host frame `i` before rendering/emitting frame `i`; `synth_->process()` runs only when `blockPos_ == 0`
- Host transport is authoritative at the next Surge block boundary; absent transport uses the patch tempo and a free-running PPQ clock

- [ ] **Step 1: Write failing arbitrary-block audio tests**

For one deterministic factory/init patch and one note, render the same duration using host blocks of:

```text
1, 7, 31, 32, 33, 64, 127, 128
```

Assert:
- every render produces non-silent stereo audio;
- all renders have the same total frame count;
- each render matches the 32-frame-reference render within the same floating-point tolerance.

Run:

```bash
ctest --test-dir build-native -R audio_process --output-on-failure
```

Expected: FAIL because `process()` is not implemented.

- [ ] **Step 2: Write failing event-boundary tests**

Schedule note-on and one parameter change at frames 31, 32, and 33.

Assert behavior matches this rule:

```text
event at internal boundary -> affects the block started at that boundary
event after internal boundary -> affects the next 32-frame block
```

Also split the host callback across the same positions to prove CLAP callback boundaries do not reset `blockPos_`.

- [ ] **Step 3: Implement sample-walk processing without a helper adapter**

For each host frame:
1. consume all input events whose `header.time == frame`;
2. apply supported note/MIDI/param-value events directly to Surge;
3. when `blockPos_ == 0`, update `time_data` and call `synth_->process()`;
4. copy `synth_->output[0/1][blockPos_]` to the CLAP stereo output;
5. increment `blockPos_` modulo 32.

Supported core events:
- `CLAP_EVENT_NOTE_ON`: call `playNote(channel, key, round(127 * velocity), 0, note_id)`; velocity zero is a release.
- `CLAP_EVENT_NOTE_OFF`: call `releaseNote(channel, key, round(127 * velocity), note_id)`.
- `CLAP_EVENT_NOTE_CHOKE`: call `chokeNote(channel, key, round(127 * velocity), note_id)`.
- `CLAP_EVENT_MIDI`: parse the status byte directly, with 0-based channel, and map note on/off, channel pressure, poly pressure, pitch wheel (14-bit value minus 8192), controller, and program change to the corresponding `SurgeSynthesizer` methods used by pinned upstream `applyMidi()`; do not use JUCE MIDI classes.
- `CLAP_EVENT_PARAM_VALUE`: clamp finite values to `[0,1]` and call `setParameter01(param_id, value, true)` for a valid engine ID.

Reject/ignore events whose `space_id` is not `CLAP_CORE_EVENT_SPACE_ID` or whose `header.time >= process->frames_count`. A zero-frame process call is valid: return without changing `blockPos_` or transport.

Ignore unsupported core/non-core events safely.

Do not implement param modulation or note expression in v1.

- [ ] **Step 4: Write failing transport tests**

Test:
- host tempo 90 BPM;
- host tempo 140 BPM;
- host PPQ/song-position discontinuity at a CLAP callback boundary;
- no transport pointer for multiple callbacks.

Assert `surge->time_data` is refreshed from host values at the next internal 32-frame boundary. With no host transport, assert PPQ increases monotonically using `storage.unstreamedTempo` or 120 BPM fallback.

- [ ] **Step 5: Implement transport mapping/free-run**

At each internal block boundary:
- if `process->transport` is present, convert CLAP fixed-point beat/song positions with the official `CLAP_BEATTIME_FACTOR`/`CLAP_SECTIME_FACTOR` constants, copy only fields whose validity flags are set, map playing state and time signature, then call `resetStateFromTimeData()`;
- otherwise set a running 4/4 clock, choose `storage.unstreamedTempo > 0 ? storage.unstreamedTempo : 120.0`, call `resetStateFromTimeData()`, and advance PPQ by `32 * tempo / (60 * sampleRate)` after processing.

- [ ] **Step 6: Run audio/event/transport tests**

Run:

```bash
cmake --build build-native
ctest --test-dir build-native -R "audio_process|transport" --output-on-failure
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src tests CMakeLists.txt
git commit -m "feat: add direct Surge audio processing"
```

### Task 6: Implement CLAP preset discovery from bundled Surge patches

**Files:**
- Create: `src/SurgePresetDiscovery.cpp`
- Modify: `src/SurgeClapPlugin.cpp`
- Create: `tests/preset_discovery_test.cpp`
- Modify: `CMakeLists.txt`

**Interfaces:**
- Produces: `const clap_preset_discovery_factory_t *surgePresetDiscoveryFactory() noexcept`
- Provider ID: `org.surge-synth-team.surge-xt.preset-indexer`
- Plugin association: `{"clap", "org.surge-synth-team.surge-xt"}`
- Factory locations: bundled `resources/patches_factory` and `resources/patches_3rdparty`
- File type: Surge XT patch, extension `fxp`

- [ ] **Step 1: Write failing preset-discovery tests**

Using the staged resource tree, assert the provider:
- declares file type `fxp`;
- declares factory and third-party locations when those directories exist;
- returns name/creator/category metadata for one known factory `.fxp`;
- associates the preset with `org.surge-synth-team.surge-xt`.

Create a temporary malformed `.fxp`, call `get_metadata`, assert it reports an error/false, then immediately query a valid factory preset and assert that succeeds.

Run:

```bash
ctest --test-dir build-native -R preset_discovery --output-on-failure
```

Expected: FAIL because the preset-discovery factory is absent.

- [ ] **Step 2: Port only the JUCE-free preset-discovery semantics**

Use pinned upstream `SurgeCLAPPresetDiscovery.cpp` as the semantic source.

Reuse:
- `SurgeStorage`;
- `PatchFileHeaderStructs.h`;
- endian helpers;
- TinyXML already used by Surge.

Do not include `SurgeSynthProcessor.h`, JUCE headers, OSC code, or editor code.

User preset locations are omitted in v1.

- [ ] **Step 3: Expose the preset factory from `clap_entry.get_factory`**

When `factory_id` equals the CLAP preset-discovery factory ID (including the compat ID if required by the pinned headers), return `surgePresetDiscoveryFactory()`.

Do not expose preset discovery as an instantiated plugin extension.

- [ ] **Step 4: Run preset tests and WCLAP contract**

Run:

```bash
cmake --build build-native
ctest --test-dir build-native -R preset_discovery --output-on-failure
cmake --build build-wasi --target package_wclap
node tests/wasm_contract.test.mjs build-wasi/SurgeXT.wclap/module.wasm
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src tests CMakeLists.txt
git commit -m "feat: add Surge preset discovery"
```

### Task 7: Add provenance, forbidden-surface checks, and reproducible clean builds

**Files:**
- Create: `tests/forbidden_surface_test.mjs`
- Create: `tests/reproducibility_test.cmake`
- Modify: `PROVENANCE.md`
- Modify: `CMakeLists.txt`
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: complete WCLAP package from Tasks 1-6
- Produces: deterministic file manifest `dist/SurgeXT.wclap.sha256`
- Produces: CI gate that rejects forbidden runtime surfaces and path leaks

- [ ] **Step 1: Write the failing forbidden-surface test**

`tests/forbidden_surface_test.mjs` must assert:
- no exported symbol starts with `webvst_`;
- no import module/name contains `emscripten`;
- raw module bytes do not contain `webvst`, `SurgeSynthProcessor`, or known checkout/home prefixes from the CI workspace;
- product build metadata has no JUCE target/link reference.

Run:

```bash
node tests/forbidden_surface_test.mjs dist/SurgeXT.wclap/module.wasm build-wasi
```

Expected: FAIL until path remapping/build flags and checks are wired.

- [ ] **Step 2: Add deterministic path controls and package manifest**

Apply source/build/toolchain prefix maps so embedded `__FILE__` paths are synthetic.

Generate `dist/SurgeXT.wclap.sha256` by hashing every regular file under `dist/SurgeXT.wclap` in sorted relative-path order.

No timestamps or absolute paths belong in the manifest.

- [ ] **Step 3: Write the clean-build reproducibility test**

`tests/reproducibility_test.cmake` must create two fresh build directories with the same locked toolchain and inputs, build `package_wclap`, and compare:
- `module.wasm` SHA-256;
- sorted relative file list;
- per-file SHA-256 manifest.

Expected: byte-identical equality for all unpacked bundle files.

- [ ] **Step 4: Complete `PROVENANCE.md`**

Record:
- Surge URL + exact SHA;
- CLAP URL + exact SHA;
- wasi-sdk 34 asset URL + SHA-256;
- every retained Surge patch + SHA-256 + rationale;
- explicit note for each old WebVST patch class that was dropped as unnecessary;
- `resources/data` provenance;
- test-only `wclap-bridge` pin;
- canonical clean-build command.

- [ ] **Step 5: Run the hardening gates**

Run:

```bash
cmake --build build-wasi --target package_wclap
node tests/forbidden_surface_test.mjs dist/SurgeXT.wclap/module.wasm build-wasi
ctest --test-dir build-wasi -R "package_surface|reproducibility" --output-on-failure
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add tests PROVENANCE.md CMakeLists.txt .github
git commit -m "test: lock WCLAP surface and reproducibility"
```

### Task 8: Prove the packaged WCLAP in a generic WebCLAP host

**Files:**
- Add test-only submodule: `tests/vendor/wclap-bridge` at `cd11d22afbe2af350f24cd56e6e0536e5ca86452`
- Create: `tests/webclap_smoke_test.cpp`
- Modify: `CMakeLists.txt`
- Modify: `.github/workflows/ci.yml`
- Modify: `PROVENANCE.md`

**Interfaces:**
- Consumes: `dist/SurgeXT.wclap`
- Consumes generic host API:
  - `wclap_global_init(unsigned int)`
  - `wclap_open_with_dirs(...)`
  - `wclap_get_error(...)`
  - `wclap_get_factory(...)`
  - `wclap_close(...)`
- Produces: end-to-end smoke proof through Wasmtime/WebCLAP translation, with no Surge-specific host API

- [ ] **Step 1: Write the failing generic-host smoke test**

`tests/webclap_smoke_test.cpp` must:
1. call `wclap_global_init(5000)`;
2. create temporary writable preset/cache/var directories and open `dist/SurgeXT.wclap` with `wclap_open_with_dirs`, passing the temp var directory so the module receives writable `/var`;
3. assert `wclap_get_error` reports no error;
4. obtain `CLAP_PLUGIN_FACTORY_ID` using `wclap_get_factory`;
5. assert one descriptor with ID `org.surge-synth-team.surge-xt`;
6. create/init/activate/start the plugin with the test CLAP host;
7. send one note-on and render 128 frames;
8. assert at least one output sample is non-zero and finite;
9. change one exposed parameter through CLAP, save state, mutate, restore, and verify the restored value;
10. obtain the preset-discovery factory and verify at least one factory preset can be indexed;
11. stop/deactivate/destroy, close the WCLAP, and call `wclap_global_deinit()`.

No call in this test may include a Surge-specific ABI or WebVST function.

Run:

```bash
ctest --test-dir build-native -R webclap_smoke --output-on-failure
```

Expected: FAIL before `wclap-bridge` is wired into the test build.

- [ ] **Step 2: Add pinned `wclap-bridge` as a test-only dependency**

Initialize `tests/vendor/wclap-bridge` recursively at `cd11d22afbe2af350f24cd56e6e0536e5ca86452`.

Only native tests link `wclap-bridge`; the product target must not depend on it.

- [ ] **Step 3: Wire the smoke test and fix only product-standard incompatibilities it exposes**

Build and run:

```bash
cmake --build build-wasi --target package_wclap
cmake -S . -B build-native -G Ninja -DBUILD_NATIVE_TESTS=ON -DBUILD_WEBCLAP_SMOKE_TEST=ON
cmake --build build-native --target webclap_smoke_test
ctest --test-dir build-native -R webclap_smoke --output-on-failure
```

Expected: PASS.

If this exposes a WCLAP/WASI contract issue, fix the standard product behavior; do not add host-specific adapters, bridge detection, or JS glue.

- [ ] **Step 4: Make CI run the complete matrix**

CI order:
1. verify locked wasi-sdk SHA;
2. initialize pinned submodules;
3. native unit tests;
4. wasi-sdk build + package;
5. WASM contract + forbidden-surface tests;
6. generic `wclap-bridge` smoke test;
7. reproducibility build.

Run locally:

```bash
ctest --test-dir build-native --output-on-failure
ctest --test-dir build-wasi --output-on-failure
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add .gitmodules tests CMakeLists.txt .github PROVENANCE.md
git commit -m "test: verify Surge XT in generic WebCLAP host"
```

### Task 9: Final acceptance sweep and release-ready documentation

**Files:**
- Create: `README.md` final usage/build sections
- Modify: `PROVENANCE.md`
- Modify: `docs/superpowers/specs/2026-09-29-surgext-webclap-headless-design.md` only if implementation uncovered a factual correction; do not silently change approved scope

**Interfaces:**
- Consumes: all previous tasks
- Produces: release-ready `dist/SurgeXT.wclap` and checksum manifest

- [ ] **Step 1: Run the complete clean acceptance sequence**

From a clean checkout:

```bash
git submodule update --init --recursive
cmake -S . -B build-native -G Ninja -DBUILD_NATIVE_TESTS=ON -DBUILD_WEBCLAP_SMOKE_TEST=ON
cmake --build build-native
ctest --test-dir build-native --output-on-failure

cmake -S . -B build-wasi -G Ninja -DCMAKE_TOOLCHAIN_FILE="$WASI_SDK_PATH/share/cmake/wasi-sdk-p1.cmake"
cmake --build build-wasi --target package_wclap
ctest --test-dir build-wasi --output-on-failure

node tests/wasm_contract.test.mjs dist/SurgeXT.wclap/module.wasm
node tests/forbidden_surface_test.mjs dist/SurgeXT.wclap/module.wasm build-wasi
```

Expected: zero failures.

- [ ] **Step 2: Verify every acceptance criterion from the spec against evidence**

Record in the final PR description:
- exact commands above;
- `dist/SurgeXT.wclap/module.wasm` SHA-256;
- parameter count;
- number of discovered factory presets;
- confirmation that `wclap-bridge` smoke rendered non-silent audio;
- confirmation that no forbidden runtime surfaces were detected.

- [ ] **Step 3: Finish README and provenance**

README must explain:
- this is headless;
- it is direct CLAP/WCLAP over `SurgeSynthesizer`;
- build prerequisites and locked toolchain;
- bundle layout;
- implemented v1 CLAP extensions;
- explicit v1 exclusions.

Do not document GUI/modulation/sidechain features as supported.

- [ ] **Step 4: Commit**

```bash
git add README.md PROVENANCE.md docs
git commit -m "docs: finalize headless WebCLAP package"
```

