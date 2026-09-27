/** Editor content is derived from the probed DSP metadata, never a second parameter registry. */
export interface SurgeParameter {
  parameterId: number; name: string; defaultValue: number; stepCount: number; flags: number;
  display?: { choices?: string[] } | Record<string, unknown>;
}
export interface UiNode {
  type: string; id: string; label?: string; parameter?: string; children?: UiNode[];
  [key: string]: unknown;
}
export interface ParameterGroup { id: string; label: string; zone: string; parameters: SurgeParameter[] }

export function groupSurgeParameters(input: readonly SurgeParameter[]): ParameterGroup[] {
  const parameters = [...input].sort((a, b) => a.parameterId - b.parameterId);
  const ids = new Set<number>();
  for (const p of parameters) {
    if (!Number.isInteger(p.parameterId) || p.parameterId < 0 || p.parameterId > 0xffffffff)
      throw new Error(`Invalid parameter ID: ${p.parameterId}`);
    if (ids.has(p.parameterId)) throw new Error(`Duplicate parameter ID: ${p.parameterId}`);
    ids.add(p.parameterId);
  }
  // Surge's probe exposes scene-local names twice. The two Octave anchors delimit
  // the scene blocks in stable DSP-ID order; no guessed parameter-ID offsets.
  const anchors = parameters.filter(p => p.name === "Octave").map(p => p.parameterId);
  if (anchors.length !== 0 && anchors.length !== 2) throw new Error("Expected two probed Surge scene anchors");
  const groups = new Map<string, ParameterGroup>();
  for (const p of parameters) {
    let key = "global", label = "Global / Output", zone = "global";
    if (/^FX /.test(p.name)) { key = "effects"; label = "Effects / Routing"; zone = "effects"; }
    else if (anchors.length === 2 && p.parameterId >= anchors[0] && p.name !== "Character") {
      const scene = p.parameterId >= anchors[1] ? "b" : "a";
      let section = "scene", title = "Scene / Play Mode"; zone = "scene";
      const osc = /^Osc ([123]) /.exec(p.name);
      const lfo = /^(Scene )?LFO ([1-6]) /.exec(p.name);
      if (lfo) { section = `${lfo[1] ? "scene-" : ""}lfo-${lfo[2]}`; title = `${lfo[1] ?? ""}LFO ${lfo[2]}`; zone = "modulation"; }
      else if (/^Amp EG /.test(p.name)) { section = "amp-eg"; title = "Amp EG"; zone = "envelopes"; }
      else if (/^Filter EG /.test(p.name)) { section = "filter-eg"; title = "Filter EG"; zone = "envelopes"; }
      else if (/^(Filter |Waveshaper |Highpass|Feedback|Link Resonance)/.test(p.name)) { section = "filter"; title = "Filters / Waveshaper"; zone = "filter"; }
      else if (/^(Ring Modulation |Noise (Volume|Mute|Solo|Route)|Pre-Filter|VCA |Velocity >)/.test(p.name) || (osc && / (Volume|Mute|Solo|Route)$/.test(p.name))) {
        section = "mixer"; title = "Mixer / Amplifier"; zone = "mixer";
      } else if (osc) { section = `osc-${osc[1]}`; title = `Oscillator ${osc[1]}`; zone = "oscillators"; }
      key = `scene-${scene}-${section}`; label = `Scene ${scene.toUpperCase()} / ${title}`;
    }
    if (!groups.has(key)) groups.set(key, { id: key, label, zone, parameters: [] });
    groups.get(key)!.parameters.push(p);
  }
  return [...groups.values()];
}

export function generateSurgeUi(parameters: readonly SurgeParameter[]) {
  const groups = groupSurgeParameters(parameters);
  const children: UiNode[] = [{ type: "label", id: "surge-title", label: "SURGE XT · Parameter editor", height: 36 }];
  let height = 68;
  for (const group of groups) {
    const groupHeight = 46 + Math.ceil(group.parameters.length / 4) * 68;
    height += groupHeight + 12;
    children.push({ type: "group", id: `surge-${group.id}`, label: group.label, height: groupHeight, padding: 12, gap: 8,
      children: [
        { type: "label", id: `surge-${group.id}-title`, label: group.label, height: 26 },
        { type: "grid", id: `surge-${group.id}-controls`, columns: 4, gap: 8, flex: 1,
          children: group.parameters.map(p => ({ type: p.stepCount === 1 ? "toggle" : p.stepCount > 1 && p.stepCount < 64 ? "combo" : "slider",
            id: `surge-param-${p.parameterId}`, parameter: String(p.parameterId), label: p.name, height: 60 })) },
      ] });
  }
  return { version: 1, theme: { background: "#181a1d", surface: "#303236", text: "#e6e7e9", muted: "#acafb4", accent: "#ff9d00", header: "#164f88", focus: "#58acff", fontSize: 13, controlHeight: 38 },
    root: { type: "column", id: "surge-editor", padding: 16, gap: 12, height, children } as UiNode };
}

/*
 * Upstream skin model. Surge's JUCE editor positions every control from
 * `src/common/SkinModel.cpp` (905x569 design units) and takes each slider's
 * style from the `assign(...)` calls in `src/common/SurgePatch.cpp`. Both are
 * read from the pinned upstream checkout at build time, so the port follows the
 * upstream layout instead of re-authoring it.
 */
export type SkinComponent = "slider" | "multiswitch" | "switch" | "numberfield" | "oscmenu" | "fxmenu"
  | "filterselector" | "waveshaper" | "lfodisplay" | "custom" | "vumeter" | "group" | "none";
export interface SkinConnector {
  id: string; x: number; y: number; w: number; h: number; component: SkinComponent;
  orientation: "horizontal" | "vertical" | "none"; white: boolean; background: number;
  frames: number; rows: number; columns: number; frameOffset: number;
  /** From SurgePatch.cpp: ct_ type and the mini/semitone style flags. */
  ct: string; mini: boolean; semitone: boolean; bipolar: boolean;
}

const COMPONENTS: Record<string, SkinComponent> = {
  Slider: "slider", MultiSwitch: "multiswitch", Switch: "switch", NumberField: "numberfield", OscMenu: "oscmenu",
  FxMenu: "fxmenu", FilterSelector: "filterselector", WaveShaperSelector: "waveshaper", LFODisplay: "lfodisplay",
  Custom: "custom", VuMeter: "vumeter", Group: "group", None: "none",
};

/** `#define IDB_NAME 123` table from upstream resource.h. */
export function parseResourceIds(source: string): Map<string, number> {
  const ids = new Map<string, number>();
  for (const m of source.matchAll(/#define\s+(ID[BI]_\w+)\s+(\d+)/g)) ids.set(m[1], Number(m[2]));
  return ids;
}

/** Statements `Connector name = Connector(...)...;`, split at depth-0 semicolons. */
function connectorStatements(source: string): string[] {
  const statements: string[] = [];
  const start = /Connector\s+\w+\s*=\s*\n?\s*Connector\(/g;
  for (let m = start.exec(source); m; m = start.exec(source)) {
    let depth = 0, i = m.index;
    for (; i < source.length; i++) {
      const c = source[i];
      if (c === "(") depth++;
      else if (c === ")") depth--;
      else if (c === ";" && depth === 0) break;
    }
    statements.push(source.slice(m.index, i));
  }
  return statements;
}

function args(text: string): string[] {
  const out: string[] = []; let depth = 0, current = "";
  for (const c of text) {
    if (c === "," && depth === 0) { out.push(current.trim()); current = ""; continue; }
    if (c === "(") depth++; if (c === ")") depth--;
    current += c;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

function call(statement: string, name: string): string[] | undefined {
  const at = statement.indexOf(`.${name}(`);
  if (at < 0) return undefined;
  let depth = 0, i = at + name.length + 1;
  const begin = i + 1;
  for (; i < statement.length; i++) {
    if (statement[i] === "(") depth++;
    else if (statement[i] === ")" && --depth === 0) break;
  }
  return args(statement.slice(begin, i));
}

export function parseSkinModel(skinModel: string, surgePatch: string, resources: Map<string, number>): Map<string, SkinConnector> {
  const resource = (name: string) => {
    const id = resources.get(name);
    if (id === undefined) throw new Error(`Unknown upstream resource ${name}`);
    return id;
  };
  const raw = new Map<string, SkinConnector & { parent?: string }>();
  const varToId = new Map<string, string>();
  let namespace = "";
  const namespaces = [...skinModel.matchAll(/namespace\s+(\w+)\s*\n\{/g)].map(m => ({ at: m.index!, name: m[1] }));
  for (const statement of connectorStatements(skinModel)) {
    const at = skinModel.indexOf(statement);
    namespace = namespaces.filter(n => n.at < at).at(-1)?.name ?? "";
    const variable = /Connector\s+(\w+)\s*=/.exec(statement)![1];
    const ctor = statement.slice(statement.indexOf("Connector(", statement.indexOf("=")) + "Connector(".length);
    let depth = 1, end = 0;
    for (; end < ctor.length && depth; end++) { if (ctor[end] === "(") depth++; if (ctor[end] === ")") depth--; }
    const a = args(ctor.slice(0, end - 1));
    const id = JSON.parse(a[0]) as string;
    const numbers = a.slice(1).filter(v => /^-?\d+(\.\d+)?$/.test(v)).map(Number);
    const componentArg = a.find(v => v.startsWith("Components::"));
    const methods = statement.slice(statement.indexOf("Connector(", statement.indexOf("=")) + end);
    const c: SkinConnector & { parent?: string } = {
      id, x: numbers[0] ?? 0, y: numbers[1] ?? 0, w: numbers[2] ?? -1, h: numbers[3] ?? -1,
      component: componentArg ? COMPONENTS[componentArg.slice("Components::".length)] ?? "none" : "none",
      orientation: methods.includes(".asHorizontal()") ? "horizontal" : methods.includes(".asVertical()") ? "vertical" : "none",
      white: methods.includes(".asWhite()"), background: 0, frames: 1, rows: 1, columns: 1, frameOffset: 0,
      ct: "", mini: false, semitone: false, bipolar: false,
    };
    const parent = call(methods, "inParent"); if (parent) c.parent = JSON.parse(parent[0]);
    const background = call(methods, "withBackground"); if (background) c.background = resource(background[0]);
    const hswitch = call(methods, "withHSwitch2Properties");
    if (hswitch) { c.background = resource(hswitch[0]); c.frames = Number(hswitch[1]); c.rows = Number(hswitch[2]); c.columns = Number(hswitch[3]); }
    for (const m of methods.matchAll(/withProperty\(Component::FRAME_OFFSET,\s*(\d+)\)/g)) c.frameOffset = Number(m[1]);
    if (methods.includes(".asMixerMute()")) Object.assign(c, { component: "switch", w: 22, h: 15, background: resource("IDB_MIXER_MUTE") });
    if (methods.includes(".asMixerSolo()")) Object.assign(c, { component: "switch", w: 22, h: 15, background: resource("IDB_MIXER_SOLO") });
    if (methods.includes(".asMixerRoute()")) Object.assign(c, { component: "multiswitch", w: 22, h: 15, background: resource("IDB_MIXER_OSC_ROUTING"), frames: 3, rows: 1, columns: 3 });
    if (methods.includes(".asJogPlusMinus()")) Object.assign(c, { component: "multiswitch", w: 32, h: 12, background: resource("IDB_PREVNEXT_JOG"), frames: 2, rows: 1, columns: 2 });
    raw.set(id, c);
    varToId.set(`${namespace}::${variable}`, id);
  }
  // Slider styles and ct_ types come from the parameter assignments.
  const flat = surgePatch.replace(/\s+/g, " ");
  for (const m of flat.matchAll(/(ct_\w+), Surge::Skin::(?:Connector::connectorByID\("([\w.]+)" \+ std::to_string\(\w+ \+ 1\)\)|(\w+)::(\w+))([^;]{0,120})/g)) {
    const ids = m[2] ? [1, 2, 3, 4, 5, 6, 7].map(n => `${m[2]}${n}`) : [varToId.get(`${m[3]}::${m[4]}`)];
    for (const id of ids) {
      const c = id ? raw.get(id) : undefined;
      if (!c) continue;
      c.ct = m[1]; c.mini = /\bkMini\b/.test(m[5]); c.semitone = /\bkSemitone\b/.test(m[5]);
      if (/\bkVertical\b/.test(m[5])) c.orientation = "vertical";
      if (/\bkHorizontal\b/.test(m[5]) && c.orientation === "none" && c.component === "none") c.orientation = "horizontal";
      c.bipolar = /bipolar|semi7bp|freq_mod|lfodeform|noise_color/.test(m[1]);
    }
  }
  // FX parameter sliders are styled by the loaded effect at runtime upstream; they
  // draw as horizontal light sliders like the rest of the FX panel.
  for (const c of raw.values()) if (/^fx\.param_\d+$/.test(c.id)) Object.assign(c, { orientation: "horizontal", white: true });
  // LFO envelope and FX parameter sliders take their style from the assignment only.
  for (const c of raw.values()) {
    if (c.mini && c.orientation === "none") c.orientation = "vertical";
    if (c.component === "none" && c.orientation !== "none") c.component = "slider";
    if (c.component === "slider" && c.w < 0) { c.w = c.orientation === "vertical" ? 22 : 140; c.h = c.orientation === "vertical" ? 84 : 26; }
  }
  const resolved = new Map<string, SkinConnector>();
  const absolute = (c: SkinConnector & { parent?: string }, depth = 0): { x: number; y: number } => {
    if (!c.parent) return { x: c.x, y: c.y };
    const parent = raw.get(c.parent);
    if (!parent || depth > 8) throw new Error(`Unknown skin parent ${c.parent}`);
    const p = absolute(parent, depth + 1);
    return { x: p.x + c.x, y: p.y + c.y };
  };
  for (const c of raw.values()) {
    const { parent: _parent, ...rest } = c;
    resolved.set(c.id, { ...rest, ...absolute(c) });
  }
  return resolved;
}

/** One probed parameter bound to the upstream connector that edits it. */
export interface SurgeBinding {
  parameter: SurgeParameter; connector: string;
  /** -1 global, 0 scene A, 1 scene B. */
  scene: number;
  /** Oscillator 0-2, LFO 0-11 (voice 0-5, scene 6-11), FX slot 0-15, send/return 0-3, else -1. */
  index: number;
}

const FX_SLOTS = ["A1", "A2", "B1", "B2", "S1", "S2", "G1", "G2", "A3", "A4", "B3", "B4", "S3", "S4", "G3", "G4"];
const MIXER: Record<string, string> = { "Osc 1": "o1", "Osc 2": "o2", "Osc 3": "o3", "Ring Modulation 1x2": "ring12", "Ring Modulation 2x3": "ring23", "Noise": "noise" };
const EG: Record<string, string> = { Attack: "attack", Decay: "decay", Sustain: "sustain", Release: "release", "Attack Shape": "attack_shape", "Decay Shape": "decay_shape", "Release Shape": "release_shape", "Envelope Mode": "mode" };
const LFO: Record<string, string> = { Type: "shape", Rate: "rate", Phase: "phase", Amplitude: "amplitude", Deform: "deform", "Trigger Mode": "trigger_mode", Unipolar: "unipolar", Delay: "delay", Attack: "attack", Hold: "hold", Decay: "decay", Sustain: "sustain", Release: "release" };
const SCENE: Record<string, string> = {
  Octave: "scene.octave", Pitch: "scene.pitch", Portamento: "scene.portamento", "Play Mode": "scene.playmode", "FM Routing": "scene.fmrouting",
  "FM Depth": "scene.fmdepth", "Osc Drift": "scene.drift", "Noise Color": "scene.noise_color", "Keytrack Root Key": "scene.keytrack_root",
  Volume: "scene.volume", Pan: "scene.pan", Width: "scene.width", "Pre-Filter Gain": "mixer.level_prefiltergain",
  "Pitch Bend Up Range": "scene.pbrange_up", "Pitch Bend Down Range": "scene.pbrange_dn", "VCA Gain": "scene.gain",
  "Velocity > VCA Gain": "scene.velocity_sensitivity", Feedback: "filter.feedback", "Filter Configuration": "filter.config",
  "Filter Balance": "filter.balance", Highpass: "filter.highpass", "Waveshaper Type": "filter.waveshaper_type",
  "Waveshaper Drive": "filter.waveshaper_drive", "Filter 2 Offset Mode": "filter.f2_offset_mode", "Link Resonance": "filter.f2_link_resonance",
};
const GLOBAL: Record<string, string> = {
  "Global Volume": "global.volume", "Active Scene": "global.active_scene", "Scene Mode": "global.scene_mode",
  "Split Point": "scene.splitpoint", "Polyphony Limit": "scene.polylimit", "FX Chain Bypass": "global.fx_bypass", Character: "global.character",
};
const OSC_PARAMETERS = ["Shape", "Width 1", "Width 2", "Sub Mix", "Sync", "Unison Detune", "Unison Voices"];

function connectorFor(name: string, scoped: boolean): { connector: string; index: number } | undefined {
  let m: RegExpExecArray | null;
  if (!scoped) {
    if (GLOBAL[name]) return { connector: GLOBAL[name], index: -1 };
    if ((m = /^Send FX ([1-4]) Return$/.exec(name))) return { connector: `global.fx${m[1]}_return`, index: Number(m[1]) - 1 };
    if ((m = /^FX (\w\d) FX Type$/.exec(name)) && FX_SLOTS.includes(m[1])) return { connector: "fx.type", index: FX_SLOTS.indexOf(m[1]) };
    // Generic FX slot parameters (placeholders until an effect loads; see surge_webvst.cpp).
    if ((m = /^FX (\w\d) Param (\d+)$/.exec(name)) && FX_SLOTS.includes(m[1]) && Number(m[2]) >= 1 && Number(m[2]) <= 12)
      return { connector: `fx.param_${m[2]}`, index: FX_SLOTS.indexOf(m[1]) };
    return undefined;
  }
  if (SCENE[name]) return { connector: SCENE[name], index: -1 };
  if ((m = /^Send FX ([1-4]) Level$/.exec(name))) return { connector: `scene.send_fx_${m[1]}`, index: Number(m[1]) - 1 };
  if ((m = /^(Osc [123]|Ring Modulation 1x2|Ring Modulation 2x3|Noise) (Volume|Mute|Solo|Route)$/.exec(name)))
    return { connector: `mixer.${m[2] === "Volume" ? "level" : m[2].toLowerCase()}_${MIXER[m[1]]}`, index: -1 };
  if ((m = /^Osc ([123]) (.+)$/.exec(name))) {
    const osc = Number(m[1]) - 1, what = m[2];
    const fixed: Record<string, string> = { Type: "osc.type", Octave: "osc.octave", Pitch: "osc.pitch", Keytrack: "osc.keytrack", Retrigger: "osc.retrigger" };
    if (fixed[what]) return { connector: fixed[what], index: osc };
    if (OSC_PARAMETERS.includes(what)) return { connector: `osc.param_${OSC_PARAMETERS.indexOf(what) + 1}`, index: osc };
  }
  if ((m = /^Filter ([12]) (Type|Subtype|Cutoff|Resonance|FEG Mod Amount|Keytrack)$/.exec(name))) {
    const field: Record<string, string> = { Type: "type", Subtype: "subtype", Cutoff: "cutoff", Resonance: "resonance", "FEG Mod Amount": "envmod", Keytrack: "keytrack" };
    return { connector: `filter.${field[m[2]]}_${m[1]}`, index: -1 };
  }
  if ((m = /^(Amp|Filter) EG (.+)$/.exec(name)) && EG[m[2]]) return { connector: `${m[1] === "Amp" ? "aeg" : "feg"}.${EG[m[2]]}`, index: -1 };
  if ((m = /^(Scene )?LFO ([1-6]) (.+)$/.exec(name)) && LFO[m[3]]) return { connector: `lfo.${LFO[m[3]]}`, index: Number(m[2]) - 1 + (m[1] ? 6 : 0) };
  return undefined;
}

export function bindSurgeParameters(parameters: readonly SurgeParameter[], connectors: ReadonlyMap<string, SkinConnector>): SurgeBinding[] {
  const sorted = [...parameters].sort((a, b) => a.parameterId - b.parameterId);
  groupSurgeParameters(sorted); // shared ID validation
  const anchors = sorted.filter(p => p.name === "Octave").map(p => p.parameterId);
  if (anchors.length !== 2) throw new Error("Expected two probed Surge scene anchors");
  return sorted.map(parameter => {
    // Character is global although Surge numbers it after both scenes.
    const scene = GLOBAL[parameter.name] ? -1 : parameter.parameterId >= anchors[1] ? 1 : parameter.parameterId >= anchors[0] ? 0 : -1;
    const target = connectorFor(parameter.name, scene >= 0);
    if (!target) throw new Error(`No upstream skin connector for parameter ${parameter.parameterId} "${parameter.name}"`);
    if (!connectors.has(target.connector)) throw new Error(`Upstream skin has no connector ${target.connector}`);
    return { parameter, connector: target.connector, scene, index: target.index };
  });
}

/** The dark skin's SVG artwork the editor draws, keyed by upstream resource ID. */
export const SKIN_RESOURCES = [102, 105, 112, 113, 114, 117, 118, 119, 120, 122, 123, 125, 126, 132, 134, 137, 140, 143, 144, 145, 146, 148, 149, 151, 152, 153, 154, 157, 160, 161, 162, 164, 166, 167, 168, 169, 171, 172, 173, 174, 175, 176, 177, 178, 181, 183, 184, 186, 187, 189, 190, 191] as const;

/** Upstream path of a skin resource: the dark skin, or the classic SVG it inherits. */
/** Upstream sprite variants: the base image and its optional mouse-hover overlays. */
export const SKIN_VARIANTS = ["bmp", "hover", "hoverOn"] as const;
export type SkinVariant = (typeof SKIN_VARIANTS)[number];

export function skinResourcePath(surgeDir: string, resource: number, exists: (path: string) => boolean, variant: SkinVariant = "bmp"): string | undefined {
  const name = `${variant}${String(resource).padStart(5, "0")}.svg`;
  for (const dir of ["resources/data/skins/dark-mode.surge-skin/SVG", "resources/classic-skin-svgs"]) {
    const path = `${surgeDir}/${dir}/${name}`;
    if (exists(path)) return path;
  }
  if (variant === "bmp") throw new Error(`Upstream skin resource ${name} not found`);
  return undefined;
}

export interface SurgeSkin {
  connectors: Map<string, SkinConnector>;
  assets: Array<{ resource: number; variant: SkinVariant; id: string; path: string; width: number; height: number }>;
  fxAcronyms: string[];
}

/** Everything the editor takes from the pinned upstream checkout. */
export function loadSurgeSkin(surgeDir: string, read: (path: string) => string, exists: (path: string) => boolean): SurgeSkin {
  const common = `${surgeDir}/src/common`;
  const connectors = parseSkinModel(read(`${common}/SkinModel.cpp`), read(`${common}/SurgePatch.cpp`), parseResourceIds(read(`${common}/resource.h`)));
  const assets = SKIN_RESOURCES.flatMap(resource => SKIN_VARIANTS.flatMap(variant => {
    const path = skinResourcePath(surgeDir, resource, exists, variant);
    return path ? [{ resource, variant, id: `${variant}${String(resource).padStart(5, "0")}`, path, ...svgSize(read(path)) }] : [];
  }));
  return { connectors, assets, fxAcronyms: parseFxAcronyms(read(`${common}/SurgeStorage.h`)) };
}

/** `fx_type_acronyms` from upstream SurgeStorage.h, in FX type order. */
export function parseFxAcronyms(surgeStorage: string): string[] {
  const body = /fx_type_acronyms\[n_fx_types\]\[\d+\]\s*=\s*\{([^}]*)\}/.exec(surgeStorage)?.[1];
  if (!body) throw new Error("Upstream fx_type_acronyms not found");
  return [...body.matchAll(/"([^"]*)"/g)].map(m => m[1]);
}

export function svgSize(svg: string): { width: number; height: number } {
  const tag = /<svg\b[^>]*>/.exec(svg)?.[0] ?? "";
  const width = Number(/\swidth="([\d.]+)(?:px)?"/.exec(tag)?.[1]), height = Number(/\sheight="([\d.]+)(?:px)?"/.exec(tag)?.[1]);
  if (!(width > 0 && height > 0)) throw new Error("Skin SVG has no intrinsic size");
  return { width, height };
}

export function generateParameterHeader(
  parameters: readonly SurgeParameter[],
  connectors: ReadonlyMap<string, SkinConnector>,
  assets: ReadonlyArray<{ resource: number; variant?: SkinVariant; width: number; height: number }>,
  fxAcronyms: readonly string[],
): string {
  // JSON's escaped strings are valid C++ string literals for the probed UTF-8 names.
  const q = (text: string) => JSON.stringify(text);
  const bindings = bindSurgeParameters(parameters, connectors);
  const list = [...connectors.values()].sort((a, b) => a.id.localeCompare(b.id));
  const index = new Map(list.map((c, i) => [c.id, i]));
  const kinds = Object.values(COMPONENTS);
  const connectorRows = list.map(c => `  {${q(c.id)},${c.x},${c.y},${c.w},${c.h},${kinds.indexOf(c.component)},${c.orientation === "horizontal" ? 1 : c.orientation === "vertical" ? 2 : 0},${c.white},${c.mini},${c.semitone},${c.bipolar},${c.background},${c.frames},${c.rows},${c.columns},${c.frameOffset}},`);
  const bindingRows = bindings.map(b => {
    const choices = b.parameter.display?.choices;
    return `  {${b.parameter.parameterId}u,${q(`surge-param-${b.parameter.parameterId}`)},${q(b.parameter.name)},${b.parameter.defaultValue},${b.parameter.stepCount}u,${index.get(b.connector)},${b.scene},${b.index},{${Array.isArray(choices) ? choices.map(q).join(",") : ""}}},`;
  });
  return `// Generated from probed DSP metadata and the pinned upstream skin model; do not edit.
#pragma once
#include <cstdint>
#include <string>
#include <vector>
namespace surge_ui {
enum Kind { ${kinds.map(k => `K_${k.toUpperCase()}`).join(", ")} };
struct Connector { const char* id; double x, y, w, h; int kind; int orientation; bool white, mini, semitone, bipolar; int background, frames, rows, columns, frameOffset; };
inline const Connector connectors[] = {
${connectorRows.join("\n")}
};
// variant: 0 base image, 1 hover overlay, 2 hover-on-current-value overlay.
struct Asset { int resource; int variant; double width, height; };
inline const Asset assets[] = {
${assets.map(a => `  {${a.resource},${SKIN_VARIANTS.indexOf(a.variant ?? "bmp")},${a.width},${a.height}},`).join("\n")}
};
struct Binding { uint32_t id; const char* componentId; const char* name; double initial; uint32_t steps; int connector; int scene; int index; std::vector<std::string> choices; };
inline const Binding bindings[] = {
${bindingRows.join("\n")}
};
inline const char* const fxAcronyms[] = {${fxAcronyms.map(q).join(",")}};
}
`;
}
