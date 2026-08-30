cmake_minimum_required(VERSION 3.20)

# Surge's src/common version-info step reads CMAKE_PROJECT_VERSION_MAJOR and
# CMAKE_PROJECT_VERSION_MINOR, which name the OUTERMOST project() call -- ours,
# because we add_subdirectory() Surge rather than being added by it. Declaring
# Surge's own version here keeps that step correct without patching Surge's
# build tooling. See PROVENANCE.md.
project(surge_webvst VERSION 1.4.0 LANGUAGES CXX)

if(PROJECT_SOURCE_DIR STREQUAL PROJECT_BINARY_DIR)
  message(FATAL_ERROR "Configure into a separate build directory; scripts/build.ts does this for you.")
endif()

if(EMSCRIPTEN)
  # --- WASM module -----------------------------------------------------------
  # The full Surge XT engine behind the WebVST ABI. Only reachable under the
  # Emscripten toolchain (scripts/build.ts sets it up); a bare `cmake -S .` with
  # no toolchain takes the native branch below instead.
  list(APPEND CMAKE_MODULE_PATH "${CMAKE_CURRENT_LIST_DIR}/cmake")
  include(SurgeWebVst)

  # Ruling D: the canonical module name is surgext-webvst.wasm, stable for the
  # packaging tasks downstream. scripts/build.ts copies it to build/.
  surge_webvst_add_module(surgext-webvst)
else()
  # --- Native FIFO test ----------------------------------------------------
  # src/fixed_block_stream.{h,cpp} is deliberately Surge-independent, so its
  # unit test builds and runs with the host compiler alone -- no Emscripten, no
  # Surge, no SDK. `cmake -S . -B build/native` (no toolchain file) configures
  # exactly this one executable and nothing else.
  enable_testing()

  add_executable(fixed_block_stream_test
    "${CMAKE_CURRENT_LIST_DIR}/tests/fixed_block_stream_test.cpp"
    "${CMAKE_CURRENT_LIST_DIR}/src/fixed_block_stream.cpp"
  )
  target_include_directories(fixed_block_stream_test PRIVATE "${CMAKE_CURRENT_LIST_DIR}/src")
  set_target_properties(fixed_block_stream_test PROPERTIES
    CXX_STANDARD 20
    CXX_STANDARD_REQUIRED ON
  )

  add_test(NAME fixed_block_stream COMMAND fixed_block_stream_test)
endif()
