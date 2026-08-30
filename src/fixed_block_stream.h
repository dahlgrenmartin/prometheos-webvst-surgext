#pragma once

// A sample-accurate fixed-block FIFO.
//
// Surge XT's engine only ever runs in exact 32-frame blocks (its compile-time
// SURGE_COMPILE_BLOCK_SIZE), but a host may ask the WebVST ABI to process any
// 0..128-frame span. This FIFO bridges the two: it accepts an arbitrary number
// of interleaved stereo frames per call and drives an injected "process exactly
// 32 interleaved stereo frames" operation only on whole 32-frame boundaries,
// carrying the unconsumed remainder across calls.
//
// It is deliberately Surge-independent -- it names no Surge type -- so it can be
// unit-tested natively (host compiler, no Emscripten, no Surge) against a
// deterministic fake block processor. src/surge_webvst.cpp supplies the real
// operation: SurgeSynthesizer::process() over synth->input / synth->output.
//
// Design -- the package's fixed-latency ACCUMULATING variant:
//
//   * Output is delayed by exactly one 32-frame block. The first 32 output
//     frames after construction or reset() are silence; from then on every
//     output frame is the block processor's output for the input frame that
//     entered the FIFO 32 positions earlier.
//   * The output stream is a pure function of the input stream and is entirely
//     independent of how the caller partitions its calls: [128], [32]x4,
//     [1]x128 and any ragged mix all yield identical samples.
//   * process() never allocates and never throws.

#include <array>
#include <cstdint>

namespace surge_webvst
{

/**
 * The exact block size the wrapped DSP is driven at. Fixed at compile time:
 * this module builds Surge with SURGE_COMPILE_BLOCK_SIZE == 32, and the ABI's
 * class UID is a function of the Surge pin, so this is a constant rather than a
 * runtime query.
 */
inline constexpr uint32_t kFixedBlockFrames = 32u;

/**
 * The operation the FIFO drives on every whole 32-frame boundary. `input` and
 * `output` each point at exactly `kFixedBlockFrames * 2` interleaved stereo
 * floats (L, R, L, R, ...). Implementations must not throw.
 */
struct BlockProcessor
{
    virtual void process32(const float *input, float *output) noexcept = 0;

  protected:
    ~BlockProcessor() = default;
};

class FixedBlockStream
{
  public:
    /** Frames per driven block; mirrors kFixedBlockFrames for callers that only see the class. */
    static constexpr uint32_t kBlockFrames = kFixedBlockFrames;

    /**
     * Fill `output` with `frames` interleaved stereo frames pulled from the
     * FIFO, invoking `processor.process32` exactly once per 32 accumulated
     * input frames. `input`, when non-null, is `frames` interleaved stereo
     * frames of effect input; a null `input` accumulates silence (the
     * instrument case -- Surge XT here has no main input). `input == output`
     * (in-place processing) is supported: each frame's input is read before its
     * output is written. `frames` may be any value, including 0. Never
     * allocates, never throws.
     */
    void process(const float *input, float *output, uint32_t frames,
                 BlockProcessor &processor) noexcept;

    /**
     * Drop all buffered audio and return to the initial 32-frame-latency state:
     * both interleaved buffers are zeroed and both cursors are rewound
     * (`pending_frames_ = 0`, `ready_frame_ = kBlockFrames`).
     */
    void reset() noexcept;

  private:
    std::array<float, kBlockFrames * 2> pending_input_{};
    std::array<float, kBlockFrames * 2> ready_output_{};
    uint32_t pending_frames_ = 0u;
    uint32_t ready_frame_ = kBlockFrames;
};

} // namespace surge_webvst
