import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { generateSurgeUi } from "../scripts/generate-ui";
import { readArchiveEntries } from "./webvst_archive";

const archiveUrl = new URL("../dist/SurgeXT-UI.webvst", import.meta.url);
// The pinned SDK predates UI. The separate build:ui workflow enables this gate.
describe.skipIf(!existsSync(archiveUrl))("Surge UI package / compiled editor", () => {
  function read() {
    const entries = readArchiveEntries(readFileSync(archiveUrl));
    const manifest = JSON.parse(new TextDecoder().decode(entries.get("plugin.json")));
    return { entries, manifest };
  }
  it("ships exact generated fallback and UI hashes while preserving DSP and presets", () => {
    const { entries, manifest } = read();
    const original = readArchiveEntries(readFileSync(new URL("../dist/SurgeXT.webvst", import.meta.url)));
    const uiPaths = ["ui.json", "ui.wasm", "licenses/LATO-OFL.txt", ...Object.values(manifest.ui.assets).map((a: any) => a.path)];
    expect([...entries.keys()].sort()).toEqual([...original.keys(), ...uiPaths].sort());
    for (const [id, a] of Object.entries<any>(manifest.ui.assets)) {
      expect(createHash("sha256").update(entries.get(a.path)!).digest("hex"), id).toBe(a.sha256);
      expect(a.type).toBe(a.path.endsWith(".svg") ? "image" : "font");
    }
    for (const [name, bytes] of original) if (name !== "plugin.json") expect(Buffer.from(entries.get(name)!).equals(Buffer.from(bytes)), name).toBe(true);
    const ui = manifest.ui.classes[0];
    expect(ui.classUid).toBe(manifest.classes[0].classUid);
    for (const item of [ui.document, ui.custom])
      expect(createHash("sha256").update(entries.get(item.path)!).digest("hex")).toBe(item.sha256);
    expect(JSON.parse(new TextDecoder().decode(entries.get("ui.json"))))
      .toEqual(generateSurgeUi(manifest.classes[0].exposedParameters));
  });

  async function editor() {
    const { entries, manifest } = read();
    const module = await WebAssembly.compile(entries.get("ui.wasm")!);
    expect(WebAssembly.Module.imports(module).every(i => i.module === "webvst_ui")).toBe(true);
    let exports: any;
    const frames = new Map<number, any>();
    const requests: Array<[number, number, number]> = [];
    const instance = await WebAssembly.instantiate(module, { webvst_ui: {
      submit(kind: number, pointer: number, length: number) {
        frames.set(kind, JSON.parse(new TextDecoder().decode(new Uint8Array(exports.memory.buffer, pointer, length)))); return 0;
      },
      parameter(op: number, id: number, value: number) { requests.push([op, id, value]); return 0; },
      invalidate() {},
    } });
    exports = instance.exports;
    exports._initialize?.();
    expect(exports.wvui_version()).toBe(1);
    const handle = exports.wvui_create();
    expect(handle).toBeGreaterThan(0);
    exports.wvui_resize(handle, 1440, 960, 1);
    exports.wvui_frame(handle, 0);
    const event = (payload: unknown) => {
      const bytes = new TextEncoder().encode(JSON.stringify(payload));
      const pointer = exports.wvui_alloc(bytes.length);
      new Uint8Array(exports.memory.buffer, pointer, bytes.length).set(bytes);
      exports.wvui_event(handle, pointer, bytes.length);
      exports.wvui_free(pointer, bytes.length);
      exports.wvui_frame(handle, 1);
    };
    return { exports, handle, frames, requests, manifest, event };
  }

  it("makes every exposed parameter reachable through the upstream scene/oscillator/LFO/FX selectors", async () => {
    const { exports, handle, frames, manifest, event } = await editor();
    try {
      const seen = new Set<string>();
      const collect = () => { for (const node of frames.get(2).nodes) if (node.parameter) seen.add(node.parameter); };
      for (const scene of [0, 1]) {
        // The scene shown follows the canonical Active Scene value, as upstream.
        exports.wvui_parameter(handle, 5, scene);
        for (let osc = 0; osc < 3; osc++) { event({ type: "change", targetId: "surge-osc.select", value: osc / 2 }); collect(); }
        for (let lfo = 0; lfo < 12; lfo++) { event({ type: "keydown", targetId: `surge-modsource-${lfo}`, key: "Enter" }); collect(); }
        for (let slot = 0; slot < 16; slot++) { event({ type: "change", targetId: "surge-fx.selector", value: slot / 15 }); collect(); }
      }
      expect([...seen].sort()).toEqual(manifest.classes[0].exposedParameters.map(p => String(p.parameterId)).sort());
      // Drawn from the packaged upstream skin: background plus sprite trays and handles.
      const images = new Set(frames.get(1).commands.filter(c => c.op === "image").map(c => c.asset));
      for (const id of ["bmp00102", "bmp00154", "bmp00153", "bmp00105", "bmp00157"]) expect(images.has(id), id).toBe(true);
      for (const id of images) expect(Object.hasOwn(manifest.ui.assets, id), id).toBe(true);
    } finally { exports.wvui_destroy(handle); }
  });

  it("requests gestures, waits for canonical publication, and ends a drag on destroy", async () => {
    const { exports, handle, frames, requests, event } = await editor();
    const control = frames.get(2).nodes.find(n => n.parameter === "4");
    const previous = control.value;
    event({ type: "change", targetId: control.id, value: .21 });
    expect(requests.map(r => r[0])).toEqual([0, 1, 2]);
    expect(frames.get(2).nodes.find(n => n.id === control.id).value).toBe(previous);
    exports.wvui_parameter(handle, 4, .37);
    exports.wvui_frame(handle, 2);
    expect(frames.get(2).nodes.find(n => n.id === control.id).value).toBe(.37);
    const bounds = control.bounds;
    // Surge sliders drag relatively: pointer down opens the gesture, destroy must close it.
    event({ type: "pointerdown", x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2, pointerId: 1 });
    expect(requests.at(-1)![0]).toBe(0);
    exports.wvui_destroy(handle);
    expect(requests.slice(-2).map(r => r[0])).toEqual([0, 2]);
  });
});
