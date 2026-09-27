import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";

import { readArchiveEntries } from "./webvst_archive";

/**
 * The optional `webvst-ext-message-1` channel, driven against the DSP module
 * shipped in the editor package, through the same generic ABI a host uses.
 * Instantiation mirrors tests/real_engine.test.ts (the SDK probe environment).
 */
const archiveUrl = new URL("../dist/SurgeXT-UI.webvst", import.meta.url);
const ENVIRONMENT_BYTES = new Uint8Array([80, 65, 84, 72, 61, 47, 117, 115, 114, 47, 98, 105, 110, 0]);

function instantiate(module: WebAssembly.Module) {
  let memory: WebAssembly.Memory | undefined;
  const view = () => new DataView(memory!.buffer);
  const writeU32 = (pointer: number, value: number) => view().setUint32(pointer, value >>> 0, true);
  const instance = new WebAssembly.Instance(module, {
    env: { __cxa_rethrow() { throw new Error("rethrow"); }, emscripten_notify_memory_growth() {} },
    wasi_snapshot_preview1: {
      clock_time_get(_c: number, _p: number, result: number) { writeU32(result, 0); writeU32(result + 4, 0); return 0; },
      fd_read(_f: number, _i: number, _c: number, result: number) { writeU32(result, 0); return 0; },
      fd_write(_f: number, iovecs: number, count: number, result: number) {
        let length = 0;
        for (let i = 0; i < count; i += 1) length += view().getUint32(iovecs + i * 8 + 4, true);
        writeU32(result, length);
        return 0;
      },
      environ_get(pointer: number, buffer: number) { writeU32(pointer, buffer); new Uint8Array(memory!.buffer).set(ENVIRONMENT_BYTES, buffer); return 0; },
      environ_sizes_get(count: number, size: number) { writeU32(count, 1); writeU32(size, ENVIRONMENT_BYTES.byteLength); return 0; },
      random_get(pointer: number, length: number) { new Uint8Array(memory!.buffer).fill(0, pointer, pointer + length); return 0; },
    },
  });
  const exports = instance.exports as Record<string, any>;
  memory = exports.memory;
  exports._initialize();
  const handle = exports.webvst_create(0, 48_000, 128) >>> 0;
  const message = (request: unknown): any => {
    const bytes = new TextEncoder().encode(JSON.stringify(request));
    const input = exports.malloc(bytes.length);
    new Uint8Array(memory!.buffer, input, bytes.length).set(bytes);
    const size = exports.webvst_ext_message(handle, input, bytes.length) >>> 0;
    exports.free(input);
    const output = exports.malloc(size);
    expect(exports.webvst_ext_reply_write(handle, output, size)).toBe(0);
    const reply = new TextDecoder().decode(new Uint8Array(memory!.buffer, output, size).slice());
    exports.free(output);
    return JSON.parse(reply);
  };
  const state = () => {
    const size = exports.webvst_state_size(handle) >>> 0;
    const ptr = exports.malloc(size);
    exports.webvst_state_write(handle, ptr, size);
    const bytes = new Uint8Array(memory!.buffer, ptr, size).slice();
    exports.free(ptr);
    return bytes;
  };
  const load = (bytes: Uint8Array) => {
    const ptr = exports.malloc(bytes.length);
    new Uint8Array(memory!.buffer, ptr, bytes.length).set(bytes);
    const rc = exports.webvst_state_load(handle, ptr, bytes.length);
    exports.free(ptr);
    return rc;
  };
  const raw = (bytes: Uint8Array) => {
    const input = exports.malloc(Math.max(1, bytes.length));
    new Uint8Array(memory!.buffer, input, bytes.length).set(bytes);
    const size = exports.webvst_ext_message(handle, input, bytes.length) >>> 0;
    exports.free(input);
    const output = exports.malloc(size);
    exports.webvst_ext_reply_write(handle, output, size);
    const reply = JSON.parse(new TextDecoder().decode(new Uint8Array(memory!.buffer, output, size).slice()));
    exports.free(output);
    return reply;
  };
  return { exports, handle, message, state, load, raw };
}

describe.skipIf(!existsSync(archiveUrl))("Surge DSP messages (webvst-ext-message-1)", () => {
  const entries = readArchiveEntries(readFileSync(archiveUrl));
  const manifest = JSON.parse(new TextDecoder().decode(entries.get("plugin.json")));
  const module = new WebAssembly.Module(entries.get(manifest.module.path)!);
  const params = manifest.classes[0].exposedParameters;
  const id = (name: string) => params.find((p: any) => p.name === name).parameterId;

  it("exposes the 192 FX slot parameters as generic automatable parameters", () => {
    expect(params).toHaveLength(765);
    expect(params.filter((p: any) => /^FX [A-Z]\d Param \d+$/.test(p.name))).toHaveLength(192);
  });

  it("reports live names and value text, and parses typed values without changing the patch", () => {
    const dsp = instantiate(module);
    const cutoff = id("Filter 1 Cutoff");
    const info = dsp.message({ type: "paramInfo", ids: [cutoff, id("FX A1 Param 1")] }).params;
    expect(info[0]).toMatchObject({ id: cutoff, name: "Cutoff" });
    expect(info[0].display).toMatch(/Hz/);
    expect(info[1].none).toBe(true); // A1 is empty in the init patch
    const before = dsp.exports.webvst_param_get(dsp.handle, cutoff);
    const parsed = dsp.message({ type: "parse", id: cutoff, text: "440 Hz" });
    expect(parsed.value).toBeGreaterThan(0);
    expect(parsed.value).toBeLessThan(1);
    expect(dsp.exports.webvst_param_get(dsp.handle, cutoff)).toBe(before);
  });

  it("names the current filter type's subtypes", () => {
    const dsp = instantiate(module);
    const type = params.find((p: any) => p.name === "Filter 1 Type");
    expect(dsp.message({ type: "filterSubtypes", scene: 0, unit: 0 }).count).toBe(0); // "Off" in the init patch
    dsp.exports.webvst_param_set(dsp.handle, type.parameterId, 1 / type.stepCount); // "LP 12 dB"
    const reply = dsp.message({ type: "filterSubtypes", scene: 0, unit: 0 });
    expect(reply.count).toBeGreaterThan(1);
    expect(reply.names).toHaveLength(reply.count);
    expect(new Set(reply.names).size).toBe(reply.count);
  });

  it("renders the oscillator and LFO displays from the synth", () => {
    const dsp = instantiate(module);
    const osc = dsp.message({ type: "renderOsc", scene: 0, osc: 0, points: 200 });
    expect(osc.samples).toHaveLength(200);
    expect(osc.samples.every(Number.isFinite)).toBe(true);
    expect(Math.max(...osc.samples) - Math.min(...osc.samples)).toBeGreaterThan(0.5);
    const lfo = dsp.message({ type: "renderLfo", scene: 0, lfo: 0, points: 128 });
    expect(lfo.wave.length).toBeGreaterThan(64);
    expect(lfo.envelope).toHaveLength(lfo.wave.length);
    expect(lfo.seconds).toBeGreaterThan(0);
  });

  it("edits modulation routings through Surge's own API, and the state keeps them", () => {
    const dsp = instantiate(module);
    const cutoff = id("Filter 1 Cutoff");
    const LFO1 = 17;
    const set = dsp.message({ type: "setModulation", target: cutoff, source: LFO1, sourceScene: 0, index: 0, depth: 0.25 });
    expect(set).toMatchObject({ active: true });
    expect(set.depth).toBeCloseTo(0.25, 3);
    const routings = dsp.message({ type: "modulation" }).routings;
    expect(routings).toContainEqual(expect.objectContaining({ target: cutoff, source: LFO1, scene: 0 }));
    const saved = dsp.state();
    const fresh = instantiate(module);
    expect(fresh.load(saved)).toBe(0);
    expect(fresh.message({ type: "modulation" }).routings).toContainEqual(expect.objectContaining({ target: cutoff, source: LFO1 }));
    dsp.message({ type: "clearModulation", target: cutoff, source: LFO1, sourceScene: 0, index: 0 });
    expect(dsp.message({ type: "modulation" }).routings).toEqual([]);
  });

  it("answers malformed requests with errors instead of trapping", () => {
    const dsp = instantiate(module);
    expect(dsp.raw(new TextEncoder().encode("{not json")).error).toBeTruthy();
    expect(dsp.message({ type: "nope" }).error).toMatch(/unknown/);
    expect(dsp.message({ type: "renderOsc", scene: 9, osc: 0 }).error).toBeTruthy();
    expect(dsp.message({ type: "setModulation", target: 1e9, source: 17, depth: 1 }).error).toBeTruthy();
    expect(dsp.message({ type: "paramInfo", ids: [] }).params).toEqual([]);
  });
});
