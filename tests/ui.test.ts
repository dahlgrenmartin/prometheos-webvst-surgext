import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import {
  bindSurgeParameters, generateParameterHeader, generateSurgeUi, groupSurgeParameters, loadSurgeSkin, splitScene, type UiNode,
} from "../scripts/generate-ui";
import { readArchiveEntries } from "./webvst_archive";

const entries = readArchiveEntries(readFileSync(new URL("../dist/SurgeXT.webvst", import.meta.url)));
const manifest = JSON.parse(new TextDecoder().decode(entries.get("plugin.json")));
const parameters = manifest.classes[0].exposedParameters;
const surgeDir = new URL("../vendor/surge", import.meta.url).pathname.replace(/^\/(\w:)/, "$1");
const skin = loadSurgeSkin(surgeDir, path => readFileSync(path, "utf8"), existsSync);
function flatten(node: UiNode): UiNode[] { return [node, ...(node.children ?? []).flatMap(flatten)]; }

describe("Surge UI metadata", () => {
  it("covers every probed parameter exactly once with stable numeric bindings and authored IDs", () => {
    const nodes = flatten(generateSurgeUi(parameters).root);
    const controls = nodes.filter(n => n.parameter !== undefined);
    expect(controls).toHaveLength(parameters.length);
    expect(controls.map(n => n.parameter).sort()).toEqual(parameters.map(p => String(p.parameterId)).sort());
    expect(new Set(nodes.map(n => n.id)).size).toBe(nodes.length);
    expect(controls.every(n => n.id === `surge-param-${n.parameter}`)).toBe(true);
    expect(generateSurgeUi([...parameters].reverse())).toEqual(generateSurgeUi(parameters));
  });

  it("distinguishes both scenes and preserves meaningful synth sections", () => {
    const groups = groupSurgeParameters(parameters);
    expect(groups.find(g => g.id === "scene-a-osc-1")?.parameters.map(p => p.name)).toContain("A Osc 1 Pitch");
    expect(groups.find(g => g.id === "scene-b-osc-1")?.parameters.map(p => p.name)).toContain("B Osc 1 Pitch");
    for (const id of ["global", "effects", "scene-a-filter", "scene-a-amp-eg", "scene-a-filter-eg", "scene-a-lfo-1", "scene-b-scene-lfo-6"])
      expect(groups.some(g => g.id === id), id).toBe(true);
  });

  it("reads the scene from the adapter's A/B title prefix", () => {
    expect(splitScene("A Filter 1 Cutoff")).toEqual({ scene: 0, base: "Filter 1 Cutoff" });
    expect(splitScene("B Scene LFO 3 Rate")).toEqual({ scene: 1, base: "Scene LFO 3 Rate" });
    expect(splitScene("Character")).toEqual({ scene: -1, base: "Character" });
    expect(splitScene("FX A1 Param 1")).toEqual({ scene: -1, base: "FX A1 Param 1" });
  });

  it("rejects duplicate or unsafe IDs rather than silently dropping a parameter", () => {
    expect(() => generateSurgeUi([...parameters, parameters[0]])).toThrow(/duplicate/i);
    expect(() => generateSurgeUi([{ ...parameters[0], parameterId: -1 }])).toThrow(/parameter/i);
  });
});

describe("Surge skin model (upstream SkinModel.cpp / SurgePatch.cpp)", () => {
  it("resolves upstream connector geometry, parents and slider styles", () => {
    expect(skin.connectors.get("osc.display")).toMatchObject({ x: 4, y: 81, w: 141, h: 99, component: "custom" });
    // inParent("osc.param.panel") at (6, 212) plus the connector's own (0, 22), default horizontal size.
    expect(skin.connectors.get("osc.param_1")).toMatchObject({ x: 6, y: 234, w: 140, h: 26, orientation: "horizontal" });
    expect(skin.connectors.get("lfo.delay")).toMatchObject({ x: 616, y: 493, orientation: "vertical", mini: true });
    expect(skin.connectors.get("scene.pan")).toMatchObject({ white: true, bipolar: true });
    expect(skin.connectors.get("scene.pitch")).toMatchObject({ semitone: true });
    expect(skin.connectors.get("global.active_scene")).toMatchObject({ component: "multiswitch", background: 113, frames: 2, rows: 2, columns: 1 });
    expect(skin.connectors.get("mixer.mute_o1")).toMatchObject({ component: "switch", w: 22, h: 15, background: 134 });
    expect(skin.fxAcronyms.slice(0, 3)).toEqual(["OFF", "DLY", "RV1"]);
    expect(skin.assets.find(a => a.resource === 102)).toMatchObject({ width: 905, height: 569 });
  });

  it("binds every probed parameter to an upstream connector with its scene and index", () => {
    const bindings = bindSurgeParameters(parameters, skin.connectors);
    expect(bindings).toHaveLength(parameters.length);
    const find = (name: string, scene: number) => bindings.find(b => b.parameter.name === name && b.scene === scene)!;
    expect(find("B Osc 2 Shape", 1)).toMatchObject({ connector: "osc.param_1", index: 1 });
    expect(find("A Scene LFO 3 Rate", 0)).toMatchObject({ connector: "lfo.rate", index: 8 });
    expect(find("FX S2 FX Type", -1)).toMatchObject({ connector: "fx.type", index: 5 });
    expect(find("Character", -1)).toMatchObject({ connector: "global.character" });
    expect(() => bindSurgeParameters([...parameters, { ...parameters[0], parameterId: 99999, name: "Unmapped" }], skin.connectors)).toThrow(/connector/);
  });

  it("emits a deterministic C++ header for the editor", () => {
    const header = generateParameterHeader(parameters, skin.connectors, skin.assets, skin.fxAcronyms);
    expect(header).toBe(generateParameterHeader([...parameters].reverse(), skin.connectors, skin.assets, skin.fxAcronyms));
    expect(header).toContain('"surge-param-308"');
    expect(header.match(/^  \{\d+u,"surge-param-/gm)).toHaveLength(parameters.length);
  });
});
