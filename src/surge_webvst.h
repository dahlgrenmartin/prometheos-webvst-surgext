#pragma once

// Surge XT behind the generic WebVST ABI v1.
//
// <webvst/webvst.h> (vendor/webvst-sdk) is the authoritative declaration of
// every exported symbol; this header adds only the package's own identity and
// the ABI constants the C header leaves to prose in
// vendor/webvst-sdk/docs/abi-v1.md.
//
// The implementation in surge_webvst.cpp re-wraps Surge's SurgeSynthesizer
// directly. It does NOT use the SDK's VST3-to-C adapter (vendor/webvst-sdk/
// src/adapter/**): there is no VST3 binary here to host.

#include <cstdint>

#include <webvst/webvst.h>

namespace surge_webvst
{

/** Reverse-DNS package identity. Also the manifest's `packageId`. */
inline constexpr const char *kPackageId = "org.prometheos.webvst.surgext";

/** The ABI identifier the package manifest declares. */
inline constexpr const char *kAbiId = "webvst-vst3-wasm-1";

/** The immutable Surge XT commit this module is built from (PROVENANCE.md section 1). */
inline constexpr const char *kSurgePin = "2644c613fb729cf2ce924c39dc75cf6a61ee9324";

/**
 * Canonical 128-bit class UID, as exactly 32 lowercase hex characters.
 *
 * Derivation -- deterministic, reproducible from pinned inputs only, with no
 * randomness and no clock:
 *
 *     uid = first 16 bytes of SHA-256(preimage), lowercase hex
 *     preimage = these four fields joined by "\n", with no trailing newline:
 *         "webvst-vst3-wasm-1"
 *         "org.prometheos.webvst.surgext"
 *         "surge:2644c613fb729cf2ce924c39dc75cf6a61ee9324"
 *         "class:0"
 *
 * Every field is a fixed string in this repository or a pinned commit, so the
 * UID changes only when the ABI, the package identity, the Surge pin, or the
 * class index changes -- exactly the events that should mint a new identity.
 * The value is a literal here rather than computed at runtime so the module
 * needs no SHA-256 implementation; tests/abi_surface.test.ts recomputes the
 * digest independently and fails if this literal ever drifts from it.
 */
inline constexpr const char *kClassUid = "cccd91e356478c1bc0c5fe2e269e9094";

/** Display name and vendor for the single exposed class. */
inline constexpr const char *kClassName = "Surge XT";
inline constexpr const char *kClassVendor = "Surge Synth Team";

/**
 * `webvst_class_kind` values. abi-v1.md defines these in prose; webvst.h has no
 * enum for them, so they are named here rather than left as bare literals.
 */
inline constexpr uint32_t kClassKindEffect = 0u;
inline constexpr uint32_t kClassKindInstrument = 1u;

/** Exactly one class: the Surge XT instrument. */
inline constexpr uint32_t kClassCount = 1u;
inline constexpr uint32_t kClassIndex = 0u;

/** Concurrent instance slots. abi-v1.md fixes the handle table at 32. */
inline constexpr uint32_t kMaxInstances = 32u;

} // namespace surge_webvst
