#include "fixed_block_stream.h"

namespace surge_webvst
{

// -----------------------------------------------------------------------------
// Accumulating fixed-block FIFO with a one-block (32-frame) initial latency.
//
// Per requested frame, in order:
//
//   1. emit one frame of ready output (silence until the first block has run),
//      advancing the read cursor;
//   2. accumulate one input frame into the pending block (zeros when the caller
//      passes no input -- the instrument case), advancing the write cursor;
//   3. once 32 input frames have accumulated, drive the wrapped DSP for exactly
//      one 32-frame block: it consumes `pending_input_` and fills
//      `ready_output_`; both cursors rewind (`pending_frames_ = 0`,
//      `ready_frame_ = 0`).
//
// Because every step is per-frame and all state lives in members, the output is
// a pure function of the input stream and does not depend on how the caller
// partitions its process() calls. No allocation, no exceptions.
// -----------------------------------------------------------------------------
void FixedBlockStream::process(const float *input, float *output, uint32_t frames,
                               BlockProcessor &processor) noexcept
{
    for (uint32_t f = 0; f < frames; ++f)
    {
        // 1. Emit one ready-output frame. While the read cursor is at or past
        //    the block size the FIFO has not produced audio yet: that is the
        //    fixed 32-frame initial latency, emitted as silence.
        if (ready_frame_ < kBlockFrames)
        {
            output[f * 2u] = ready_output_[ready_frame_ * 2u];
            output[f * 2u + 1u] = ready_output_[ready_frame_ * 2u + 1u];
        }
        else
        {
            output[f * 2u] = 0.0f;
            output[f * 2u + 1u] = 0.0f;
        }
        ++ready_frame_;

        // 2. Accumulate one input frame; a null input is silence.
        pending_input_[pending_frames_ * 2u] = input != nullptr ? input[f * 2u] : 0.0f;
        pending_input_[pending_frames_ * 2u + 1u] = input != nullptr ? input[f * 2u + 1u] : 0.0f;
        ++pending_frames_;

        // 3. A whole block has accumulated: drive the DSP once, then rewind.
        if (pending_frames_ == kBlockFrames)
        {
            processor.process32(pending_input_.data(), ready_output_.data());
            pending_frames_ = 0u;
            ready_frame_ = 0u;
        }
    }
}

void FixedBlockStream::reset() noexcept
{
    pending_input_.fill(0.0f);
    ready_output_.fill(0.0f);
    pending_frames_ = 0u;
    ready_frame_ = kBlockFrames;
}

} // namespace surge_webvst
