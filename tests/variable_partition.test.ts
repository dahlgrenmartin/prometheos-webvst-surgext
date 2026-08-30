import { describe, it, expect, beforeAll } from "vitest";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Variable-partition equivalence for the Surge XT WebVST module.
 *
 * Task 3 puts a sample-accurate fixed-block FIFO in front of Surge's engine so
 * `pvst_process` accepts any 0..128-frame host block while still driving Surge
 * only in exact 32-frame blocks. The property that buys is: the output stream
 * is a pure function of the input and does NOT depend on how the host chops its
 * calls.
 *
 * This suite proves that on the real built module. It loads factory preset
 * category 0 / preset 0, holds one very low note continuously, and renders the
 * same span three ways -- exact 32-frame calls, one Buzz-like ragged partition
 * (`[7,13,1,64,3,128]` repeating), and the largest legal 128-frame call -- then
 * asserts the three output streams are byte-identical sample-for-sample once the
 * documented, fixed 32-frame FIFO latency is skipped. No onset masking, no
 * click/fade filter: only the first 32 frames (the latency the FIFO is defined
 * to introduce) are excluded.
 *
 * Against the Task-2 module this is RED: `pvst_process` there rejects any frame
 * count that is not a multiple of 32 (`PVST_ERROR_FRAME_COUNT`). After Step 5's
 * rebuild it is GREEN.
 */

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const modulePath = join(repoRoot, "build", "surgext-webvst.wasm");
const factoryPatchesDir = join(repoRoot, "vendor", "surge", "resources", "data", "patches_factory");

const PVST_OK = 0;

const CHANNELS = 2;
/** The FIFO's defining initial latency, in frames. Task 3 fixes this at one 32-frame block. */
const FIFO_LATENCY_FRAMES = 32;
const SAMPLE_RATE = 48_000;
const MAX_FRAMES = 128;
/** A very low MIDI note: a long wavelength, so any dropped or duplicated sample at a call boundary shows up. */
const LOW_NOTE = 12;
const TOTAL_FRAMES = 2048;
/** The reference: exact 32-frame host calls, the size Surge's engine block already is. */
const BLOCKS_32_PARTITION = [32];
/** Buzz supplies arbitrary sub-block spans around tick boundaries. */
const RAGGED_PARTITION = [7, 13, 1, 64, 3, 128];
/** The largest single call the ABI accepts (PVST_MAX_PROCESS_FRAMES). */
const MAX_BLOCK_PARTITION = [128];

// Exactly the import surface tests/abi_surface.test.ts uses: the SDK probe's
// allowlist, `PATH=/usr/bin` and nothing else in the environment, deterministic
// (all-zero) randomness, `_initialize` before any ABI call.
const ENVIRONMENT_BYTES = new Uint8Array([80, 65, 84, 72, 61, 47, 117, 115, 114, 47, 98, 105, 110, 0]);

interface AbiInstance {
  readonly memory: WebAssembly.Memory;
  readonly fn: (name: string) => (...args: number[]) => number;
  malloc(size: number): number;
  free(pointer: number): void;
  bytes(): Uint8Array;
}

let wasmModule: WebAssembly.Module;

function instantiate(): AbiInstance {
  let memory: WebAssembly.Memory | undefined;
  const bytes = () => (memory ? new Uint8Array(memory.buffer) : undefined);
  const view = () => (memory ? new DataView(memory.buffer) : undefined);
  const writeU32 = (pointer: number, value: number) => view()?.setUint32(pointer, value >>> 0, true);

  const imports: WebAssembly.Imports = {
    env: {
      __cxa_rethrow() {
        throw new Error("the WebVST module rethrew a C++ exception");
      },
      emscripten_notify_memory_growth() {
        /* views are recreated on every access */
      },
    },
    wasi_snapshot_preview1: {
      clock_time_get(_clock: number, _precision: number, result: number) {
        writeU32(result, 0);
        writeU32(result + 4, 0);
        return 0;
      },
      fd_read(_fd: number, _iovecs: number, _count: number, result: number) {
        writeU32(result, 0);
        return 0;
      },
      fd_write(_fd: number, iovecs: number, count: number, result: number) {
        const data = view();
        let length = 0;
        if (data) for (let i = 0; i < count; i += 1) length += data.getUint32(iovecs + i * 8 + 4, true);
        writeU32(result, length);
        return 0;
      },
      environ_get(pointer: number, buffer: number) {
        const data = bytes();
        if (data) {
          writeU32(pointer, buffer);
          data.set(ENVIRONMENT_BYTES, buffer);
        }
        return 0;
      },
      environ_sizes_get(count: number, size: number) {
        writeU32(count, 1);
        writeU32(size, ENVIRONMENT_BYTES.byteLength);
        return 0;
      },
      random_get(pointer: number, length: number) {
        bytes()?.fill(0, pointer, pointer + length);
        return 0;
      },
    },
  };

  const instance = new WebAssembly.Instance(wasmModule, imports);
  const exports = instance.exports as Record<string, unknown>;
  if (!(exports.memory instanceof WebAssembly.Memory)) throw new Error("missing ABI export: memory");
  memory = exports.memory;

  const fn = (name: string) => {
    const value = exports[name];
    if (typeof value !== "function") throw new Error(`missing ABI export: ${name}`);
    return value as (...args: number[]) => number;
  };

  fn("_initialize")();

  return {
    memory,
    fn,
    malloc: (size) => fn("malloc")(size) >>> 0,
    free: (pointer) => void fn("free")(pointer),
    bytes: () => new Uint8Array(memory!.buffer),
  };
}

/** Recursively list every file under `dir`, returned as absolute paths. */
function listFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRecursive(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/**
 * The minimal preset payload for this test -- NOT Task 4's packer. Sort the
 * factory category directories, take index 0; read that category recursively,
 * keep `*.fxp`, sort, take index 0; strip the 60-byte VST2 FXP wrapper inline
 * and return the Surge patch payload (`sub3` + header + data) that
 * `pvst_state_load` consumes.
 */
function firstFactoryPresetPayload(): { category: string; preset: string; payload: Uint8Array } {
  const categories = readdirSync(factoryPatchesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  expect(categories.length).toBeGreaterThan(0);
  const category = categories[0];

  const fxps = listFilesRecursive(join(factoryPatchesDir, category))
    .filter((path) => path.toLowerCase().endsWith(".fxp"))
    .sort();
  expect(fxps.length).toBeGreaterThan(0);
  const presetPath = fxps[0];

  const fxp = readFileSync(presetPath);
  const ascii = (start: number, end: number) => fxp.toString("latin1", start, end);
  expect(ascii(0, 4)).toBe("CcnK"); // VST2 chunk envelope
  expect(ascii(8, 12)).toBe("FPCh"); // opaque-chunk program
  expect(ascii(16, 20)).toBe("cjs3"); // Surge's plugin unique id
  const payload = new Uint8Array(fxp.subarray(60)); // fixed 60-byte fxProgram header
  expect(new TextDecoder().decode(payload.subarray(0, 4))).toBe("sub3"); // Surge patch envelope

  return { category, preset: presetPath.slice(join(factoryPatchesDir, category).length + 1), payload };
}

/** A fresh instrument on a fresh handle: preset loaded, one low note held, nothing rendered yet. */
function newVoice(abi: AbiInstance, payload: Uint8Array): number {
  const handle = abi.fn("pvst_create")(0, SAMPLE_RATE, MAX_FRAMES) >>> 0;
  expect(handle, "pvst_create").not.toBe(0);

  const statePtr = abi.malloc(payload.length);
  expect(statePtr, "malloc(state)").not.toBe(0);
  try {
    abi.bytes().set(payload, statePtr);
    expect(abi.fn("pvst_state_load")(handle, statePtr, payload.length), "pvst_state_load").toBe(PVST_OK);
  } finally {
    abi.free(statePtr);
  }

  expect(abi.fn("pvst_note_on")(handle, LOW_NOTE, 1.0), "pvst_note_on").toBe(PVST_OK);
  return handle;
}

/**
 * Render `TOTAL_FRAMES` interleaved stereo frames from `handle`, chopping the
 * span into `partition` (repeating). Only the final call is trimmed so the
 * render lands exactly on `TOTAL_FRAMES`. Every `pvst_process` call must return
 * `PVST_OK` -- on a module that still requires 32-frame host blocks, a call of 7
 * frames returns `PVST_ERROR_FRAME_COUNT` and this fails.
 */
function render(abi: AbiInstance, handle: number, partition: number[]): Float32Array {
  const out = new Float32Array(TOTAL_FRAMES * CHANNELS);
  const scratch = abi.malloc(MAX_FRAMES * CHANNELS * 4);
  expect(scratch, "malloc(scratch)").not.toBe(0);
  try {
    let done = 0;
    let step = 0;
    while (done < TOTAL_FRAMES) {
      let want = partition[step % partition.length];
      if (want > TOTAL_FRAMES - done) want = TOTAL_FRAMES - done;
      const rc = abi.fn("pvst_process")(handle, 0, scratch, want);
      expect(rc, `pvst_process(frames=${want})`).toBe(PVST_OK);
      out.set(new Float32Array(abi.memory.buffer, scratch, want * CHANNELS), done * CHANNELS);
      done += want;
      step += 1;
    }
  } finally {
    abi.free(scratch);
  }
  return out;
}

beforeAll(async () => {
  if (!existsSync(modulePath)) {
    throw new Error("build/surgext-webvst.wasm is missing. Build it first: pnpm run build.");
  }
  const bytes = readFileSync(modulePath);
  wasmModule = await WebAssembly.compile(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  );
}, 120_000);

describe("Surge XT WebVST arbitrary host-block partitioning", () => {
  it("drives factory preset 0/0 identically for every host-call partition", () => {
    const abi = instantiate();
    const { category, preset, payload } = firstFactoryPresetPayload();
    // eslint-disable-next-line no-console
    console.log(`variable_partition: factory preset "${category}/${preset}", ${payload.length}-byte payload`);

    // Three independent voices from identical fresh state -- the engine is
    // deterministic here (clock shim returns 0, so Surge's per-instance
    // clock-seeded RNG seeds identically; randomness shim returns zeros) -- each
    // rendered with a different host-call partition.
    const h32 = newVoice(abi, payload);
    const hRagged = newVoice(abi, payload);
    const hMax = newVoice(abi, payload);
    try {
      const blocks32 = render(abi, h32, BLOCKS_32_PARTITION);
      const ragged = render(abi, hRagged, RAGGED_PARTITION);
      const maxBlocks = render(abi, hMax, MAX_BLOCK_PARTITION);

      const latency = FIFO_LATENCY_FRAMES * CHANNELS;

      // The documented initial latency: the first 32 output frames are silence in
      // every partition (the FIFO has not driven a block yet). This is the ONLY
      // region excluded from the sample-for-sample comparison below.
      for (let i = 0; i < latency; i += 1) {
        expect(blocks32[i], `blocks32 latency sample ${i}`).toBe(0);
        expect(ragged[i], `ragged latency sample ${i}`).toBe(0);
        expect(maxBlocks[i], `maxBlocks latency sample ${i}`).toBe(0);
      }

      // The preset actually makes sound past the latency window, so the equality
      // below is a real comparison and not silence-against-silence.
      let peak = 0;
      for (let i = latency; i < blocks32.length; i += 1) peak = Math.max(peak, Math.abs(blocks32[i]));
      expect(peak, "post-latency peak of the 32-frame reference render").toBeGreaterThan(1e-4);

      // Sample-for-sample identity across every partition, onset transient
      // included -- nothing masked, nothing faded. Only the 32-frame latency
      // prefix skipped above is excluded.
      const firstDiff = (candidate: Float32Array, label: string) => {
        for (let i = latency; i < blocks32.length; i += 1) {
          if (!Object.is(candidate[i], blocks32[i])) {
            return `${label}: first divergence at sample ${i} (frame ${i >> 1}): ` +
              `reference ${blocks32[i]} vs candidate ${candidate[i]}`;
          }
        }
        return "";
      };
      expect(firstDiff(ragged, "ragged [7,13,1,64,3,128] repeating"), "ragged vs 32-frame calls").toBe("");
      expect(firstDiff(maxBlocks, "max 128-frame blocks"), "128-frame blocks vs 32-frame calls").toBe("");
    } finally {
      for (const handle of [h32, hRagged, hMax]) abi.fn("pvst_destroy")(handle);
    }
  }, 60_000);

  it("re-primes the FIFO on state load and on reset so pre-change audio cannot leak", () => {
    const abi = instantiate();
    const { payload } = firstFactoryPresetPayload();

    const handle = abi.fn("pvst_create")(0, SAMPLE_RATE, MAX_FRAMES) >>> 0;
    expect(handle, "pvst_create").not.toBe(0);
    const scratch = abi.malloc(MAX_FRAMES * CHANNELS * 4);
    expect(scratch, "malloc(scratch)").not.toBe(0);

    const process = (frames: number) => {
      expect(abi.fn("pvst_process")(handle, 0, scratch, frames), `pvst_process(${frames})`).toBe(PVST_OK);
      return Array.from(new Float32Array(abi.memory.buffer, scratch, frames * CHANNELS));
    };
    const peakOf = (buf: number[]) => buf.reduce((m, s) => Math.max(m, Math.abs(s)), 0);
    const loadState = () => {
      const p = abi.malloc(payload.length);
      expect(p, "malloc(state)").not.toBe(0);
      try {
        abi.bytes().set(payload, p);
        expect(abi.fn("pvst_state_load")(handle, p, payload.length), "pvst_state_load").toBe(PVST_OK);
      } finally {
        abi.free(p);
      }
    };

    try {
      // Fill the FIFO with real buffered tail audio (its ready block is non-zero).
      expect(abi.fn("pvst_note_on")(handle, 60, 1.0), "pvst_note_on").toBe(PVST_OK);
      let tail: number[] = [];
      for (let i = 0; i < 8; i += 1) tail = process(128);
      expect(peakOf(tail), "FIFO holds real buffered audio before the state change").toBeGreaterThan(1e-4);

      // A successful state load must clear the stream: the next 32 output frames
      // are the FIFO's silent re-prime, NOT the previous patch's buffered tail.
      loadState();
      expect(
        process(FIFO_LATENCY_FRAMES).every((s) => s === 0),
        "32 frames after pvst_state_load are the re-primed FIFO (exact silence)",
      ).toBe(true);

      // Same guarantee for pvst_reset. loadRaw stopped the note, so start a new
      // one and refill the FIFO with audio first.
      expect(abi.fn("pvst_note_on")(handle, 60, 1.0), "pvst_note_on (post-load)").toBe(PVST_OK);
      for (let i = 0; i < 8; i += 1) tail = process(128);
      expect(peakOf(tail), "FIFO refilled with audio before reset").toBeGreaterThan(1e-4);
      expect(abi.fn("pvst_reset")(handle), "pvst_reset").toBe(PVST_OK);
      expect(
        process(FIFO_LATENCY_FRAMES).every((s) => s === 0),
        "32 frames after pvst_reset are the re-primed FIFO (exact silence)",
      ).toBe(true);
    } finally {
      abi.free(scratch);
      abi.fn("pvst_destroy")(handle);
    }
  }, 60_000);
});
