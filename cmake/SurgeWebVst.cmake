include_guard(GLOBAL)

# Build graph for the Surge XT WebVST module.
#
# This is the JUCE-free Surge engine build proven in the Buzz integration this
# package was extracted from, restated with every Buzz-specific and
# developer-specific path removed. Its only inputs are:
#
#   SURGE_WEBVST_UPSTREAM_DIR - a checkout of the pinned Surge XT commit with
#                               the three provenance patches applied, prepared
#                               by scripts/build.ts from vendor/surge;
#   SURGE_WEBVST_SDK_DIR      - vendor/webvst-sdk (the ABI header and the
#                               authoritative exported-symbol list);
#   this repository's own src/.
#
# Deliberately NOT used: the SDK's prometheos_configure_webvst() helper and its
# VST3-to-C adapter under src/adapter/. That helper hard-requires
# PVST_VST3_SDK_DIR because it wraps a real VST3 plugin binary; this package
# re-wraps Surge's engine directly, so it has no VST3 SDK and cannot call it.
# The SDK offers no no-VST3 variant of the helper, so the link options below
# are applied here instead -- kept deliberately in step with the helper,
# including its PROMETHEOS_WEBVST_WASMFS target-property switch, so the two
# cannot silently diverge.

# This repository's own root, resolved from this module's location so nothing
# depends on where the caller's CMakeLists.txt sits.
get_filename_component(SURGE_WEBVST_SOURCE_DIR "${CMAKE_CURRENT_LIST_DIR}/.." ABSOLUTE)

function(surge_webvst_add_module target)
  if(NOT EMSCRIPTEN)
    message(FATAL_ERROR
      "surge_webvst_add_module requires the Emscripten toolchain. Run scripts/build.ts, "
      "or pass -DCMAKE_TOOLCHAIN_FILE=<emsdk>/upstream/emscripten/cmake/Modules/Platform/Emscripten.cmake")
  endif()

  if(NOT SURGE_WEBVST_UPSTREAM_DIR OR NOT EXISTS "${SURGE_WEBVST_UPSTREAM_DIR}/CMakeLists.txt")
    message(FATAL_ERROR
      "SURGE_WEBVST_UPSTREAM_DIR must point at the prepared Surge XT build checkout. "
      "scripts/build.ts creates it from vendor/surge; do not point it at vendor/surge itself, "
      "which is kept pristine and unpatched.")
  endif()

  if(NOT SURGE_WEBVST_SDK_DIR OR NOT EXISTS "${SURGE_WEBVST_SDK_DIR}/include/prometheos/webvst.h")
    message(FATAL_ERROR
      "SURGE_WEBVST_SDK_DIR must point at the WebVST SDK checkout (vendor/webvst-sdk).")
  endif()

  # The authoritative -sEXPORTED_FUNCTIONS list. Owned by the SDK; never restated here.
  include("${SURGE_WEBVST_SDK_DIR}/cmake/WebVstExports.cmake")

  # --- Narrow the upstream build graph to the JUCE-free DSP engine -------------
  # These are upstream-supported flags (SURGE_SKIP_JUCE_FOR_RACK backs the VCV
  # Rack port), not local patches. See PROVENANCE.md.
  set(SURGE_SKIP_JUCE_FOR_RACK ON CACHE BOOL "" FORCE)
  set(SURGE_SKIP_LUA ON CACHE BOOL "" FORCE)
  set(SURGE_SKIP_ODDSOUND_MTS ON CACHE BOOL "" FORCE)
  set(SURGE_BUILD_TESTRUNNER OFF CACHE BOOL "" FORCE)
  set(SURGE_BUILD_FX OFF CACHE BOOL "" FORCE)
  set(SURGE_BUILD_XT OFF CACHE BOOL "" FORCE)
  set(SURGE_BUILD_CLAP OFF CACHE BOOL "" FORCE)
  set(SURGE_BUILD_RS OFF CACHE BOOL "" FORCE)
  set(SURGE_BUILD_PYTHON_BINDINGS OFF CACHE BOOL "" FORCE)
  set(SURGE_COPY_TO_PRODUCTS OFF CACHE BOOL "" FORCE)
  set(BUILD_TESTING OFF CACHE BOOL "" FORCE)
  set(ENABLE_LTO OFF CACHE BOOL "" FORCE)

  # Surge's own default, pinned explicitly because the ABI depends on it:
  # pvst_process chunks the caller's block into exactly this many frames.
  set(SURGE_COMPILE_BLOCK_SIZE 32 CACHE STRING "" FORCE)

  # wasm32 pointers are 4 bytes, which trips upstream's "32-bit Linux is
  # unsupported" gate (its SIZEOF_VOID_P==4 check). That gate exists for legacy
  # x86-32 alignment/SIMD assumptions, not wasm; this is upstream's own
  # documented escape hatch. See PROVENANCE.md.
  set(SURGE_BUILD_32BIT_LINUX ON CACHE BOOL "" FORCE)

  # zstd's own option() calls silently clear Surge's plain (non-cache)
  # ZSTD_BUILD_STATIC/ZSTD_BUILD_SHARED sets under old CMP0077 behaviour, which
  # produces two library targets both named libzstd.a and a Ninja "multiple
  # rules generate" error. Forcing these as cache entries first makes zstd's
  # option() calls see existing values and leave them alone.
  set(ZSTD_BUILD_STATIC ON CACHE BOOL "" FORCE)
  set(ZSTD_BUILD_SHARED OFF CACHE BOOL "" FORCE)

  add_subdirectory("${SURGE_WEBVST_UPSTREAM_DIR}" "${CMAKE_BINARY_DIR}/surge-upstream")

  # pffft's own portable-fallback #warning becomes a hard error under Surge's
  # inherited -Werror on targets with no x86/ARM SIMD path selected (wasm32 has
  # neither). The scalar fallback it warns about is pffft's normal, correct
  # behaviour here; this only silences the promotion to error.
  if(TARGET pffft)
    target_compile_options(pffft PRIVATE "-Wno-error=#warnings")
  endif()

  add_executable(${target} "${SURGE_WEBVST_SOURCE_DIR}/src/surge_webvst.cpp")
  target_link_libraries(${target} PRIVATE surge::surge-common)
  target_include_directories(${target} PRIVATE
    "${SURGE_WEBVST_SDK_DIR}/include"
    "${SURGE_WEBVST_SOURCE_DIR}/src"
  )
  target_compile_definitions(${target} PRIVATE EMSCRIPTEN NOMINMAX _USE_MATH_DEFINES)
  set_target_properties(${target} PROPERTIES
    CXX_STANDARD 20
    CXX_STANDARD_REQUIRED ON
    OUTPUT_NAME "${target}"
    SUFFIX ".wasm"
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}"
  )

  # SurgeStorage's constructor makes real POSIX filesystem checks while
  # resolving a data/config path. Under -sFILESYSTEM=0 those return errnos
  # libc++'s <filesystem> does not treat as "not found", so it throws -- and
  # this build has no WASM exception handling, so any throw hard-traps. WASMFS
  # is Emscripten's modern, STANDALONE_WASM-compatible virtual filesystem: a
  # real (if empty, in-module) filesystem makes those checks resolve normally,
  # and it needs no host mount and no JS round-trip. See PROVENANCE.md.
  #
  # This is exactly the switch prometheos_configure_webvst() reads, set the way
  # it expects, so an SDK-side helper would produce the same link line.
  set_target_properties(${target} PROPERTIES PROMETHEOS_WEBVST_WASMFS ON)
  get_target_property(_surge_webvst_wasmfs ${target} PROMETHEOS_WEBVST_WASMFS)
  if(_surge_webvst_wasmfs)
    set(_surge_webvst_filesystem -sWASMFS=1)
  else()
    set(_surge_webvst_filesystem -sFILESYSTEM=0)
  endif()

  target_link_options(${target} PRIVATE
    -sSTANDALONE_WASM=1
    --no-entry
    -sERROR_ON_UNDEFINED_SYMBOLS=1
    -sALLOW_MEMORY_GROWTH=1
    # Surge allocates its wavetables and scene state up front; starting below
    # this forces a long chain of growth events during construction.
    -sINITIAL_MEMORY=134217728
    -sSTACK_SIZE=5242880
    ${_surge_webvst_filesystem}
    "-sEXPORTED_FUNCTIONS=${PROMETHEOS_WEBVST_EXPORTS}"
  )
endfunction()
