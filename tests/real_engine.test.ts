import { describe, it, expect, beforeAll } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { readArchiveEntries } from "./webvst_archive";

/**
 * Real-engine acceptance for the packaged Surge XT WebVST.
 *
 * Everything here runs against the module and the preset bytes taken OUT OF
 * `dist/SurgeXT.webvst` -- not out of `build/`, not out of `package/presets/`.
 * The point is to prove that what the package actually ships makes sound: a
 * host that only ever sees the archive and the generic `webvst_*` ABI can play
 * notes, move parameters, recall factory presets, and save and restore state.
 *
 * `tests/abi_surface.test.ts` locks the ABI's shape and its error contract on
 * the freshly built module; this suite is about behaviour of the shipped
 * artifact, so its assertions are audio-level and preset-level.
 *
 * The instantiation environment is the SDK probe's, byte for byte: the same
 * eight imports, `PATH=/usr/bin` and nothing else, a zeroed clock and a zeroed
 * `random_get`, and `_initialize` before any ABI call.
 */

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const archivePath = join(repoRoot, "dist", "SurgeXT.webvst");

const WEBVST_OK = 0;
const WEBVST_ERROR_FRAME_COUNT = -3;
const WEBVST_PARAMETER_AUTOMATABLE = 1;

const SAMPLE_RATE = 48_000;
const MAX_FRAMES = 128;

/** Exactly the environment the SDK probe supplies: `PATH=/usr/bin`, nothing else. */
const ENVIRONMENT_BYTES = new Uint8Array([80, 65, 84, 72, 61, 47, 117, 115, 114, 47, 98, 105, 110, 0]);

interface ManifestProgram {
  name: string;
  artifactId: string;
  offset: number;
  size: number;
}
interface Manifest {
  module: { path: string };
  classes: Array<{
    programs?: { categories: Array<{ name: string; entries: ManifestProgram[] }> };
  }>;
}

interface AbiInstance {
  readonly memory: WebAssembly.Memory;
  readonly fn: (name: string) => (...args: number[]) => number;
  malloc(size: number): number;
  free(pointer: number): void;
  bytes(): Uint8Array;
}

let wasmModule: WebAssembly.Module;
let manifest: Manifest;
let entries: Map<string, Uint8Array>;

function instantiate(): AbiInstance {
  let memory: WebAssembly.Memory | undefined;
  const view = () => (memory ? new DataView(memory.buffer) : undefined);
  const bytes = () => (memory ? new Uint8Array(memory.buffer) : undefined);
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

/** A live instance plus a scratch output buffer, torn down after `body`. */
function withVoice<T>(body: (abi: AbiInstance, handle: number, output: number) => T): T {
  const abi = instantiate();
  const handle = abi.fn("webvst_create")(0, SAMPLE_RATE, MAX_FRAMES) >>> 0;
  if (handle === 0) throw new Error("webvst_create returned a null handle");
  const output = abi.malloc(MAX_FRAMES * 2 * 4);
  if (output === 0) throw new Error("malloc for the output buffer failed");
  try {
    return body(abi, handle, output);
  } finally {
    abi.free(output);
    abi.fn("webvst_destroy")(handle);
  }
}

/**
 * Renders `blocks` blocks of `MAX_FRAMES` stereo frames and returns the peak
 * absolute sample. Throws on any non-finite sample -- a NaN or an Inf reaching
 * a host's output is a hard defect, not a level to be measured.
 */
function render(abi: AbiInstance, handle: number, output: number, blocks: number): number {
  let peak = 0;
  for (let block = 0; block < blocks; block += 1) {
    const result = abi.fn("webvst_process")(handle, 0, output, MAX_FRAMES);
    if (result !== WEBVST_OK) throw new Error(`webvst_process failed with ${result}`);
    const samples = new Float32Array(abi.memory.buffer, output, MAX_FRAMES * 2);
    for (const sample of samples) {
      if (!Number.isFinite(sample)) throw new Error(`non-finite sample in block ${block}`);
      const magnitude = Math.abs(sample);
      if (magnitude > peak) peak = magnitude;
    }
  }
  return peak;
}

/** The first continuous (step count 0) automatable parameter -- deterministic. */
function continuousParameter(abi: AbiInstance): number {
  const count = abi.fn("webvst_class_param_count")(0) >>> 0;
  for (let index = 0; index < count; index += 1) {
    if (
      (abi.fn("webvst_class_param_step_count")(0, index) >>> 0) === 0 &&
      ((abi.fn("webvst_class_param_flags")(0, index) >>> 0) & WEBVST_PARAMETER_AUTOMATABLE) !== 0
    ) {
      return index;
    }
  }
  throw new Error("the module reports no continuous automatable parameter");
}

/** The packed bytes of one manifest program, sliced out of its archive artifact. */
function programBytes(program: ManifestProgram): Uint8Array {
  const artifact = entries.get(`presets/${program.artifactId}.bin`);
  if (!artifact) throw new Error(`the archive has no presets/${program.artifactId}.bin`);
  return artifact.subarray(program.offset, program.offset + program.size);
}

/** Loads a packed preset into a live instance through the generic ABI. */
function loadProgram(abi: AbiInstance, handle: number, program: ManifestProgram): void {
  const state = programBytes(program);
  const pointer = abi.malloc(state.byteLength);
  if (pointer === 0) throw new Error("malloc for the preset state failed");
  try {
    abi.bytes().set(state, pointer);
    const result = abi.fn("webvst_state_load")(handle, pointer, state.byteLength);
    if (result !== WEBVST_OK) throw new Error(`webvst_state_load failed with ${result}`);
  } finally {
    abi.free(pointer);
  }
}

function categories(): Array<{ name: string; entries: ManifestProgram[] }> {
  return manifest.classes[0].programs?.categories ?? [];
}

beforeAll(async () => {
  if (!existsSync(archivePath)) {
    throw new Error(
      "dist/SurgeXT.webvst is missing. Build the package first: pnpm run build (bun scripts/build.ts).",
    );
  }
  entries = readArchiveEntries(new Uint8Array(readFileSync(archivePath)));
  manifest = JSON.parse(new TextDecoder().decode(entries.get("plugin.json")!)) as Manifest;
  const module = entries.get(manifest.module.path);
  if (!module) throw new Error(`the archive has no ${manifest.module.path}`);
  wasmModule = await WebAssembly.compile(module.slice().buffer);
}, 120_000);

describe("the packaged Surge XT engine makes sound", () => {
  it("renders finite, non-silent audio after a note-on", () => {
    withVoice((abi, handle, output) => {
      // Silence before any note: the instrument is idle, not noisy.
      expect(render(abi, handle, output, 4)).toBeLessThan(1e-6);
      expect(abi.fn("webvst_note_on")(handle, 60, 0.8)).toBe(WEBVST_OK);
      expect(render(abi, handle, output, 64)).toBeGreaterThan(1e-3);
    });
  }, 120_000);

  it("decays back towards silence after a note-off", () => {
    withVoice((abi, handle, output) => {
      expect(abi.fn("webvst_note_on")(handle, 60, 0.8)).toBe(WEBVST_OK);
      const held = render(abi, handle, output, 64);
      expect(held).toBeGreaterThan(1e-3);

      expect(abi.fn("webvst_note_off")(handle, 60)).toBe(WEBVST_OK);
      // Surge's release plus its output filters take a moment; give the voice
      // up to ~5 s of audio and measure the tail, not the transient.
      let tail = held;
      for (let window = 0; window < 60 && tail > held * 0.05; window += 1) {
        tail = render(abi, handle, output, 32);
      }
      expect(tail).toBeLessThan(held * 0.05);
    });
  }, 120_000);

  it("round-trips a continuous parameter through set and get", () => {
    withVoice((abi, handle) => {
      const target = continuousParameter(abi);
      for (const value of [0, 0.125, 0.5, 0.875, 1]) {
        expect(abi.fn("webvst_param_set")(handle, target, value)).toBe(WEBVST_OK);
        expect(abi.fn("webvst_param_get")(handle, target)).toBeCloseTo(value, 4);
      }
    });
  }, 120_000);

  it("accepts every host block size in 0..128 and rejects 129", () => {
    withVoice((abi, handle, output) => {
      for (const frames of [0, 1, 31, 32, 33, 127, 128]) {
        expect(abi.fn("webvst_process")(handle, 0, output, frames), `${frames} frames`).toBe(WEBVST_OK);
      }
      expect(abi.fn("webvst_process")(handle, 0, output, 129)).toBe(WEBVST_ERROR_FRAME_COUNT);
    });
  }, 120_000);

  it("keeps two concurrent instances isolated from each other", () => {
    const abi = instantiate();
    const first = abi.fn("webvst_create")(0, SAMPLE_RATE, MAX_FRAMES) >>> 0;
    const second = abi.fn("webvst_create")(0, SAMPLE_RATE, MAX_FRAMES) >>> 0;
    expect(first).not.toBe(0);
    expect(second).not.toBe(0);
    expect(first).not.toBe(second);
    try {
      const target = continuousParameter(abi);
      const baseline = abi.fn("webvst_param_get")(second, target);

      expect(abi.fn("webvst_param_set")(first, target, 0.3)).toBe(WEBVST_OK);
      expect(abi.fn("webvst_param_get")(first, target)).toBeCloseTo(0.3, 4);
      expect(abi.fn("webvst_param_get")(second, target)).toBeCloseTo(baseline, 6);

      // And a preset recalled into one leaves the other's patch alone.
      const first_category = categories()[0];
      loadProgram(abi, second, first_category.entries[0]);
      expect(abi.fn("webvst_param_get")(first, target)).toBeCloseTo(0.3, 4);
    } finally {
      abi.fn("webvst_destroy")(first);
      abi.fn("webvst_destroy")(second);
    }
  }, 120_000);

  it("saves and restores its own state, preserving a changed parameter", () => {
    withVoice((abi, handle) => {
      const target = continuousParameter(abi);
      const saved = 0.25;
      const overwritten = 0.8;

      expect(abi.fn("webvst_param_set")(handle, target, saved)).toBe(WEBVST_OK);
      const size = abi.fn("webvst_state_size")(handle) >>> 0;
      expect(size).toBeGreaterThan(0);
      const pointer = abi.malloc(size);
      expect(pointer).not.toBe(0);
      try {
        expect(abi.fn("webvst_state_write")(handle, pointer, size)).toBe(WEBVST_OK);
        expect(new TextDecoder().decode(abi.bytes().slice(pointer, pointer + 4))).toBe("sub3");

        expect(abi.fn("webvst_param_set")(handle, target, overwritten)).toBe(WEBVST_OK);
        expect(abi.fn("webvst_param_get")(handle, target)).toBeCloseTo(overwritten, 4);

        expect(abi.fn("webvst_state_load")(handle, pointer, size)).toBe(WEBVST_OK);
        expect(abi.fn("webvst_param_get")(handle, target)).toBeCloseTo(saved, 4);
      } finally {
        abi.free(pointer);
      }
    });
  }, 120_000);
});

describe("the packaged factory presets load and play", () => {
  it("recalls program 0,0 -- the first entry of the first category -- and renders audio", () => {
    const category = categories()[0];
    expect(category.name).toBe("Basses");
    const program = category.entries[0];
    expect(program.name).toBe("Attacky");
    expect(program.artifactId).toBe("basses");

    withVoice((abi, handle, output) => {
      loadProgram(abi, handle, program);
      expect(abi.fn("webvst_note_on")(handle, 48, 0.9)).toBe(WEBVST_OK);
      expect(render(abi, handle, output, 96)).toBeGreaterThan(1e-3);
    });
  }, 120_000);

  it("recalls a preset from the nested Tutorials category and renders audio", () => {
    // Tutorials is the one category whose .fxp files sit a directory deeper;
    // its slices therefore exercise the recursive walk in the packer.
    const category = categories().find((entry) => entry.name === "Tutorials");
    expect(category, "the manifest declares a Tutorials category").toBeDefined();
    expect(category!.entries.length).toBeGreaterThan(1);
    const program = category!.entries[0];
    expect(program.artifactId).toBe("tutorials");

    withVoice((abi, handle, output) => {
      loadProgram(abi, handle, program);
      expect(abi.fn("webvst_note_on")(handle, 60, 0.9)).toBe(WEBVST_OK);
      expect(render(abi, handle, output, 96)).toBeGreaterThan(1e-3);
    });
  }, 120_000);

  it("changes the rendered sound when a different preset is recalled", () => {
    // A preset that loads but is ignored would still make noise; two different
    // patches through the same note must not produce the same peak.
    const basses = categories()[0].entries;
    withVoice((abi, handle, output) => {
      const peaks = [basses[0], basses[1]].map((program) => {
        loadProgram(abi, handle, program);
        expect(abi.fn("webvst_reset")(handle)).toBe(WEBVST_OK);
        expect(abi.fn("webvst_note_on")(handle, 48, 0.9)).toBe(WEBVST_OK);
        const peak = render(abi, handle, output, 64);
        expect(abi.fn("webvst_note_off")(handle, 48)).toBe(WEBVST_OK);
        render(abi, handle, output, 64);
        return peak;
      });
      expect(peaks[0]).toBeGreaterThan(1e-3);
      expect(peaks[1]).toBeGreaterThan(1e-3);
      expect(peaks[0]).not.toBeCloseTo(peaks[1], 5);
    });
  }, 120_000);
});
