import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * ABI surface lock for the Surge XT WebVST module.
 *
 * This suite is the acceptance gate for the built artifact: it instantiates
 * `build/surgext-webvst.wasm` exactly the way the SDK's own probe
 * (`vendor/webvst-sdk/tools/src/probe.ts`) and package consumer do -- same
 * import allowlist, same WASI environment, `_initialize` before any ABI call --
 * and asserts the generic `webvst_*` contract declared in
 * `vendor/webvst-sdk/include/webvst/webvst.h`.
 *
 * The environment deliberately supplies ONLY `PATH=/usr/bin`, matching the SDK
 * probe. Surge's `SurgeStorage` constructor reads `HOME` and throws when it is
 * absent (there is no WASM exception handling in this build, so a throw is a
 * hard trap). The module must therefore self-provide `HOME`; a host is never
 * required to inject it. See PROVENANCE.md, "Runtime construction".
 */

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const modulePath = join(repoRoot, "build", "surgext-webvst.wasm");

// --- Package identity (must match src/surge_webvst.h) ---------------------------
const ABI_ID = "webvst-vst3-wasm-1";
const PACKAGE_ID = "org.prometheos.webvst.surgext";
/**
 * Read from the submodule, never restated as a literal: the class UID is a
 * function of this pin, so a hardcoded copy here could keep the UID assertion
 * green against a stale pin after a Surge bump. tests/provenance.test.ts owns
 * asserting that this HEAD *is* the intended commit.
 */
const SURGE_PIN = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: join(repoRoot, "vendor", "surge"),
  encoding: "utf8",
}).trim();
const CLASS_NAME = "Surge XT";
const CLASS_VENDOR = "Surge Synth Team";
const WEBVST_KIND_INSTRUMENT = 1;

const WEBVST_OK = 0;
const WEBVST_ERROR_ARGUMENT = -1;
const WEBVST_ERROR_HANDLE = -2;
const WEBVST_ERROR_FRAME_COUNT = -3;
const WEBVST_ERROR_BUFFER_TOO_SMALL = -6;
const WEBVST_PARAMETER_AUTOMATABLE = 1;
const WEBVST_PARAMETER_READ_ONLY = 2;

/**
 * The class UID is a pure function of pinned inputs -- no randomness, no clock.
 * It is the first 16 bytes of SHA-256 over these four newline-joined fields,
 * rendered as 32 lowercase hex characters (the canonical form the ABI and
 * `schema/plugin.schema.json` require). Recomputing it here rather than
 * hardcoding it means the module and this test would have to be changed
 * together to drift.
 */
const CLASS_UID_PREIMAGE = [ABI_ID, PACKAGE_ID, `surge:${SURGE_PIN}`, "class:0"].join("\n");
const EXPECTED_CLASS_UID = createHash("sha256")
  .update(CLASS_UID_PREIMAGE, "utf8")
  .digest("hex")
  .slice(0, 32);

/** The allowlist is owned by the SDK; read it from the SDK rather than restating it. */
function sdkImportAllowlist(): Set<string> {
  const source = readFileSync(join(repoRoot, "vendor/webvst-sdk/tools/src/probe.ts"), "utf8");
  const block = /ALLOWED_WASM_IMPORTS\s*=\s*new Set\(\[([\s\S]*?)\]\)/.exec(source);
  if (!block) throw new Error("could not read ALLOWED_WASM_IMPORTS from the SDK probe");
  const entries = [...block[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  if (entries.length === 0) throw new Error("SDK import allowlist parsed empty");
  return new Set(entries);
}

/** Likewise for the exported-symbol list the SDK's link step installs. */
function sdkExportedFunctions(): Set<string> {
  const source = readFileSync(join(repoRoot, "vendor/webvst-sdk/cmake/WebVstExports.cmake"), "utf8");
  const block = /WEBVST_EXPORTS\s*\r?\n\s*"\[([\s\S]*?)\]"/.exec(source);
  if (!block) throw new Error("could not read WEBVST_EXPORTS from the SDK");
  const entries = [...block[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
  if (entries.length === 0) throw new Error("SDK export list parsed empty");
  // EXPORTED_FUNCTIONS names carry Emscripten's leading underscore; the wasm
  // export name is the bare C symbol.
  return new Set(entries.map((entry) => (entry.startsWith("_") ? entry.slice(1) : entry)));
}

// Exactly the environment the SDK probe supplies: `PATH=/usr/bin`, and nothing else.
const ENVIRONMENT_BYTES = new Uint8Array([80, 65, 84, 72, 61, 47, 117, 115, 114, 47, 98, 105, 110, 0]);

interface AbiInstance {
  readonly memory: WebAssembly.Memory;
  readonly fn: (name: string) => (...args: number[]) => number;
  malloc(size: number): number;
  free(pointer: number): void;
  bytes(): Uint8Array;
  view(): DataView;
}

let wasmModule: WebAssembly.Module;

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
    view: () => new DataView(memory!.buffer),
  };
}

function readAbiString(
  abi: AbiInstance,
  size: number,
  write: (pointer: number, capacity: number) => number,
  label: string,
): string {
  expect(Number.isSafeInteger(size) && size >= 0, `${label}: size is a byte length`).toBe(true);
  if (size === 0) return "";
  const pointer = abi.malloc(size);
  expect(pointer, `${label}: malloc`).not.toBe(0);
  try {
    expect(write(pointer, size), `${label}: write`).toBe(WEBVST_OK);
    const copy = abi.bytes().slice(pointer, pointer + size);
    return new TextDecoder("utf-8", { fatal: true }).decode(copy);
  } finally {
    abi.free(pointer);
  }
}

function classString(abi: AbiInstance, kind: "uid" | "name" | "vendor", classIndex = 0): string {
  const size = abi.fn(`webvst_class_${kind}_size`)(classIndex) >>> 0;
  return readAbiString(
    abi,
    size,
    (pointer, capacity) => abi.fn(`webvst_class_${kind}_write`)(classIndex, pointer, capacity),
    `class ${kind}`,
  );
}

function paramTitle(abi: AbiInstance, index: number): string {
  const size = abi.fn("webvst_class_param_title_size")(0, index) >>> 0;
  return readAbiString(
    abi,
    size,
    (pointer, capacity) => abi.fn("webvst_class_param_title_write")(0, index, pointer, capacity),
    `parameter ${index} title`,
  );
}

/**
 * A continuous (step count 0), automatable parameter -- the kind whose exact
 * normalized value survives a set/get and a state round trip. Surge's first
 * such parameter is used so the choice is deterministic.
 */
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

function paramValueText(abi: AbiInstance, index: number, normalized: number): string {
  const size = abi.fn("webvst_class_param_value_text_size")(0, index, normalized) >>> 0;
  return readAbiString(
    abi,
    size,
    (pointer, capacity) =>
      abi.fn("webvst_class_param_value_text_write")(0, index, normalized, pointer, capacity),
    `parameter ${index} value text`,
  );
}

beforeAll(async () => {
  if (!existsSync(modulePath)) {
    throw new Error(
      `build/surgext-webvst.wasm is missing. Build it first: pnpm run build (bun scripts/build.ts).`,
    );
  }
  const bytes = readFileSync(modulePath);
  wasmModule = await WebAssembly.compile(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  );
}, 120_000);

describe("Surge XT WebVST ABI v1 surface", () => {
  it("imports nothing outside the SDK's AudioWorklet-compatible allowlist", () => {
    const allowed = sdkImportAllowlist();
    const used = WebAssembly.Module.imports(wasmModule).map((entry) => `${entry.module}.${entry.name}`);
    expect(used.length).toBeGreaterThan(0);
    expect(used.filter((name) => !allowed.has(name))).toEqual([]);
  });

  it("exports every SDK ABI symbol and leaks no engine-private symbol", () => {
    const expected = sdkExportedFunctions();
    const exported = WebAssembly.Module.exports(wasmModule);
    const functions = exported.filter((entry) => entry.kind === "function").map((entry) => entry.name);

    // Every symbol the SDK's link step declares is genuinely present.
    expect([...expected].filter((name) => !functions.includes(name))).toEqual([]);

    // Anything beyond that must be Emscripten's own runtime scaffolding.
    // Emscripten emits these two in every standalone build (its JS library's
    // $stackSave/$stackRestore depend on them), and the SDK's probe and package
    // consumer resolve exports by name, so extra toolchain exports are inert.
    // They are not package API, and nothing else is allowed through.
    const toolchainRuntimeExports = new Set([
      "_emscripten_stack_restore",
      "emscripten_stack_get_current",
    ]);
    expect(
      functions.filter((name) => !expected.has(name) && !toolchainRuntimeExports.has(name)),
    ).toEqual([]);

    // The engine and its former ABI must not leak out of the package boundary.
    expect(
      functions.filter(
        (name) => name.startsWith("sx_") || name.startsWith("_Z") || /surge/i.test(name),
      ),
    ).toEqual([]);
    expect(exported.some((entry) => entry.name === "memory" && entry.kind === "memory")).toBe(true);
  });

  /**
   * The GPLv3 binary this repository publishes must not carry the absolute
   * paths of whoever built it. tests/provenance.test.ts enforces that for
   * tracked text files but never opens the .wasm, and two mechanisms leak into
   * it: `__FILE__` in Surge's effect sources, and CMAKE_INSTALL_PREFIX baked
   * into Surge's and sst-plugininfra's configure_file()d sources. Because
   * scripts/build.ts works in a temporary directory, a leaked build path also
   * made consecutive builds by the same developer differ.
   * cmake/SurgeWebVst.cmake closes both; this keeps them closed.
   */
  it("bakes no absolute developer path into the published module", () => {
    const image = readFileSync(modulePath).toString("latin1");

    // A Windows absolute path: a drive letter not itself preceded by a letter
    // (so URL schemes such as "https://" are not mistaken for one), then a
    // separator, then printable path characters. The separator class is built
    // from a char code so this file contains no backslash literal of its own.
    const separators = `[/${String.fromCharCode(92).repeat(2)}]`;
    const windowsPath = new RegExp(`(?<![A-Za-z])[A-Za-z]:${separators}[!-~]{4,200}`, "g");
    const windowsPaths = [...image.matchAll(windowsPath)]
      .map((match) => match[0]);
    expect(windowsPaths).toEqual([]);

    // POSIX home-directory shapes, assembled so these literals never appear in
    // this file (tests/provenance.test.ts scans tracked sources for them).
    // The macOS user-home prefix is deliberately NOT one of them: Surge's own
    // bundled documentation legitimately shows example tuning paths under it,
    // so it is upstream content rather than a leaked build path.
    for (const needle of [["/", "home/"].join(""), ["/", "root/"].join(""), "AppData"]) {
      expect(image.includes(needle), `module contains ${JSON.stringify(needle)}`).toBe(false);
    }
  });

  it("reports ABI version 1 and exactly one class", () => {
    const abi = instantiate();
    expect(abi.fn("webvst_abi_version")() >>> 0).toBe(1);
    expect(abi.fn("webvst_class_count")() >>> 0).toBe(1);
  });

  it("emits the deterministic class UID in canonical lowercase hex", () => {
    const abi = instantiate();
    const uid = classString(abi, "uid");
    expect(uid).toMatch(/^[0-9a-f]{32}$/);
    expect(uid).toBe(EXPECTED_CLASS_UID);
    expect(abi.fn("webvst_class_uid_size")(0) >>> 0).toBe(32);
    // Out-of-range classes are inert, not a trap.
    expect(abi.fn("webvst_class_uid_size")(1) >>> 0).toBe(0);
    expect(abi.fn("webvst_class_uid_write")(1, 0, 0)).toBe(WEBVST_ERROR_ARGUMENT);
  });

  it("names the class, its vendor, and reports the instrument kind", () => {
    const abi = instantiate();
    expect(classString(abi, "name")).toBe(CLASS_NAME);
    expect(classString(abi, "vendor")).toBe(CLASS_VENDOR);
    expect(abi.fn("webvst_class_kind")(0) >>> 0).toBe(WEBVST_KIND_INSTRUMENT);
  });

  it("refuses to write a string into a buffer that is too small", () => {
    const abi = instantiate();
    expect(abi.fn("webvst_class_name_write")(0, 0, 4096)).toBe(WEBVST_ERROR_BUFFER_TOO_SMALL);
    const pointer = abi.malloc(4);
    try {
      expect(abi.fn("webvst_class_name_write")(0, pointer, 1)).toBe(WEBVST_ERROR_BUFFER_TOO_SMALL);
    } finally {
      abi.free(pointer);
    }
  });

  it("answers class parameter metadata without any live instance", () => {
    const abi = instantiate();
    const count = abi.fn("webvst_class_param_count")(0) >>> 0;
    expect(count).toBeGreaterThan(0);
    expect(abi.fn("webvst_class_param_count")(1) >>> 0).toBe(0);

    const ids = new Set<number>();
    let titled = 0;
    let discrete = 0;
    for (let index = 0; index < count; index += 1) {
      const id = abi.fn("webvst_class_param_id")(0, index) >>> 0;
      // Stable Surge parameter IDs: the flat patch-parameter index.
      expect(id, `parameter ${index} id`).toBe(index);
      expect(ids.has(id), `parameter ${id} is unique`).toBe(false);
      ids.add(id);

      const flags = abi.fn("webvst_class_param_flags")(0, index) >>> 0;
      expect(flags & ~(WEBVST_PARAMETER_AUTOMATABLE | WEBVST_PARAMETER_READ_ONLY)).toBe(0);

      const stepCount = abi.fn("webvst_class_param_step_count")(0, index) >>> 0;
      expect(stepCount).toBeLessThanOrEqual(65534);
      if (stepCount > 0) discrete += 1;

      const defaultValue = abi.fn("webvst_class_param_default")(0, index);
      expect(Number.isFinite(defaultValue), `parameter ${index} default is finite`).toBe(true);
      expect(defaultValue).toBeGreaterThanOrEqual(0);
      expect(defaultValue).toBeLessThanOrEqual(1);

      if (paramTitle(abi, index).length > 0) titled += 1;
    }
    expect(titled).toBe(count);
    expect(discrete).toBeGreaterThan(0);
    expect(abi.fn("webvst_class_param_title_write")(0, count, 0, 0)).toBe(WEBVST_ERROR_ARGUMENT);
  });

  it("renders value text for both ends of a discrete parameter", () => {
    const abi = instantiate();
    const count = abi.fn("webvst_class_param_count")(0) >>> 0;
    let checked = 0;
    for (let index = 0; index < count && checked < 8; index += 1) {
      const stepCount = abi.fn("webvst_class_param_step_count")(0, index) >>> 0;
      if (stepCount === 0) continue;
      expect(paramValueText(abi, index, 0).length).toBeGreaterThan(0);
      expect(paramValueText(abi, index, 1).length).toBeGreaterThan(0);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("creates, resets, and destroys an instance", () => {
    const abi = instantiate();
    const handle = abi.fn("webvst_create")(0, 48_000, 128) >>> 0;
    expect(handle).not.toBe(0);
    expect(abi.fn("webvst_reset")(handle)).toBe(WEBVST_OK);
    abi.fn("webvst_destroy")(handle);
    // The handle is stale now, not merely unknown.
    expect(abi.fn("webvst_reset")(handle)).toBe(WEBVST_ERROR_HANDLE);
    expect(abi.fn("webvst_reset")(0)).toBe(WEBVST_ERROR_HANDLE);
  });

  it("rejects out-of-contract create arguments", () => {
    const abi = instantiate();
    expect(abi.fn("webvst_create")(1, 48_000, 128) >>> 0).toBe(0);
    expect(abi.fn("webvst_create")(0, 0, 128) >>> 0).toBe(0);
    expect(abi.fn("webvst_create")(0, -48_000, 128) >>> 0).toBe(0);
    expect(abi.fn("webvst_create")(0, Number.NaN, 128) >>> 0).toBe(0);
    expect(abi.fn("webvst_create")(0, Number.POSITIVE_INFINITY, 128) >>> 0).toBe(0);
    expect(abi.fn("webvst_create")(0, 48_000, 0) >>> 0).toBe(0);
    expect(abi.fn("webvst_create")(0, 48_000, 129) >>> 0).toBe(0);
  });

  it("round-trips normalized parameter values through a handle", () => {
    const abi = instantiate();
    const handle = abi.fn("webvst_create")(0, 48_000, 128) >>> 0;
    expect(handle).not.toBe(0);
    try {
      const count = abi.fn("webvst_class_param_count")(0) >>> 0;
      const target = continuousParameter(abi);

      expect(abi.fn("webvst_param_set")(handle, target, 0.75)).toBe(WEBVST_OK);
      expect(abi.fn("webvst_param_get")(handle, target)).toBeCloseTo(0.75, 4);
      expect(abi.fn("webvst_param_set")(handle, target, 0)).toBe(WEBVST_OK);
      expect(abi.fn("webvst_param_get")(handle, target)).toBeCloseTo(0, 5);

      expect(abi.fn("webvst_param_set")(handle, target, 1.5)).toBe(WEBVST_ERROR_ARGUMENT);
      expect(abi.fn("webvst_param_set")(handle, target, Number.NaN)).toBe(WEBVST_ERROR_ARGUMENT);
      expect(abi.fn("webvst_param_set")(handle, count, 0.5)).toBe(WEBVST_ERROR_ARGUMENT);
      expect(abi.fn("webvst_param_set")(0, target, 0.5)).toBe(WEBVST_ERROR_HANDLE);
      expect(abi.fn("webvst_param_get")(handle, count)).toBe(0);
    } finally {
      abi.fn("webvst_destroy")(handle);
    }
  });

  it("processes arbitrary host block sizes and produces audio after a note-on", () => {
    const abi = instantiate();
    const handle = abi.fn("webvst_create")(0, 48_000, 128) >>> 0;
    expect(handle).not.toBe(0);
    const frames = 128;
    const output = abi.malloc(frames * 2 * 4);
    expect(output).not.toBe(0);
    try {
      // input == NULL is the normal instrument case: silence.
      expect(abi.fn("webvst_process")(handle, 0, output, 0)).toBe(WEBVST_OK);
      expect(abi.fn("webvst_process")(handle, 0, output, frames)).toBe(WEBVST_OK);
      // Any 1..128 span is accepted now: the fixed-block FIFO adapts them to
      // Surge's 32-frame engine block.
      expect(abi.fn("webvst_process")(handle, 0, output, 1)).toBe(WEBVST_OK);
      expect(abi.fn("webvst_process")(handle, 0, output, 31)).toBe(WEBVST_OK);
      expect(abi.fn("webvst_process")(handle, 0, output, 33)).toBe(WEBVST_OK);
      expect(abi.fn("webvst_process")(handle, 0, output, 127)).toBe(WEBVST_OK);
      // Still capped: 160 > WEBVST_MAX_PROCESS_FRAMES (128).
      expect(abi.fn("webvst_process")(handle, 0, output, 160)).toBe(WEBVST_ERROR_FRAME_COUNT);
      expect(abi.fn("webvst_process")(handle, 0, 0, frames)).toBe(WEBVST_ERROR_ARGUMENT);
      expect(abi.fn("webvst_process")(0, 0, output, frames)).toBe(WEBVST_ERROR_HANDLE);

      expect(abi.fn("webvst_note_on")(handle, 60, 0.8)).toBe(WEBVST_OK);
      expect(abi.fn("webvst_note_on")(handle, 128, 0.8)).toBe(WEBVST_ERROR_ARGUMENT);
      expect(abi.fn("webvst_note_on")(handle, -1, 0.8)).toBe(WEBVST_ERROR_ARGUMENT);
      expect(abi.fn("webvst_note_on")(handle, 60, 2)).toBe(WEBVST_ERROR_ARGUMENT);

      let peak = 0;
      for (let block = 0; block < 32; block += 1) {
        expect(abi.fn("webvst_process")(handle, 0, output, frames)).toBe(WEBVST_OK);
        const samples = new Float32Array(abi.memory.buffer, output, frames * 2);
        for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
      }
      expect(peak).toBeGreaterThan(1e-4);
      expect(abi.fn("webvst_note_off")(handle, 60)).toBe(WEBVST_OK);
    } finally {
      abi.free(output);
      abi.fn("webvst_destroy")(handle);
    }
  }, 60_000);

  it("saves and restores a changed parameter, not just a constant-sized blob", () => {
    const abi = instantiate();
    const handle = abi.fn("webvst_create")(0, 48_000, 128) >>> 0;
    expect(handle).not.toBe(0);
    try {
      const target = continuousParameter(abi);
      const saved = 0.25;
      const overwritten = 0.8;

      // Snapshot a patch that DIFFERS from the default. Asserting only that the
      // state size is unchanged across a load would pass even if webvst_state_load
      // did nothing at all: the init patch's size is constant. Task 4 feeds real
      // preset payloads through this same path, so it has to actually load.
      expect(abi.fn("webvst_param_set")(handle, target, saved)).toBe(WEBVST_OK);
      expect(abi.fn("webvst_param_get")(handle, target)).toBeCloseTo(saved, 4);

      const size = abi.fn("webvst_state_size")(handle) >>> 0;
      expect(size).toBeGreaterThan(0);
      const pointer = abi.malloc(size);
      expect(pointer).not.toBe(0);
      try {
        expect(abi.fn("webvst_state_write")(handle, pointer, size)).toBe(WEBVST_OK);
        const state = abi.bytes().slice(pointer, pointer + size);
        // Surge's own patch envelope.
        expect(new TextDecoder().decode(state.subarray(0, 4))).toBe("sub3");
        expect(abi.fn("webvst_state_write")(handle, pointer, size - 1)).toBe(WEBVST_ERROR_BUFFER_TOO_SMALL);
        expect(abi.fn("webvst_state_write")(handle, 0, size)).toBe(WEBVST_ERROR_BUFFER_TOO_SMALL);

        // Move the parameter away, then restore the snapshot over it.
        expect(abi.fn("webvst_param_set")(handle, target, overwritten)).toBe(WEBVST_OK);
        expect(abi.fn("webvst_param_get")(handle, target)).toBeCloseTo(overwritten, 4);

        expect(abi.fn("webvst_state_load")(handle, pointer, size)).toBe(WEBVST_OK);
        expect(abi.fn("webvst_param_get")(handle, target)).toBeCloseTo(saved, 4);
        expect(abi.fn("webvst_state_size")(handle) >>> 0).toBe(size);
      } finally {
        abi.free(pointer);
      }
    } finally {
      abi.fn("webvst_destroy")(handle);
    }
  }, 60_000);

  it("rejects a malformed state blob without disturbing the instance", () => {
    const abi = instantiate();
    const handle = abi.fn("webvst_create")(0, 48_000, 128) >>> 0;
    expect(handle).not.toBe(0);
    try {
      const target = continuousParameter(abi);
      const kept = 0.25;
      expect(abi.fn("webvst_param_set")(handle, target, kept)).toBe(WEBVST_OK);
      const before = abi.fn("webvst_state_size")(handle) >>> 0;

      const junk = abi.malloc(64);
      expect(junk).not.toBe(0);
      try {
        abi.bytes().fill(0x41, junk, junk + 64);
        expect(abi.fn("webvst_state_load")(handle, junk, 64)).toBe(WEBVST_ERROR_ARGUMENT);
        expect(abi.fn("webvst_state_load")(handle, junk, 2)).toBe(WEBVST_ERROR_ARGUMENT);
        expect(abi.fn("webvst_state_load")(handle, 0, 64)).toBe(WEBVST_ERROR_ARGUMENT);
        expect(abi.fn("webvst_state_load")(0, junk, 64)).toBe(WEBVST_ERROR_HANDLE);
      } finally {
        abi.free(junk);
      }

      expect(abi.fn("webvst_state_size")(handle) >>> 0).toBe(before);
      // loadRaw resets the live patch before parsing, so a rejected blob that
      // reached it would silently wipe the instance. It must still read back.
      expect(abi.fn("webvst_param_get")(handle, target)).toBeCloseTo(kept, 4);
    } finally {
      abi.fn("webvst_destroy")(handle);
    }
  }, 60_000);
});
