# Surge XT WebCLAP Headless Design

Date: 2026-09-29  
Status: Approved conversational design; implementation not started  
Target repository: `prometheos-webclap-surgext`

## 1. Purpose

Build a headless Surge XT WebCLAP package that can accurately be described as **Surge compiled as a direct WCLAP plugin**, not Surge wrapped by WebVST, JUCE, an adapter SDK, a JavaScript shim, or a helper framework.

The target is a new sibling repository, independent from `prometheos-webvst-surgext`. The existing WebVST repository remains intact.

Success means a generic WebCLAP host can load the resulting bundle, enumerate the plugin and factory presets, instantiate it, send notes and parameter changes, provide transport, save and restore state, process arbitrary host frame counts, and render correct audio without Surge-specific host glue.

## 2. Fixed architectural decisions

The design uses these choices:

- New sibling repository: `prometheos-webclap-surgext`.
- wasi-sdk as the only WebAssembly toolchain from the first implementation.
- Official CLAP headers only; no `clap-helpers`.
- Direct CLAP C ABI.
- `SurgeClapPlugin` owns `SurgeSynthesizer` directly.
- No JUCE and no reuse of `SurgeSynthProcessor` as a runtime dependency.
- No WebVST SDK or WebVST ABI.
- No Emscripten runtime.
- No Surge-specific JavaScript or host-side adapter.
- Surge resources are ordinary files in the WCLAP bundle and are accessed through WASI filesystem APIs.
- Arbitrary CLAP process sizes are handled inside `SurgeClapPlugin::process()`; there is no separate `FixedBlockStream` abstraction.
- Surge engine parameter IDs from `SurgeSynthesizer::idForParameter()` are used directly as `clap_id`.
- `clap.state` exposes Surge's native serialized state bytes directly.
- CLAP preset discovery is included in v1.
- The first release is headless.

Relevant upstream reference points:

- Existing JUCE-free Surge engine build boundary:  
  https://github.com/dahlgrenmartin/prometheos-webvst-surgext/blob/main/cmake/SurgeWebVst.cmake
- Pinned Surge processor behavior reference:  
  https://github.com/surge-synthesizer/surge/blob/2644c613fb729cf2ce924c39dc75cf6a61ee9324/src/surge-xt/SurgeSynthProcessor.cpp
- Pinned Surge CLAP preset discovery implementation:  
  https://github.com/surge-synthesizer/surge/blob/2644c613fb729cf2ce924c39dc75cf6a61ee9324/src/surge-xt/SurgeCLAPPresetDiscovery.cpp
- WebCLAP WCLAP module and bundle contract:  
  https://github.com/WebCLAP/.github/blob/main/profile/README.md

## 3. Scope

### 3.1 Included in v1

- One stereo instrument output.
- One note input accepting CLAP note events and MIDI.
- Surge engine parameters through `clap.params`.
- Direct Surge engine IDs as CLAP parameter IDs.
- Raw Surge state through `clap.state`.
- Transport and tempo mapping from `clap_process.transport`.
- Internal free-running transport fallback when the host supplies no transport.
- Arbitrary host process sizes over Surge's fixed 32-frame engine block.
- Factory and third-party resources in the bundle filesystem.
- CLAP preset discovery for bundled presets.
- Deterministic pinning of Surge, CLAP headers, wasi-sdk, and local Surge patches.
- Generic WebCLAP host compatibility.

### 3.2 Explicitly excluded from v1

- GUI or webview.
- JUCE processor/editor reuse.
- Sidechain input.
- Scene A/B auxiliary outputs.
- Polyphonic parameter modulation.
- CLAP note expression.
- OSC.
- User preset writing.
- Custom CLAP extensions.
- Compatibility with existing WebVST parameter IDs.
- Compatibility with desktop Surge's JUCE/CLAP automation-ID mapping.
- Any custom host protocol.

These exclusions are additive future work and must not distort the v1 architecture.

## 4. Repository and build architecture

The new repository should remain narrow:

```text
prometheos-webclap-surgext/
    CMakeLists.txt
    PROVENANCE.md
    cmake/
        wasi-sdk.cmake
    patches/
        surge/
    src/
        SurgeClapPlugin.h
        SurgeClapPlugin.cpp
        SurgePresetDiscovery.cpp
    tests/
    vendor/
        surge/
        clap/
```

The build graph is:

```text
wasi-sdk
  -> pinned/patched Surge source
  -> surge::surge-common
  -> SurgeClapPlugin.cpp + SurgePresetDiscovery.cpp
  -> module.wasm
```

The build must not include:

- JUCE.
- `SurgeSynthProcessor`.
- `clap-helpers`.
- WebVST SDK code.
- Emscripten support libraries.
- plugin-specific JavaScript glue.

The Surge configuration should retain the existing JUCE-free strategy: disable the Surge XT/JUCE targets and unrelated products, and compile only the engine and dependencies required by `SurgeSynthesizer` and preset metadata handling.

The exact Surge commit is pinned. The exact CLAP header commit is pinned. The exact wasi-sdk release and checksum are pinned.

## 5. WCLAP module contract

The output is a `wasm32` WCLAP reactor module. It has no `main()` entry point.

The generated module must satisfy the WebCLAP contract directly:

- export `clap_entry`;
- import memory or export memory according to WCLAP host requirements;
- export exactly one growable function table;
- export `malloc()` or a compatible allocator entry such as `cabi_realloc()`;
- expose `module.wasm` at the top level of the `.wclap` bundle;
- use WASI for filesystem/system services rather than an Emscripten runtime.

The build and ABI tests must inspect these WebAssembly-level properties, not merely prove that the module links.

The module should avoid relying on symlinks inside the bundle because WebCLAP hosts are not required to support them.

## 6. Surge portability policy

The three existing WebVST Surge patches are **not** copied blindly.

Each patch is re-evaluated under wasi-sdk:

1. If WASI no longer needs the patch, omit it.
2. If the same portability issue exists, retain the smallest equivalent patch.
3. If WASI exposes a new incompatibility, add only the minimum patch required.
4. Every retained patch is documented and hashed in `PROVENANCE.md`.

No patch may exist solely to emulate Emscripten behavior.

The source and binary should not embed developer-specific absolute paths. Reproducible path remapping or equivalent compile-time controls remain part of the build requirements.

## 7. WCLAP bundle and filesystem

The package should follow normal WebCLAP/WCLAP bundle conventions and keep Surge's resource layout as close to upstream as practical.

Conceptually:

```text
SurgeXT.wclap/
    module.wasm
    resources/
        patches_factory/
        patches_3rdparty/
        wavetables/
        ...
```

The rule is fixed: **Surge reads ordinary bundled files through WASI filesystem access**.

There is no generated resource embedding layer.

The bundle root is derived from the plugin path supplied to `clap_entry.init()`. `SurgeStorage` receives a deterministic resource path relative to that bundle root. It must not search developer paths, native host paths, or environment-specific fallback directories.

If Surge requires a writable config or user directory, the plugin maps that to a known writable WASI sandbox location. That writable location is separate from the immutable bundled factory content.

## 8. CLAP entry and plugin factory

The module exports standard `clap_entry`.

It exposes one CLAP plugin factory containing one instrument descriptor for Surge XT.

The CLAP plugin ID is `org.surge-synth-team.surge-xt`, matching upstream Surge CLAP and the preset-discovery plugin association. This does not imply compatibility with upstream JUCE/CLAP automation IDs; v1 deliberately uses direct Surge engine parameter IDs.

The runtime object graph is deliberately short:

```text
clap_entry
  -> CLAP plugin factory
     -> SurgeClapPlugin
        -> SurgeSynthesizer
           -> surge-common
```

Preset discovery is a sibling factory service rather than a child abstraction under the audio plugin:

```text
CLAP preset-discovery factory
  -> SurgePresetDiscovery
     -> SurgeStorage / bundled preset files
```

This separation is intentional because preset discovery can occur without an instantiated audio plugin.

## 9. SurgeClapPlugin responsibilities

`SurgeClapPlugin` is the only audio/plugin boundary.

It owns:

- the `clap_plugin` callback table;
- the host pointer and any standard host extensions required by v1;
- one `SurgeSynthesizer`;
- the stable parameter index table;
- 32-frame Surge processing state;
- transport/free-running clock state;
- temporary state-load bytes outside the realtime path.

It implements only the CLAP extensions needed by v1:

- core plugin lifecycle;
- `clap.audio-ports`;
- `clap.note-ports`;
- `clap.params`;
- `clap.state`.

Preset discovery is exposed through the CLAP preset-discovery factory, not the instantiated plugin extension table.

## 10. Lifecycle

### 10.1 Construction and init

Plugin creation allocates `SurgeClapPlugin`, but expensive engine setup happens in `init()`.

`init()`:

1. resolves the deterministic WASI resource root;
2. verifies required bundle content is present;
3. constructs `SurgeSynthesizer`;
4. configures sample-independent engine state;
5. builds the parameter index table from `storage.getPatch().param_ptr`;
6. initializes the internal 32-frame processing state.

If required resources are absent or Surge construction fails, `init()` returns false. A partially initialized plugin is never exposed as usable.

### 10.2 Activate

`activate(sample_rate, min_frames, max_frames)` configures Surge for the host sample rate and resets block staging and transport state.

The plugin must accept host process blocks of any size permitted by CLAP, regardless of Surge's internal 32-frame block size.

### 10.3 Start/stop processing

Realtime processing begins only after successful activation. Starting processing performs no filesystem work and allocates no persistent structures.

Stopping processing leaves the plugin in a state where non-realtime state operations remain valid.

### 10.4 Reset

Reset clears note/audio processing state and the partial 32-frame staging position without destroying the Surge instance or parameter metadata.

## 11. Audio processing and the 32-frame Surge boundary

Surge processes fixed 32-frame internal blocks. CLAP does not require hosts to use multiples of 32.

The adaptation is implemented **inside** `SurgeClapPlugin::process()`, not in a separate helper class.

Because v1 has no audio input, the plugin maintains only the smallest persistent state required to span host callbacks:

- current position within the 32-frame Surge block;
- generated Surge output that has not yet been consumed by the current CLAP process call;
- transport position corresponding to the internal block boundary.

The processing algorithm must preserve the semantics proven by upstream Surge's own processor code while remaining independent of JUCE.

Host process sizes such as 1, 7, 31, 32, 33, 64, 127, and 128 frames must all produce continuous audio with no host-visible requirement to align to 32 frames.

No standalone fixed-block adapter abstraction is introduced.

## 12. Event handling

The plugin reads input events in timestamp order.

v1 handles:

- `CLAP_EVENT_NOTE_ON`;
- `CLAP_EVENT_NOTE_OFF`;
- `CLAP_EVENT_NOTE_CHOKE` where directly supported by Surge;
- `CLAP_EVENT_MIDI`;
- `CLAP_EVENT_PARAM_VALUE`.

Unsupported event types are ignored safely.

The implementation must define and test how event timestamps interact with Surge's 32-frame processing boundary. It must match the best timing resolution the Surge engine can actually honor; tests must not claim finer timing than the engine provides.

The v1 implementation does **not** handle:

- `CLAP_EVENT_PARAM_MOD`;
- CLAP note-expression events.

Those remain future additive capabilities.

## 13. Parameters

The parameter table is generated directly from Surge's engine parameter list.

For each engine parameter:

```text
clap_id = SurgeSynthesizer::idForParameter(parameter)
```

No WebVST parameter IDs and no JUCE `ParameterID` hash/mapping are involved.

Any future non-engine parameters, such as macros if exposed separately, must use an explicitly reserved non-overlapping ID range. v1 should avoid adding such synthetic controls unless required.

`clap.params` supplies:

- count;
- metadata;
- current value;
- value-to-text;
- text-to-value where Surge supports it;
- flush.

Parameter value flow is direct:

```text
CLAP param event
  -> engine parameter ID
  -> SurgeSynthesizer::setParameter01()
```

No parameter wrapper objects are required.

Metadata such as stepped/boolean flags, ranges, names, and display text should be derived from Surge's own parameter metadata and formatting logic rather than duplicated tables.

## 14. Transport

When `clap_process.transport` is present, standard CLAP transport fields are mapped into `surge->time_data`, including tempo and musical position where available.

Host transport is authoritative.

When transport is absent, the plugin maintains an internal free-running musical clock using the current Surge patch tempo. This preserves behavior required by freerun LFOs and other time-dependent DSP rather than repeatedly presenting position zero.

The internal clock advances by the exact number of rendered frames at the current sample rate and tempo.

Transport mapping is local plugin implementation logic, not a custom host extension.

## 15. State

`clap.state` uses Surge's native plugin-state bytes directly.

Save:

```text
SurgeSynthesizer::saveRaw()
  -> CLAP ostream
```

Load:

```text
CLAP istream
  -> complete temporary byte buffer
  -> Surge normal queued patch/state loading path
```

There is no WebCLAP-specific envelope, version header, or second serialization schema.

State loading reads the complete incoming stream before handing bytes to Surge. A short or malformed stream must fail without partially applying bytes to the current state.

The implementation should use Surge's normal state-application sequence, including whatever audio-thread-safe handoff is required by the pinned engine revision.

## 16. Preset discovery

v1 exposes standard CLAP preset discovery.

The pinned Surge implementation in `SurgeCLAPPresetDiscovery.cpp` is the semantic reference, but the new project does not depend on `SurgeSynthProcessor` or JUCE to expose it.

`SurgePresetDiscovery.cpp` should directly provide a preset-discovery factory/provider using official CLAP headers.

It should:

- declare the Surge patch file type;
- declare bundled factory and third-party preset locations;
- parse Surge `.fxp` metadata;
- report preset name, creator, description, license/category metadata when present;
- associate presets with the Surge XT CLAP plugin identity.

Malformed individual preset files are reported as discovery errors and do not make the audio plugin unusable.

User preset locations and writing are not required for v1.

Preset loading uses Surge's normal patch-loading mechanism. Preset discovery does not create a second preset/state format.

## 17. Error handling and realtime rules

Initialization failures are explicit and early.

Realtime processing must:

- avoid filesystem access;
- avoid unbounded allocation;
- avoid exceptions crossing CLAP callbacks;
- tolerate unsupported events;
- tolerate legal arbitrary process sizes;
- never depend on JavaScript callbacks.

State and preset parsing occur off the realtime audio path.

Malformed state returns failure rather than silently accepting partial state.

A missing mandatory factory-resource root causes plugin initialization failure with a deterministic diagnostic path for tests.

## 18. Testing strategy

### 18.1 Build and ABI tests

Assert that the produced module:

- is a `wasm32` reactor with no `main()`;
- exports `clap_entry`;
- satisfies the WCLAP memory contract;
- exports exactly one growable function table;
- exports `malloc()` or a compatible allocator entry;
- exposes one plugin descriptor;
- exposes the expected CLAP extensions;
- contains no WebVST exports;
- has no JUCE dependency;
- has no Emscripten runtime dependency;
- contains no developer-specific absolute paths.

### 18.2 Lifecycle tests

Cover:

- entry initialization/deinitialization;
- factory enumeration;
- create/init/destroy;
- activate/deactivate;
- start/stop processing;
- reset;
- repeated instance creation.

### 18.3 Audio block-size tests

Render equivalent material with host blocks of:

- 1;
- 7;
- 31;
- 32;
- 33;
- 64;
- 127;
- 128 frames.

Verify continuous output and deterministic equivalence within the timing behavior actually supported by the Surge engine.

### 18.4 Event tests

Place note and parameter events:

- at frame 0;
- immediately before a Surge 32-frame boundary;
- on the boundary;
- immediately after the boundary;
- across CLAP callback boundaries.

Document and verify the exact event-timing rule.

### 18.5 Parameter tests

Verify:

- every exposed `clap_id` maps to the intended Surge engine parameter;
- IDs are stable for the pinned Surge revision;
- metadata is coherent;
- normalized values round-trip;
- text formatting/parsing matches Surge behavior where supported.

### 18.6 Transport tests

Cover:

- host tempo;
- host PPQ/song position;
- transport discontinuities;
- no host transport;
- freerun clock continuity across CLAP callbacks.

### 18.7 State tests

Perform:

```text
save -> mutate synth -> load -> verify restoration
```

Also test truncated and malformed streams.

### 18.8 Preset-discovery tests

Use known bundled factory patches to verify:

- declared locations;
- file type;
- preset names;
- creators and metadata;
- plugin association;
- malformed file isolation.

### 18.9 Generic WebCLAP smoke test

A generic WebCLAP host must be able to:

1. load the bundle;
2. enumerate the plugin;
3. instantiate it;
4. activate it;
5. send notes;
6. change a parameter;
7. provide transport;
8. save and restore state;
9. discover factory presets;
10. render non-silent audio.

No Surge-specific host code is allowed in this test.

## 19. Determinism and provenance

`PROVENANCE.md` records:

- Surge repository and exact commit;
- CLAP repository and exact commit;
- wasi-sdk release and checksum;
- every local Surge patch and its hash;
- why each patch exists;
- resource provenance;
- license provenance;
- deterministic packaging procedure.

Two clean builds from the same pinned inputs should produce equivalent package contents. Where byte-for-byte archive reproducibility is not guaranteed by the container format, the reproducibility contract must specify which unpacked files and hashes are deterministic.

## 20. Acceptance criteria

The v1 design is accepted when all of the following are true:

1. A clean wasi-sdk build produces a valid `wasm32` WCLAP bundle with `module.wasm` at its root.
2. The module satisfies WebCLAP's `clap_entry`, memory, function-table, and allocator requirements.
3. The module uses official CLAP headers directly.
4. The runtime build contains no JUCE, WebVST SDK, Emscripten runtime, or CLAP helper framework.
5. `SurgeClapPlugin` owns `SurgeSynthesizer` directly.
6. Generic WebCLAP hosting requires no Surge-specific glue.
7. Stereo audio renders correctly for arbitrary legal host process sizes.
8. Notes, MIDI, engine parameters, transport, state, and preset discovery work.
9. Factory resources are ordinary WASI-visible bundle files.
10. State is Surge's native serialized state without an added wrapper schema.
11. Parameter IDs are direct Surge engine IDs.
12. Provenance and dependency pins are complete.
13. The test suite covers the plugin boundary, block adaptation, event timing, state, transport, presets, and a generic host smoke test.

## 21. Design rationale

The central rule is to distinguish **plugin implementation** from **adapter glue**.

Some Surge-specific code is unavoidable: CLAP callbacks must call the Surge engine, Surge's fixed DSP block must be reconciled with arbitrary CLAP frame counts, and Surge state/resources must be surfaced through standard CLAP/WASI facilities.

That code belongs in the plugin itself.

What this design avoids is an additional translation layer around another plugin API. There is no WebVST ABI underneath CLAP, no VST3 or JUCE plugin being hosted internally, no JavaScript protocol translating CLAP into custom calls, and no helper framework wrapping the CLAP ABI.

The intended final shape is therefore:

```text
generic WebCLAP host
  -> standard CLAP/WCLAP ABI
     -> SurgeClapPlugin
        -> SurgeSynthesizer
           -> surge-common
```

That is the cleanliness criterion for the project.
