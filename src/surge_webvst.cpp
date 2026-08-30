#include "surge_webvst.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <string>

#include "Parameter.h"
#include "PatchFileHeaderStructs.h"
#include "SurgeStorage.h"
#include "SurgeSynthesizer.h"

namespace
{

using namespace surge_webvst;

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

/**
 * SurgeStorage's constructor resolves a config/data path before anything else,
 * and its very first step reads `HOME`; when that is null it throws. This build
 * has no WASM exception handling (no -fwasm-exceptions), so a throw anywhere in
 * that call graph is a bare `unreachable` trap with no message and nothing for
 * a host to catch.
 *
 * Hosts differ on what they put in the WASI environment: the SDK's own probe
 * supplies only `PATH=/usr/bin`, other consumers supply `HOME=/`. Rather than
 * depending on any of them -- and rather than patching Surge -- the module
 * supplies its own defaults here. `setenv(..., 0)` never overwrites a value the
 * host did provide, so a host with a real opinion still wins.
 *
 * Called before every SurgeSynthesizer construction, never from a static
 * initialiser: by the time any ABI entry point runs, `_initialize` has already
 * populated the environment from WASI, so there is no ordering hazard here.
 *
 * See PROVENANCE.md, "Runtime construction".
 */
void ensureEnvironment()
{
    static const bool once = []() {
        ::setenv("HOME", "/", 0);
        ::setenv("PATH", "/usr/bin", 0);
        return true;
    }();
    (void)once;
}

// ---------------------------------------------------------------------------
// Instance handles
// ---------------------------------------------------------------------------

/**
 * A handle packs a 1-based slot index in its low 8 bits and a generation
 * counter in the upper 24, so it is never zero for a live instance and a stale
 * handle cannot address a later instance that reused the slot.
 */
struct Slot
{
    SurgeSynthesizer *synth = nullptr;
    uint32_t generation = 0;
    uint32_t maxFrames = 0;
};

std::array<Slot, kMaxInstances> &slots()
{
    static std::array<Slot, kMaxInstances> storage{};
    return storage;
}

constexpr uint32_t kSlotMask = 0xFFu;
constexpr uint32_t kGenerationShift = 8u;
constexpr uint32_t kGenerationMask = 0x00FFFFFFu;

uint32_t makeHandle(uint32_t slotIndex, uint32_t generation)
{
    return ((generation & kGenerationMask) << kGenerationShift) | ((slotIndex + 1u) & kSlotMask);
}

Slot *resolve(uint32_t handle)
{
    if (handle == 0u)
        return nullptr;
    const uint32_t slotIndex = handle & kSlotMask;
    if (slotIndex == 0u || slotIndex > kMaxInstances)
        return nullptr;
    Slot &slot = slots()[slotIndex - 1u];
    if (slot.synth == nullptr)
        return nullptr;
    if (((handle >> kGenerationShift) & kGenerationMask) != (slot.generation & kGenerationMask))
        return nullptr;
    return &slot;
}

// ---------------------------------------------------------------------------
// Class-level parameter metadata
// ---------------------------------------------------------------------------

/**
 * The class metadata entry points take no handle, but Surge has no static
 * parameter table to read: its parameter list only exists on a live
 * SurgeSynthesizer, built by SurgePatch's constructor. The layout is
 * deterministic -- the factory init patch always produces the same parameters,
 * in the same order, with the same ranges and defaults -- so one lazily created
 * synthesizer, never processed and never mutated, is a faithful and stable
 * source for class-level metadata.
 *
 * It is deliberately independent of any live instance: class metadata must
 * describe the class, not whatever patch some instance happens to be holding.
 * It is intentionally never destroyed; it lives as long as the module.
 */
SurgeSynthesizer *metadataSynth()
{
    ensureEnvironment();
    static SurgeSynthesizer *synth = new SurgeSynthesizer(nullptr);
    return synth;
}

/**
 * Parameter IDs are Surge's own stable IDs: the index into SurgePatch's flat
 * `param_ptr` vector (global params, then per-scene params, then global post
 * params). The order is fixed by Surge's patch construction, so an ID means the
 * same parameter for a given Surge pin -- and the pin is part of the class UID,
 * so a pin change mints a new class rather than silently re-numbering.
 */
Parameter *classParam(uint32_t classIndex, uint32_t parameterIndex)
{
    if (classIndex != kClassIndex)
        return nullptr;
    auto &params = metadataSynth()->storage.getPatch().param_ptr;
    if (parameterIndex >= params.size())
        return nullptr;
    return params[parameterIndex];
}

uint32_t classParamCount(uint32_t classIndex)
{
    if (classIndex != kClassIndex)
        return 0u;
    return static_cast<uint32_t>(metadataSynth()->storage.getPatch().param_ptr.size());
}

// ---------------------------------------------------------------------------
// Value conversion
// ---------------------------------------------------------------------------

/**
 * The ABI promises every normalized value is finite and inside [0, 1]. Surge's
 * own f01 conversion divides by (max - min), which is NaN for the handful of
 * degenerate placeholder parameters whose range is a single point, so its
 * result is sanitized rather than trusted.
 */
float sanitizeNormalized(float value)
{
    if (!std::isfinite(value))
        return 0.0f;
    return std::clamp(value, 0.0f, 1.0f);
}

bool isValidNormalized(float value)
{
    return std::isfinite(value) && value >= 0.0f && value <= 1.0f;
}

/**
 * Number of discrete steps: VST3's convention, where a two-state switch is 1
 * and a continuous parameter is 0.
 *
 * Two traps here, both real in Surge's parameter table:
 *
 *  - `ct_none` placeholders (the 193 unassigned FX-slot parameters of the init
 *    patch) carry the full int range, so `val_max.i - val_min.i` overflows a
 *    signed int. They are not steppable controls at all -- they report zero
 *    steps, matching the read-only flag they already carry.
 *  - the subtraction is done in int64 regardless, so no combination of bounds
 *    can overflow.
 */
uint32_t paramStepCount(const Parameter *p)
{
    if (p->ctrltype == ct_none)
        return 0u;
    switch (p->valtype)
    {
    case vt_int:
    {
        const int64_t span =
            static_cast<int64_t>(p->val_max.i) - static_cast<int64_t>(p->val_min.i);
        return span > 0 ? static_cast<uint32_t>(std::min<int64_t>(span, 0xFFFFFFFF)) : 0u;
    }
    case vt_bool:
        return 1u;
    default:
        return 0u;
    }
}

/**
 * A title every host can show. Surge's full name carries the control group
 * ("A Osc 1 Pitch"), which disambiguates the many same-named parameters across
 * scenes and slots; the shorter display name and the internal name are
 * fallbacks so no parameter is ever unnamed.
 */
std::string paramTitle(const Parameter *p)
{
    const char *candidates[] = {p->get_full_name(), p->get_name(), p->get_internal_name()};
    for (const char *candidate : candidates)
    {
        if (candidate != nullptr && candidate[0] != '\0')
            return std::string(candidate);
    }
    return "Parameter " + std::to_string(p->id);
}

// ---------------------------------------------------------------------------
// String returns
// ---------------------------------------------------------------------------

/**
 * The ABI's string convention: `*_size` reports the UTF-8 byte length with no
 * terminating NUL, `*_write` writes exactly that many bytes. A null
 * destination or an insufficient capacity is PVST_ERROR_BUFFER_TOO_SMALL; an
 * invalid index is PVST_ERROR_ARGUMENT and is therefore checked by the caller
 * before this runs.
 */
int32_t writeString(const std::string &value, char *dst, uint32_t capacity)
{
    if (dst == nullptr || capacity < value.size())
        return PVST_ERROR_BUFFER_TOO_SMALL;
    if (!value.empty())
        std::memcpy(dst, value.data(), value.size());
    return PVST_OK;
}

} // namespace

extern "C"
{

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

uint32_t pvst_abi_version(void) { return PVST_ABI_VERSION; }

uint32_t pvst_class_count(void) { return kClassCount; }

uint32_t pvst_class_uid_size(uint32_t class_index)
{
    return class_index == kClassIndex ? static_cast<uint32_t>(std::strlen(kClassUid)) : 0u;
}

int32_t pvst_class_uid_write(uint32_t class_index, char *dst, uint32_t capacity)
{
    if (class_index != kClassIndex)
        return PVST_ERROR_ARGUMENT;
    return writeString(kClassUid, dst, capacity);
}

uint32_t pvst_class_name_size(uint32_t class_index)
{
    return class_index == kClassIndex ? static_cast<uint32_t>(std::strlen(kClassName)) : 0u;
}

int32_t pvst_class_name_write(uint32_t class_index, char *dst, uint32_t capacity)
{
    if (class_index != kClassIndex)
        return PVST_ERROR_ARGUMENT;
    return writeString(kClassName, dst, capacity);
}

uint32_t pvst_class_vendor_size(uint32_t class_index)
{
    return class_index == kClassIndex ? static_cast<uint32_t>(std::strlen(kClassVendor)) : 0u;
}

int32_t pvst_class_vendor_write(uint32_t class_index, char *dst, uint32_t capacity)
{
    if (class_index != kClassIndex)
        return PVST_ERROR_ARGUMENT;
    return writeString(kClassVendor, dst, capacity);
}

uint32_t pvst_class_kind(uint32_t class_index)
{
    return class_index == kClassIndex ? kClassKindInstrument : kClassKindEffect;
}

uint32_t pvst_class_param_count(uint32_t class_index) { return classParamCount(class_index); }

uint32_t pvst_class_param_id(uint32_t class_index, uint32_t parameter_index)
{
    return classParam(class_index, parameter_index) != nullptr ? parameter_index : 0u;
}

/**
 * Only the two bits the ABI exposes. Surge's placeholder parameters (ct_none)
 * carry no value a host can meaningfully drive, so they are reported read-only;
 * every real parameter is automatable.
 */
uint32_t pvst_class_param_flags(uint32_t class_index, uint32_t parameter_index)
{
    const Parameter *p = classParam(class_index, parameter_index);
    if (p == nullptr)
        return 0u;
    return p->ctrltype == ct_none ? PVST_PARAMETER_READ_ONLY : PVST_PARAMETER_AUTOMATABLE;
}

uint32_t pvst_class_param_step_count(uint32_t class_index, uint32_t parameter_index)
{
    const Parameter *p = classParam(class_index, parameter_index);
    return p != nullptr ? paramStepCount(p) : 0u;
}

float pvst_class_param_default(uint32_t class_index, uint32_t parameter_index)
{
    const Parameter *p = classParam(class_index, parameter_index);
    return p != nullptr ? sanitizeNormalized(p->get_default_value_f01()) : 0.0f;
}

uint32_t pvst_class_param_title_size(uint32_t class_index, uint32_t parameter_index)
{
    const Parameter *p = classParam(class_index, parameter_index);
    return p != nullptr ? static_cast<uint32_t>(paramTitle(p).size()) : 0u;
}

int32_t pvst_class_param_title_write(uint32_t class_index, uint32_t parameter_index, char *dst,
                                     uint32_t capacity)
{
    const Parameter *p = classParam(class_index, parameter_index);
    if (p == nullptr)
        return PVST_ERROR_ARGUMENT;
    return writeString(paramTitle(p), dst, capacity);
}

/**
 * The label Surge would show for a normalized value, without touching the
 * parameter: Surge's own get_display(external = true, ef = normalized) formats
 * `ef` rather than the stored value, so the metadata synthesizer stays pristine
 * and this is safe to call for every step of a discrete parameter.
 */
uint32_t pvst_class_param_value_text_size(uint32_t class_index, uint32_t parameter_index,
                                          float normalized)
{
    const Parameter *p = classParam(class_index, parameter_index);
    if (p == nullptr || !isValidNormalized(normalized))
        return 0u;
    return static_cast<uint32_t>(p->get_display(true, normalized).size());
}

int32_t pvst_class_param_value_text_write(uint32_t class_index, uint32_t parameter_index,
                                          float normalized, char *dst, uint32_t capacity)
{
    const Parameter *p = classParam(class_index, parameter_index);
    if (p == nullptr || !isValidNormalized(normalized))
        return PVST_ERROR_ARGUMENT;
    return writeString(p->get_display(true, normalized), dst, capacity);
}

// ---------------------------------------------------------------------------
// Instance lifetime
// ---------------------------------------------------------------------------

uint32_t pvst_create(uint32_t class_index, double sample_rate, uint32_t max_frames)
{
    if (class_index != kClassIndex)
        return 0u;
    if (!std::isfinite(sample_rate) || sample_rate <= 0.0)
        return 0u;
    if (max_frames == 0u || max_frames > PVST_MAX_PROCESS_FRAMES)
        return 0u;

    auto &table = slots();
    uint32_t slotIndex = kMaxInstances;
    for (uint32_t i = 0; i < kMaxInstances; ++i)
    {
        if (table[i].synth == nullptr)
        {
            slotIndex = i;
            break;
        }
    }
    if (slotIndex == kMaxInstances)
        return 0u;

    ensureEnvironment();
    auto *synth = new SurgeSynthesizer(nullptr);
    synth->setSamplerate(static_cast<float>(sample_rate));

    table[slotIndex].synth = synth;
    table[slotIndex].maxFrames = max_frames;
    table[slotIndex].generation = (table[slotIndex].generation + 1u) & kGenerationMask;
    return makeHandle(slotIndex, table[slotIndex].generation);
}

void pvst_destroy(uint32_t handle)
{
    Slot *slot = resolve(handle);
    if (slot == nullptr)
        return; // destroying an invalid handle is a no-op
    delete slot->synth;
    slot->synth = nullptr;
    slot->maxFrames = 0u;
}

int32_t pvst_reset(uint32_t handle)
{
    Slot *slot = resolve(handle);
    if (slot == nullptr)
        return PVST_ERROR_HANDLE;
    slot->synth->allNotesOff();
    return PVST_OK;
}

/**
 * Surge's engine runs on a compile-time fixed block (SURGE_COMPILE_BLOCK_SIZE,
 * 32), so this loops whole Surge blocks over the caller's buffer. Frame counts
 * that are not a multiple of that block are rejected rather than silently
 * mis-rendered; a later task adds the FIFO that generalises this to arbitrary
 * block sizes.
 */
int32_t pvst_process(uint32_t handle, const float *input, float *output, uint32_t frames)
{
    Slot *slot = resolve(handle);
    if (slot == nullptr)
        return PVST_ERROR_HANDLE;
    if (output == nullptr)
        return PVST_ERROR_ARGUMENT;
    if (frames > slot->maxFrames || frames > PVST_MAX_PROCESS_FRAMES)
        return PVST_ERROR_FRAME_COUNT;

    SurgeSynthesizer *synth = slot->synth;
    const int blockSize = synth->getBlockSize();
    if (blockSize <= 0)
        return PVST_ERROR_PLUGIN;
    if (frames % static_cast<uint32_t>(blockSize) != 0u)
        return PVST_ERROR_FRAME_COUNT;

    uint32_t done = 0u;
    while (done < frames)
    {
        for (int i = 0; i < blockSize; ++i)
        {
            const uint32_t frame = done + static_cast<uint32_t>(i);
            // A null input is silence: the normal instrument case.
            synth->input[0][i] = input != nullptr ? input[frame * 2u] : 0.0f;
            synth->input[1][i] = input != nullptr ? input[frame * 2u + 1u] : 0.0f;
        }
        synth->process();
        for (int i = 0; i < blockSize; ++i)
        {
            const uint32_t frame = done + static_cast<uint32_t>(i);
            output[frame * 2u] = synth->output[0][i];
            output[frame * 2u + 1u] = synth->output[1][i];
        }
        done += static_cast<uint32_t>(blockSize);
    }
    return PVST_OK;
}

int32_t pvst_note_on(uint32_t handle, int32_t note, float velocity)
{
    Slot *slot = resolve(handle);
    if (slot == nullptr)
        return PVST_ERROR_HANDLE;
    if (note < 0 || note > 127)
        return PVST_ERROR_ARGUMENT;
    if (!std::isfinite(velocity) || velocity < 0.0f || velocity > 1.0f)
        return PVST_ERROR_ARGUMENT;
    const auto midiVelocity = static_cast<char>(std::lround(velocity * 127.0f));
    slot->synth->playNote(0, static_cast<char>(note), midiVelocity, 0);
    return PVST_OK;
}

int32_t pvst_note_off(uint32_t handle, int32_t note)
{
    Slot *slot = resolve(handle);
    if (slot == nullptr)
        return PVST_ERROR_HANDLE;
    if (note < 0 || note > 127)
        return PVST_ERROR_ARGUMENT;
    slot->synth->releaseNote(0, static_cast<char>(note), 0);
    return PVST_OK;
}

// ---------------------------------------------------------------------------
// Parameters on a live instance
// ---------------------------------------------------------------------------

/**
 * Values crossing the ABI are normalized 0..1. Surge's own getParameter01 /
 * setParameter01 are the conversion, reached through SurgeSynthesizer::ID --
 * the public accessor for the same flat patch-parameter index this ABI uses as
 * its stable parameter ID (the raw `long` overloads are private). ID
 * construction via fromSynthSideId is also Surge's own range check, over
 * n_total_params, which is exactly param_ptr's size.
 *
 * setParameter01 additionally runs Surge's dependent-control refresh for the
 * parameters that need it, which a raw write into Parameter::val would skip.
 */
float pvst_param_get(uint32_t handle, uint32_t parameter_id)
{
    Slot *slot = resolve(handle);
    if (slot == nullptr)
        return 0.0f;
    SurgeSynthesizer::ID id;
    if (!slot->synth->fromSynthSideId(static_cast<int>(parameter_id), id))
        return 0.0f;
    return sanitizeNormalized(slot->synth->getParameter01(id));
}

int32_t pvst_param_set(uint32_t handle, uint32_t parameter_id, float normalized)
{
    Slot *slot = resolve(handle);
    if (slot == nullptr)
        return PVST_ERROR_HANDLE;
    SurgeSynthesizer::ID id;
    if (parameter_id > static_cast<uint32_t>(INT32_MAX) ||
        !slot->synth->fromSynthSideId(static_cast<int>(parameter_id), id))
        return PVST_ERROR_ARGUMENT;
    if (!isValidNormalized(normalized))
        return PVST_ERROR_ARGUMENT;
    slot->synth->setParameter01(id, normalized);
    return PVST_OK;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/**
 * State is Surge's own patch blob ("sub3" + patch_header + payload), exactly
 * what saveRaw produces and loadRaw consumes, and exactly what a Surge .fxp
 * carries once its VST2 wrapper is stripped -- which is what lets the preset
 * task hand factory patches straight to pvst_state_load.
 *
 * SurgePatch::save_patch() reallocates and owns a single `patchptr` member
 * across calls (freed on the next save_patch() or by SurgePatch's destructor):
 * the returned pointer must never be freed here. Calling saveRaw() twice (once
 * for the size, once to write) is redundant but safe -- it reallocates that
 * same owned buffer with identical contents, since nothing mutates the patch in
 * between.
 */
uint32_t pvst_state_size(uint32_t handle)
{
    Slot *slot = resolve(handle);
    if (slot == nullptr)
        return 0u;
    void *data = nullptr;
    return slot->synth->saveRaw(&data);
}

int32_t pvst_state_write(uint32_t handle, uint8_t *dst, uint32_t capacity)
{
    Slot *slot = resolve(handle);
    if (slot == nullptr)
        return PVST_ERROR_HANDLE;
    void *data = nullptr;
    const uint32_t size = slot->synth->saveRaw(&data);
    if (data == nullptr)
        return PVST_ERROR_PLUGIN;
    if (dst == nullptr || capacity < size)
        return PVST_ERROR_BUFFER_TOO_SMALL;
    std::memcpy(dst, data, size);
    return PVST_OK;
}

/**
 * SurgeSynthesizer::loadRaw() unconditionally resets the live patch to defaults
 * before parsing, so calling it on unvalidated input would corrupt the active
 * patch even when Surge's own parser then bails out. Replicating load_patch()'s
 * header/size precondition here, before ever calling loadRaw(), keeps a
 * malformed blob from touching live state at all.
 *
 * This does not protect against a well-formed header wrapping internally
 * corrupt data; Surge's patch parser makes no such guarantee, and reproducing
 * one is out of scope for this wrapper. Hosts must treat state as untrusted
 * (see the SDK's security model).
 */
int32_t pvst_state_load(uint32_t handle, const uint8_t *src, uint32_t size)
{
    Slot *slot = resolve(handle);
    if (slot == nullptr)
        return PVST_ERROR_HANDLE;
    if (src == nullptr)
        return PVST_ERROR_ARGUMENT;
    if (size < sizeof(sst::io::patch_header))
        return PVST_ERROR_ARGUMENT;
    if (std::memcmp(src, "sub3", 4) != 0)
        return PVST_ERROR_ARGUMENT;
    slot->synth->loadRaw(src, static_cast<int>(size), false);
    return PVST_OK;
}

} // extern "C"
