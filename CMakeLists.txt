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

list(APPEND CMAKE_MODULE_PATH "${CMAKE_CURRENT_LIST_DIR}/cmake")
include(SurgeWebVst)

# Ruling D: the canonical module name is surgext-webvst.wasm, stable for the
# packaging tasks downstream. scripts/build.ts copies it to build/.
surge_webvst_add_module(surgext-webvst)
