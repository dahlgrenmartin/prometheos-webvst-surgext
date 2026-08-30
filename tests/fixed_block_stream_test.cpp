// Native (host compiler, no Emscripten, no Surge) test for the fixed-block FIFO.
//
// It exercises src/fixed_block_stream.cpp against a deterministic fake 32-frame
// processor that encodes the ABSOLUTE input frame index it is handed into its
// output, applying a fixed invertible transform so a FIFO that forwarded input
// straight to output without ever calling the processor is caught. The FIFO's
// defining property -- the output stream is a pure function of the input stream
// and independent of how calls are partitioned -- is checked by rendering the
// brief's Step-1 partitions ([128], [32]x32, [1]x1024, and a repeating
// [7,13,1,64,3,128]) and asserting every stream is byte-identical once the
// documented 32-frame initial latency is accounted for.
//
// ctest treats a non-zero exit code as failure; main() returns the failure
// count.

#include "fixed_block_stream.h"

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <vector>

namespace
{

int g_failures = 0;

#define CHECK(cond)                                                                                 \
    do                                                                                              \
    {                                                                                              \
        if (!(cond))                                                                                \
        {                                                                                          \
            std::printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond);                             \
            ++g_failures;                                                                           \
        }                                                                                          \
    } while (0)

constexpr uint32_t kBlock = surge_webvst::FixedBlockStream::kBlockFrames; // 32
constexpr uint32_t kTotal = 1024;

// The caller feeds input frame f as (f, f + 0.5). Every value here is a small
// integer or half-integer, exactly representable in float, so all comparisons
// below are exact.
void fillMonotonicInput(std::vector<float> &buffer, uint32_t frames)
{
    buffer.assign(static_cast<size_t>(frames) * 2u, 0.0f);
    for (uint32_t f = 0; f < frames; ++f)
    {
        buffer[f * 2u] = static_cast<float>(f);
        buffer[f * 2u + 1u] = static_cast<float>(f) + 0.5f;
    }
}

// Deterministic fake 32-frame processor.
//
//  * decodes the absolute input frame index from the left channel of the block
//    (the caller encodes it there), and asserts the 32 frames of every block
//    are contiguous and correctly ordered on BOTH channels;
//  * writes output that re-encodes that absolute index through a fixed
//    invertible transform (+1000 on L, +2000 on R) -- a genuine transform, so a
//    FIFO that never called this would produce visibly wrong samples;
//  * counts the blocks it was handed.
struct EncodingProcessor final : surge_webvst::BlockProcessor
{
    uint64_t blocks = 0;
    bool contiguous = true;

    void process32(const float *input, float *output) noexcept override
    {
        const double base = static_cast<double>(input[0]);
        for (uint32_t j = 0; j < kBlock; ++j)
        {
            const double idx = base + static_cast<double>(j);
            if (input[j * 2u] != static_cast<float>(idx) ||
                input[j * 2u + 1u] != static_cast<float>(idx + 0.5))
            {
                contiguous = false;
            }
            output[j * 2u] = static_cast<float>(idx + 1000.0);
            output[j * 2u + 1u] = static_cast<float>(idx + 2000.0);
        }
        ++blocks;
    }
};

// The output the FIFO contract requires, derived from first principles:
//   frames [0, 32)  -> silence (documented initial latency)
//   frames [32, N)  -> EncodingProcessor applied to absolute input frame (k - 32)
float expectedSample(uint32_t frameIndex, int channel)
{
    if (frameIndex < kBlock)
        return 0.0f;
    const double idx = static_cast<double>(frameIndex - kBlock);
    return static_cast<float>(idx + (channel == 0 ? 1000.0 : 2000.0));
}

// Render `total` frames through one FIFO, splitting the span into `partition`
// (repeating). Only the final call is trimmed so the render lands exactly on
// `total`; every interior call uses the partition value verbatim.
std::vector<float> renderPartitioned(const std::vector<uint32_t> &partition, uint32_t total,
                                     EncodingProcessor &processor)
{
    surge_webvst::FixedBlockStream stream;
    std::vector<float> input;
    fillMonotonicInput(input, total);
    std::vector<float> output(static_cast<size_t>(total) * 2u, -1.0f);

    uint32_t done = 0;
    size_t step = 0;
    while (done < total)
    {
        uint32_t want = partition[step % partition.size()];
        if (want > total - done)
            want = total - done;
        stream.process(input.data() + static_cast<size_t>(done) * 2u,
                       output.data() + static_cast<size_t>(done) * 2u, want, processor);
        done += want;
        ++step;
    }
    return output;
}

void testPartitionIndependence()
{
    const std::vector<std::vector<uint32_t>> partitions = {
        {128},                  // [128]
        {32},                   // [32 x 32]
        {1},                    // [1 x 1024]
        {7, 13, 1, 64, 3, 128}, // repeating, ragged (sum 216, does not divide 1024)
    };

    std::vector<float> reference;
    for (size_t p = 0; p < partitions.size(); ++p)
    {
        EncodingProcessor processor;
        std::vector<float> out = renderPartitioned(partitions[p], kTotal, processor);

        CHECK(processor.contiguous);                  // FIFO delivered whole, ordered blocks
        CHECK(processor.blocks == kTotal / kBlock);   // exactly 32 driven blocks for 1024 frames

        for (uint32_t k = 0; k < kTotal; ++k)
        {
            CHECK(out[k * 2u] == expectedSample(k, 0));
            CHECK(out[k * 2u + 1u] == expectedSample(k, 1));
        }

        if (p == 0)
            reference = out;
        else
            CHECK(out == reference); // every partition yields a byte-identical stream
    }
}

// A stream of tiny sub-block calls must accumulate to exactly the same output as
// one big call: the FIFO carries pending input and ready output across calls.
void testSubBlockAccumulation()
{
    surge_webvst::FixedBlockStream streamA;
    surge_webvst::FixedBlockStream streamB;
    EncodingProcessor procA;
    EncodingProcessor procB;

    std::vector<float> input;
    fillMonotonicInput(input, kTotal);
    std::vector<float> outA(static_cast<size_t>(kTotal) * 2u, -1.0f);
    std::vector<float> outB(static_cast<size_t>(kTotal) * 2u, -1.0f);

    streamA.process(input.data(), outA.data(), kTotal, procA); // one call

    for (uint32_t f = 0; f < kTotal; ++f) // 1024 one-frame calls
        streamB.process(input.data() + f * 2u, outB.data() + f * 2u, 1, procB);

    CHECK(outA == outB);
    CHECK(procA.blocks == procB.blocks);
    CHECK(procA.blocks == kTotal / kBlock);
}

// reset() must clear both buffers and rewind both cursors: a render after reset
// reproduces the exact same stream, latency prefix and all.
void testReset()
{
    surge_webvst::FixedBlockStream stream;
    std::vector<float> input;
    fillMonotonicInput(input, kTotal);
    std::vector<float> scratch(static_cast<size_t>(kTotal) * 2u, -1.0f);

    EncodingProcessor warm;
    stream.process(input.data(), scratch.data(), 300, warm); // partially prime the FIFO
    stream.reset();

    EncodingProcessor processor;
    std::vector<float> out(static_cast<size_t>(kTotal) * 2u, -1.0f);
    stream.process(input.data(), out.data(), kTotal, processor);

    CHECK(processor.contiguous);
    CHECK(processor.blocks == kTotal / kBlock);
    for (uint32_t k = 0; k < kTotal; ++k)
    {
        CHECK(out[k * 2u] == expectedSample(k, 0));
        CHECK(out[k * 2u + 1u] == expectedSample(k, 1));
    }
}

// A zero-frame call is a no-op: it must not touch the output or the FIFO state.
void testZeroFrames()
{
    surge_webvst::FixedBlockStream stream;
    EncodingProcessor processor;
    float sentinel[2] = {42.0f, 43.0f};
    stream.process(nullptr, sentinel, 0, processor);
    CHECK(sentinel[0] == 42.0f);
    CHECK(sentinel[1] == 43.0f);
    CHECK(processor.blocks == 0);
}

// A null input is silence: an instrument driven with no main input still
// produces the processor's output for 32 frames of zeros per block.
void testNullInputIsSilence()
{
    surge_webvst::FixedBlockStream stream;

    struct ZeroChecker final : surge_webvst::BlockProcessor
    {
        uint64_t blocks = 0;
        bool allZero = true;
        void process32(const float *input, float *output) noexcept override
        {
            for (uint32_t j = 0; j < kBlock * 2u; ++j)
            {
                if (input[j] != 0.0f)
                    allZero = false;
                output[j] = 7.0f;
            }
            ++blocks;
        }
    } processor;

    std::vector<float> out(static_cast<size_t>(kBlock) * 3u * 2u, -1.0f); // 96 frames
    stream.process(nullptr, out.data(), kBlock * 3u, processor);

    CHECK(processor.allZero);
    CHECK(processor.blocks == 3); // 96 frames == exactly 3 driven 32-frame blocks
    for (uint32_t k = 0; k < kBlock; ++k) // first block: latency, silence
    {
        CHECK(out[k * 2u] == 0.0f);
        CHECK(out[k * 2u + 1u] == 0.0f);
    }
    for (uint32_t k = kBlock; k < kBlock * 3u; ++k) // then the processor's output
    {
        CHECK(out[k * 2u] == 7.0f);
        CHECK(out[k * 2u + 1u] == 7.0f);
    }
}

// A caller may hand the same buffer as input and output (in-place processing).
// Rendering a known partition that way must produce exactly the same stream as
// rendering it with separate buffers, and the processor must still see whole,
// correctly ordered input blocks.
void testInPlaceAliasing()
{
    const std::vector<uint32_t> partition = {7, 13, 1, 64, 3, 128};

    std::vector<float> monotonic;
    fillMonotonicInput(monotonic, kTotal);

    // Separate in/out buffers.
    EncodingProcessor sep;
    std::vector<float> separate(static_cast<size_t>(kTotal) * 2u, -1.0f);
    {
        surge_webvst::FixedBlockStream stream;
        uint32_t done = 0;
        size_t step = 0;
        while (done < kTotal)
        {
            uint32_t want = partition[step % partition.size()];
            if (want > kTotal - done)
                want = kTotal - done;
            stream.process(monotonic.data() + static_cast<size_t>(done) * 2u,
                           separate.data() + static_cast<size_t>(done) * 2u, want, sep);
            done += want;
            ++step;
        }
    }

    // In-place: seed the buffer with the same input, then process buf -> buf.
    EncodingProcessor inplace;
    std::vector<float> aliased = monotonic;
    {
        surge_webvst::FixedBlockStream stream;
        uint32_t done = 0;
        size_t step = 0;
        while (done < kTotal)
        {
            uint32_t want = partition[step % partition.size()];
            if (want > kTotal - done)
                want = kTotal - done;
            float *p = aliased.data() + static_cast<size_t>(done) * 2u;
            stream.process(p, p, want, inplace);
            done += want;
            ++step;
        }
    }

    CHECK(inplace.contiguous);
    CHECK(inplace.blocks == sep.blocks);
    CHECK(inplace.blocks == kTotal / kBlock);
    CHECK(aliased == separate);
}

} // namespace

int main()
{
    testPartitionIndependence();
    testSubBlockAccumulation();
    testReset();
    testZeroFrames();
    testNullInputIsSilence();
    testInPlaceAliasing();

    if (g_failures == 0)
    {
        std::printf("fixed_block_stream_test: OK\n");
        return 0;
    }
    std::printf("fixed_block_stream_test: %d failure(s)\n", g_failures);
    return 1;
}
