/**
 * Deterministic Emscripten build of the Surge XT WebVST module, and of the
 * `dist/SurgeXT.webvst` package that ships it.
 *
 * Run with Bun: `bun scripts/build.ts` (or `pnpm run build`).
 * `pnpm run clean-build` is the same thing with `--clean`: it removes every
 * output and the intermediate work tree first, so the build starts genuinely
 * cold. Two clean builds on one machine must produce the same archive bytes.
 *
 * Flow, mirroring the build orchestration this package was extracted from:
 *
 *   1. verify `vendor/surge` still sits on the pinned commit;
 *   2. materialise a throwaway build checkout of that exact commit (the
 *      submodule itself is never written to, so it stays pristine);
 *   3. initialise only the 15 submodules the JUCE-free `src/common` engine
 *      needs, plus sst-plugininfra's own two;
 *   4. apply the three provenance-recorded patches at their recorded
 *      working directories;
 *   5. install and compile the vendored WebVST SDK's authoring tools (they are
 *      distributed as TypeScript sources; `dist/` is never committed);
 *   6. configure with the Emscripten CMake toolchain and build with Ninja;
 *   7. copy the result to `build/surgext-webvst.wasm`;
 *   8. pack the factory presets into one artifact per category;
 *   9. probe the module with the SDK's `generateManifest()`, assert the probed
 *      class identity against `package/webvst.config.json`, merge in the packed
 *      `programs` / `artifacts`, and re-validate;
 *  10. stage manifest + module + presets + licenses, and nothing else;
 *  11. run the SDK's `webvst pack` and then `webvst verify` under Node, and
 *      only once verification passes publish `dist/SurgeXT.webvst` and its
 *      SHA-256 sidecar.
 *
 * Every input path is derived at runtime from this repository, its two
 * submodules, or the Emscripten SDK found on PATH. No developer-specific
 * absolute path is baked in (tests/provenance.test.ts enforces that).
 */

import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  packPresets,
  summaryLine,
  toManifestArtifacts,
  toManifestPrograms,
  writePresetArtifacts,
  PRESETS_STAGING_DIR,
  type ManifestArtifact,
  type ManifestPrograms,
  type PackResult,
} from "./pack-presets";

const root = fileURLToPath(new URL("..", import.meta.url));
const vendorSurgeDir = join(root, "vendor", "surge");
const vendorSdkDir = join(root, "vendor", "webvst-sdk");
const patchesDir = join(root, "patches");
const outputDir = join(root, "build");
const outputWasm = join(outputDir, "surgext-webvst.wasm");

/**
 * Intermediate build state -- a ~1 GB upstream checkout plus CMake/Ninja
 * output -- lives OUTSIDE the repository by default, under the system temp
 * directory. Two reasons: it is genuinely disposable, and tests/provenance.test.ts
 * scans every text file in the working tree for leaked absolute paths, which a
 * generated build tree is full of. Only the finished module lands in `build/`.
 *
 * Override with SURGEXT_WEBVST_WORK_DIR to place it on a different volume.
 */
const workRoot =
  process.env.SURGEXT_WEBVST_WORK_DIR ?? join(tmpdir(), "prometheos-webvst-surgext-build");
const upstreamDir = join(workRoot, "upstream");
const wasmBuildDir = join(workRoot, "wasm");
const builtWasm = join(wasmBuildDir, "surgext-webvst.wasm");

// --- Package inputs and outputs -------------------------------------------------

/** Authoring config: package identity, the class it asserts, and its curation. */
const packageDir = join(root, "package");
const configPath = join(packageDir, "webvst.config.json");
const licensesDir = join(packageDir, "licenses");

/**
 * The exact tree that becomes the archive. It lives in the work tree, not in
 * the repository: it is disposable, it is rebuilt from scratch on every run so
 * a stale file can never be packed, and keeping it out of the working tree
 * keeps tests/provenance.test.ts's leaked-path scan looking only at sources.
 */
const stagingDir = join(workRoot, "staging");

const distDir = join(root, "dist");
const archivePath = join(distDir, "SurgeXT.webvst");
const archiveName = "SurgeXT.webvst";
const checksumPath = `${archivePath}.sha256`;

/** The SDK's authoring tools ship as TypeScript; `dist/` is compiled here. */
const sdkToolsDir = join(vendorSdkDir, "tools");
const sdkToolsDist = join(sdkToolsDir, "dist");

/** Every license the archive must carry, staged verbatim from `package/licenses`. */
const LICENSE_FILES = ["GPL-3.0.txt", "SURGE-NOTICE.txt", "WEBVST-SDK-MIT.txt"] as const;

const sourceOnly = process.argv.includes("--source-only");
const clean = process.argv.includes("--clean");

/** Immutable Surge XT pin. Recorded in PROVENANCE.md and locked by tests/provenance.test.ts. */
const SURGE_PIN = "2644c613fb729cf2ce924c39dc75cf6a61ee9324";

/**
 * The JUCE-free DSP engine (`src/common`) needs exactly these. JUCE, LuaJIT,
 * clap-juce-extensions, MTS-ESP, pybind11 and melatonin_inspector are excluded
 * by the build flags in cmake/SurgeWebVst.cmake and never checked out.
 */
const REQUIRED_SUBMODULES = [
  "libs/eurorack/eurorack",
  "libs/fmt",
  "libs/simde",
  "libs/tuning-library",
  "libs/PEGTL",
  "libs/pffft",
  "libs/sst/sst-basic-blocks",
  "libs/sst/sst-cpputils",
  "libs/sst/sst-effects",
  "libs/sst/sst-filters",
  "libs/sst/sst-plugininfra",
  "libs/sst/sst-waveshapers",
  "libs/sst/sst-cmake",
  "libs/r8brain-free-src",
  "libs/zstd",
] as const;

/** sst-plugininfra carries its own nested submodules. */
const NESTED_SUBMODULES: Record<string, readonly string[]> = {
  "libs/sst/sst-plugininfra": ["libs/filesystem/ghc-filesystem", "libs/miniz"],
};

/** Apply order and working directory are provenance, not convenience. */
const PATCHES: readonly { file: string; cwd: string }[] = [
  { file: "0001-emscripten-build-portability.patch", cwd: "" },
  { file: "0002-sst-plugininfra-emscripten-stacktrace.patch", cwd: "libs/sst/sst-plugininfra" },
  {
    file: "0003-sst-plugininfra-emscripten-shared-library-path.patch",
    cwd: "libs/sst/sst-plugininfra",
  },
];

/**
 * Bun.spawnSync on Windows starts a real Windows process, so any path-shaped
 * value handed to it must be Windows-formatted, not the POSIX form an MSYS
 * shell may export.
 */
function toWindowsPath(value: string): string {
  const match = /^\/([a-zA-Z])\/(.*)$/.exec(value);
  if (!match) return value;
  return `${match[1]!.toUpperCase()}:\\${match[2]!.replace(/\//g, "\\")}`;
}

interface RunOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  allowFailure?: boolean;
}

function run(cmd: string[], options: RunOptions = {}): { code: number; out: string; err: string } {
  const result = Bun.spawnSync(cmd, {
    cwd: options.cwd ?? root,
    env: options.env ?? process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = result.stdout.toString();
  const err = result.stderr.toString();
  if (result.exitCode !== 0 && !options.allowFailure) {
    throw new Error(`${cmd.join(" ")} (cwd=${options.cwd ?? root}) failed:\n${err}${out}`);
  }
  return { code: result.exitCode ?? 1, out, err };
}

function step(message: string): void {
  console.log(`[surgext-webvst] ${message}`);
}

// --- Emscripten discovery -------------------------------------------------------

/** `<emsdk>/upstream/emscripten`, found from the environment or from PATH. */
function emscriptenDir(): string {
  const fromEnv = process.env.EMSDK_EMSCRIPTEN_BIN;
  if (fromEnv) return toWindowsPath(fromEnv);
  const emcc = Bun.which("em++") ?? Bun.which("emcc");
  if (emcc) return dirname(emcc);
  for (const entry of (process.env.PATH ?? "").split(delimiter)) {
    if (!entry) continue;
    const dir = toWindowsPath(entry);
    for (const name of ["em++.bat", "em++", "emcc.bat", "emcc"]) {
      if (existsSync(join(dir, name))) return dir;
    }
  }
  throw new Error(
    "Could not locate the Emscripten SDK. Put emcc/em++ on PATH, or set EMSDK_EMSCRIPTEN_BIN.",
  );
}

/**
 * emcc's Windows entry point runs `%EMSDK_PYTHON%`, falling back to a bare
 * `python` that a stock Windows install resolves to a Store stub. Resolve the
 * interpreter the SDK ships with rather than depending on the shell's.
 */
function emsdkPython(emscripten: string): string | undefined {
  const fromEnv = process.env.EMSDK_PYTHON;
  if (fromEnv) return toWindowsPath(fromEnv);
  if (process.platform !== "win32") return undefined;

  const emsdkRoot = dirname(dirname(emscripten));
  const configPath = join(emsdkRoot, ".emscripten");
  if (existsSync(configPath)) {
    const configured = /PYTHON\s*=\s*emsdk_path\s*\+\s*['"]([^'"]+)['"]/.exec(
      readFileSync(configPath, "utf8"),
    );
    if (configured) {
      const resolved = join(emsdkRoot, configured[1]!.replace(/^\/+/, ""));
      if (existsSync(resolved)) return resolved;
    }
  }

  const pythonRoot = join(emsdkRoot, "python");
  if (!existsSync(pythonRoot)) return undefined;
  const versionKey = (name: string): number[] =>
    (name.match(/\d+/g) ?? []).slice(0, 3).map((part) => Number.parseInt(part, 10));
  const candidates = readdirSync(pythonRoot)
    .filter((name) => existsSync(join(pythonRoot, name, "python.exe")))
    .sort((a, b) => {
      const left = versionKey(a);
      const right = versionKey(b);
      for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
        const diff = (right[i] ?? 0) - (left[i] ?? 0);
        if (diff !== 0) return diff;
      }
      return 0;
    });
  return candidates.length > 0 ? join(pythonRoot, candidates[0]!, "python.exe") : undefined;
}

function buildEnvironment(emscripten: string): Record<string, string | undefined> {
  const python = emsdkPython(emscripten);
  return {
    ...process.env,
    ...(python ? { EMSDK_PYTHON: python, PYTHON: python } : {}),
    EMSDK_EMSCRIPTEN_BIN: emscripten,
  };
}

// --- Source acquisition ---------------------------------------------------------

function assertPinnedSubmodule(): void {
  if (!existsSync(join(vendorSurgeDir, "CMakeLists.txt"))) {
    throw new Error(
      `vendor/surge is not checked out. Run: git submodule update --init vendor/surge`,
    );
  }
  const head = run(["git", "rev-parse", "HEAD"], { cwd: vendorSurgeDir }).out.trim();
  if (head !== SURGE_PIN) {
    throw new Error(`vendor/surge is at ${head}, expected the pinned commit ${SURGE_PIN}`);
  }
  if (!existsSync(join(vendorSdkDir, "include", "prometheos", "webvst.h"))) {
    throw new Error(
      `vendor/webvst-sdk is not checked out. Run: git submodule update --init vendor/webvst-sdk`,
    );
  }
}

/**
 * A throwaway checkout of the pin, cloned from the local submodule with shared
 * objects (fast, no second copy of Surge's history) so `vendor/surge` itself is
 * never modified by patching or submodule initialisation.
 */
function acquireUpstream(): void {
  if (!existsSync(join(upstreamDir, ".git"))) {
    step("cloning the pinned Surge XT checkout into the build tree");
    mkdirSync(workRoot, { recursive: true });
    run(["git", "clone", "--shared", "--no-checkout", vendorSurgeDir, upstreamDir]);
  }
  run(["git", "checkout", "-f", SURGE_PIN], { cwd: upstreamDir });
  const head = run(["git", "rev-parse", "HEAD"], { cwd: upstreamDir }).out.trim();
  if (head !== SURGE_PIN) {
    throw new Error(`build checkout resolved to ${head}, expected ${SURGE_PIN}`);
  }
}

function submoduleIsPopulated(relative: string): boolean {
  const dir = join(upstreamDir, ...relative.split("/"));
  return existsSync(dir) && statSync(dir).isDirectory() && readdirSync(dir).length > 0;
}

function initialiseSubmodules(): void {
  const missing = REQUIRED_SUBMODULES.filter((path) => !submoduleIsPopulated(path));
  if (missing.length > 0) {
    step(`initialising ${missing.length} Surge submodule(s) (network; this takes a few minutes)`);
    run(["git", "submodule", "update", "--init", "--depth", "1", ...missing], { cwd: upstreamDir });
  }
  for (const [parent, children] of Object.entries(NESTED_SUBMODULES)) {
    const parentDir = join(upstreamDir, ...parent.split("/"));
    const absent = children.filter((child) => {
      const dir = join(parentDir, ...child.split("/"));
      return !existsSync(dir) || readdirSync(dir).length === 0;
    });
    if (absent.length === 0) continue;
    step(`initialising ${absent.length} nested submodule(s) under ${parent}`);
    run(["git", "submodule", "update", "--init", "--depth", "1", ...absent], { cwd: parentDir });
  }
}

function applyPatches(): void {
  for (const patch of PATCHES) {
    const patchPath = join(patchesDir, patch.file);
    const cwd = patch.cwd ? join(upstreamDir, ...patch.cwd.split("/")) : upstreamDir;
    const alreadyApplied =
      run(["git", "apply", "--reverse", "--check", patchPath], { cwd, allowFailure: true }).code === 0;
    if (alreadyApplied) continue;
    step(`applying ${patch.file}`);
    run(["git", "apply", patchPath], { cwd });
  }
}

// --- Native build ---------------------------------------------------------------

function cmakePath(value: string): string {
  return value.replace(/\\/g, "/");
}

function configureAndBuild(): void {
  const emscripten = emscriptenDir();
  const toolchain = join(emscripten, "cmake", "Modules", "Platform", "Emscripten.cmake");
  if (!existsSync(toolchain)) {
    throw new Error(`Emscripten CMake toolchain not found at ${toolchain}`);
  }
  const env = buildEnvironment(emscripten);
  mkdirSync(wasmBuildDir, { recursive: true });

  step("configuring (cmake + Emscripten toolchain + Ninja)");
  const configure = [
    "cmake",
    "-G",
    "Ninja",
    "-S",
    cmakePath(root),
    "-B",
    cmakePath(wasmBuildDir),
    "-DCMAKE_BUILD_TYPE=Release",
    `-DCMAKE_TOOLCHAIN_FILE=${cmakePath(toolchain)}`,
    // Set on the command line so it lands in the cache before project() and the
    // Emscripten toolchain default it to the emsdk sysroot (an absolute path
    // under the developer's home). cmake/SurgeWebVst.cmake also forces it, but
    // that `set(... CACHE ... FORCE)` runs inside a function after project() has
    // already materialised the normal variable, so on a from-empty configure it
    // does not win and the sysroot path leaks into Surge's and sst-plugininfra's
    // configure_file()d C++ string literals. Nothing is ever installed, so the
    // synthetic prefix costs nothing. tests/abi_surface.test.ts enforces this.
    "-DCMAKE_INSTALL_PREFIX=/webvst",
    `-DSURGE_WEBVST_UPSTREAM_DIR=${cmakePath(upstreamDir)}`,
    `-DSURGE_WEBVST_SDK_DIR=${cmakePath(vendorSdkDir)}`,
  ];
  console.log(`[surgext-webvst] ${configure.join(" ")}`);
  const configured = run(configure, { env, allowFailure: true });
  process.stdout.write(configured.out);
  if (configured.code !== 0) {
    process.stderr.write(configured.err);
    throw new Error("cmake configure failed");
  }

  step("building (this takes several minutes)");
  const build = run(["cmake", "--build", cmakePath(wasmBuildDir)], { env, allowFailure: true });
  process.stdout.write(build.out);
  if (build.code !== 0) {
    process.stderr.write(build.err);
    throw new Error("cmake build failed");
  }
}

function publishArtifact(): void {
  if (!existsSync(builtWasm)) {
    throw new Error(`the build produced no module at ${builtWasm}`);
  }
  mkdirSync(outputDir, { recursive: true });
  if (builtWasm !== outputWasm) cpSync(builtWasm, outputWasm);
  const { size } = statSync(outputWasm);
  step(`wrote build/surgext-webvst.wasm (${size.toLocaleString("en-US")} bytes)`);
}

// --- WebVST package -------------------------------------------------------------

interface AuthoredClass {
  classUid: string;
  name: string;
  vendor: string;
  kind: "instrument" | "effect";
}

/** The shape of `package/webvst.config.json` this script consumes. */
interface AuthorConfig {
  packageId: string;
  version: string;
  abi: string;
  modulePath: string;
  class: AuthoredClass;
  curation: unknown[];
}

interface ManifestClass extends AuthoredClass {
  exposedParameters: Array<{ parameterId: number; buzz: Record<string, unknown> }>;
  programs?: ManifestPrograms;
}

interface WebVstManifest {
  schemaVersion: 1;
  packageId: string;
  version: string;
  abi: string;
  module: { path: string; sha256: string };
  classes: ManifestClass[];
  artifacts?: ManifestArtifact[];
}

interface SdkManifestTools {
  generateManifest(config: {
    wasm: Uint8Array;
    packageId: string;
    version: string;
    modulePath: string;
    curation?: unknown[];
  }): Promise<WebVstManifest>;
  validateManifest(value: unknown): WebVstManifest;
}

function sdkToolsReady(): boolean {
  return (
    ["cli.js", "manifest.js", "archive.js", "probe.js"].every((file) =>
      existsSync(join(sdkToolsDist, file)),
    ) &&
    // A previous run can leave `dist/` behind after a failed install: tsc emits
    // JavaScript even when type resolution failed, and the emitted manifest.js
    // still imports `zod` at runtime. Treat the dependency tree as part of the
    // artefact, not as an independent concern.
    existsSync(join(sdkToolsDir, "node_modules", "zod"))
  );
}

/**
 * Installs and compiles `vendor/webvst-sdk/tools`. The submodule ships only
 * sources -- no `dist/`, no `node_modules` -- so the package build has to
 * produce them; both are build output and neither is committed.
 *
 * `--ignore-workspace` is load-bearing. This repository's own
 * pnpm-workspace.yaml (`packages: []`) is the nearest workspace root above the
 * tools directory, and without the flag pnpm decides the tools are not a
 * workspace member and installs *nothing at all*, silently, in under a second.
 * The subsequent `tsc` then emits JavaScript that cannot resolve `zod`.
 */
function prepareSdkTools(): void {
  if (sdkToolsReady()) return;
  step("installing the WebVST SDK tools' dependencies (network)");
  run(["pnpm", "install", "--frozen-lockfile", "--ignore-workspace"], { cwd: sdkToolsDir });
  step("compiling the WebVST SDK tools");
  run(["pnpm", "run", "build"], { cwd: sdkToolsDir });
  if (!sdkToolsReady()) {
    throw new Error(`the WebVST SDK tools did not compile into ${sdkToolsDist}`);
  }
}

/**
 * Loads the compiled manifest tools through Node's own resolver (a file URL),
 * so their `zod` dependency resolves from the tools' own `node_modules` rather
 * than this repository's. Dynamic, because `dist/` does not exist until
 * `prepareSdkTools()` has run.
 *
 * Only the manifest half is imported in-process. Manifest generation has to
 * be, because the in-process API is the only one that accepts the authored
 * `curation` and can hand back an object to merge `programs` / `artifacts`
 * into -- and its output is spec-defined JSON over probed integers and
 * strings, byte-identical whichever runtime produces it. Packing is not: see
 * `webvst()`.
 */
async function loadSdkManifestTools(): Promise<SdkManifestTools> {
  return (await import(pathToFileURL(join(sdkToolsDist, "manifest.js")).href)) as SdkManifestTools;
}

/**
 * Runs the SDK's `webvst` CLI, always under Node.
 *
 * The container is deflated, and deflate output is a property of the zlib the
 * runtime links rather than of the ZIP format: packing this exact staging tree
 * under Bun yields 8,504,047 bytes and under Node 8,408,156 -- both valid, but
 * not the same archive. The SDK's tools are a Node program (`bin: dist/cli.js`,
 * `#!/usr/bin/env node`), so Node is the runtime that defines these bytes.
 * Shelling out pins them there and keeps the published archive independent of
 * whatever runtime happens to execute this script.
 */
function webvst(args: string[]): string {
  const node = Bun.which("node") ?? "node";
  const { out, err } = run([node, join(sdkToolsDist, "cli.js"), ...args]);
  process.stdout.write(out);
  if (err) process.stderr.write(err);
  return out;
}

function readAuthorConfig(): AuthorConfig {
  if (!existsSync(configPath)) throw new Error(`missing authoring config at ${configPath}`);
  return JSON.parse(readFileSync(configPath, "utf8")) as AuthorConfig;
}

/**
 * The probe is authoritative and the config is an assertion about it: the
 * config records the class identity the package claims to publish, and the
 * module reports the identity it actually has. A divergence means the config
 * is stale (or the module is not the one it describes), and either way the
 * package must not be built -- a host resolves plugins by class UID, so
 * shipping a manifest that disagrees with the module is a silent mis-identity
 * rather than a loud failure.
 */
function assertClassIdentity(manifest: WebVstManifest, config: AuthorConfig): void {
  if (manifest.classes.length !== 1) {
    throw new Error(
      `the module reports ${manifest.classes.length} classes; package/webvst.config.json declares exactly one`,
    );
  }
  const probed = manifest.classes[0]!;
  const drift = (["classUid", "name", "vendor", "kind"] as const)
    .filter((key) => probed[key] !== config.class[key])
    .map((key) => `${key}: probed ${JSON.stringify(probed[key])}, authored ${JSON.stringify(config.class[key])}`);
  if (drift.length > 0) {
    throw new Error(
      `the module's class identity disagrees with package/webvst.config.json -- ${drift.join("; ")}`,
    );
  }
  if (manifest.abi !== config.abi) {
    throw new Error(
      `the SDK emitted ABI ${JSON.stringify(manifest.abi)}; package/webvst.config.json declares ${JSON.stringify(config.abi)}`,
    );
  }
}

/**
 * The manifest the archive carries. The SDK probes the module for identity and
 * parameters and emits nothing else; the preset `programs` and the top-level
 * `artifacts` come from the packer, are merged in here, and the whole is
 * re-validated against the SDK's strict schema before it is written.
 */
async function buildManifest(
  sdk: SdkManifestTools,
  config: AuthorConfig,
  packed: PackResult,
): Promise<WebVstManifest> {
  step("probing the module for its manifest (SDK generateManifest)");
  const manifest = await sdk.generateManifest({
    wasm: new Uint8Array(readFileSync(outputWasm)),
    packageId: config.packageId,
    version: config.version,
    modulePath: config.modulePath,
    curation: config.curation,
  });
  assertClassIdentity(manifest, config);
  step(
    `class ${manifest.classes[0]!.classUid} "${manifest.classes[0]!.name}" ` +
      `(${manifest.classes[0]!.kind}), ${manifest.classes[0]!.exposedParameters.length} exposed parameters`,
  );
  manifest.classes[0]!.programs = toManifestPrograms(packed);
  manifest.artifacts = toManifestArtifacts(packed);
  return sdk.validateManifest(manifest);
}

/** Every file in the staging tree, as sorted archive-relative POSIX paths. */
function stagedEntries(dir: string, prefix = ""): string[] {
  const names: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const name = `${prefix}${entry.name}`;
    if (entry.isDirectory()) names.push(...stagedEntries(join(dir, entry.name), `${name}/`));
    else names.push(name);
  }
  return names.sort();
}

/**
 * The staging tree is the archive: whatever is here is what ships. Check the
 * entry set exactly rather than trusting the code above to have written only
 * what it meant to -- a leftover file from a previous shape of this script, or
 * an editor's backup, would otherwise be published under GPLv3 with a hash.
 */
function assertStagingContents(config: AuthorConfig, packed: PackResult): void {
  const expected = [
    "plugin.json",
    config.modulePath,
    ...LICENSE_FILES.map((file) => `licenses/${file}`),
    ...packed.categories.map((category) => category.artifactPath),
  ].sort();
  const actual = stagedEntries(stagingDir);
  const unexpected = actual.filter((name) => !expected.includes(name));
  const missing = expected.filter((name) => !actual.includes(name));
  if (unexpected.length > 0 || missing.length > 0) {
    throw new Error(
      `the staging tree is not the declared package` +
        (missing.length > 0 ? `; missing: ${missing.join(", ")}` : "") +
        (unexpected.length > 0 ? `; unexpected: ${unexpected.join(", ")}` : ""),
    );
  }
  // The container format forbids executable JavaScript outright; the SDK's
  // verifier rejects it too, but failing here names the offending file.
  const scripts = actual.filter((name) => /\.(?:js|mjs|cjs)$/i.test(name));
  if (scripts.length > 0) {
    throw new Error(`the staging tree contains executable JavaScript: ${scripts.join(", ")}`);
  }
}

/**
 * Builds `dist/SurgeXT.webvst` from the module in `build/`, the pinned factory
 * presets, and the authored identity. `dist/` is written last and only after
 * the SDK's verifier has accepted the bytes.
 */
async function packageArchive(): Promise<void> {
  prepareSdkTools();
  const sdk = await loadSdkManifestTools();
  const config = readAuthorConfig();

  step("packing the factory presets");
  const packed = packPresets();
  writePresetArtifacts(packed, PRESETS_STAGING_DIR);
  step(summaryLine(packed));

  const manifest = await buildManifest(sdk, config, packed);

  rmSync(stagingDir, { recursive: true, force: true });
  mkdirSync(join(stagingDir, "licenses"), { recursive: true });
  writePresetArtifacts(packed, join(stagingDir, "presets"));
  // Exactly as `webvst manifest` writes it: one canonical line, one newline.
  writeFileSync(join(stagingDir, "plugin.json"), `${JSON.stringify(manifest)}\n`);
  cpSync(outputWasm, join(stagingDir, config.modulePath));
  for (const file of LICENSE_FILES) cpSync(join(licensesDir, file), join(stagingDir, "licenses", file));
  assertStagingContents(config, packed);

  // Pack beside the staging tree, not into dist/: dist/ is the published
  // result and must not exist in an unverified state, not even briefly.
  const stagedArchive = join(workRoot, archiveName);
  rmSync(stagedArchive, { force: true });
  step("packing the .webvst archive (webvst pack)");
  webvst(["pack", stagingDir, stagedArchive]);
  step("verifying the archive (webvst verify)");
  const report = webvst(["verify", stagedArchive]);

  const archive = readFileSync(stagedArchive);
  const digest = createHash("sha256").update(archive).digest("hex");
  const reported = /Archive SHA-256:\s*([0-9a-f]{64})/.exec(report)?.[1];
  if (reported !== digest) {
    throw new Error(`the verifier reported SHA-256 ${reported}, but the packed file hashes to ${digest}`);
  }
  const verifiedArtifacts = [...report.matchAll(/^Artifact: /gm)].length;
  if (verifiedArtifacts !== packed.categoryCount) {
    throw new Error(
      `the verifier accounted for ${verifiedArtifacts} artifact(s); the pack produced ${packed.categoryCount}`,
    );
  }

  mkdirSync(distDir, { recursive: true });
  cpSync(stagedArchive, archivePath);
  writeFileSync(checksumPath, `${digest}  ${archiveName}\n`);

  step(`wrote dist/${archiveName} (${archive.byteLength.toLocaleString("en-US")} bytes)`);
  step(`  ${summaryLine(packed)} in ${verifiedArtifacts} preset artifact(s)`);
  step(`  SHA-256 ${digest}`);
}

/**
 * `--clean`: remove every output and the whole intermediate work tree, so the
 * run that follows starts from nothing. This is the determinism gate -- two
 * clean builds on one machine must agree byte for byte -- and it is also the
 * only thing that exercises a from-empty upstream checkout, where the patch
 * step actually has to apply rather than detect itself already applied.
 */
function cleanOutputs(): void {
  for (const target of [distDir, PRESETS_STAGING_DIR, outputDir, workRoot]) {
    if (!existsSync(target)) continue;
    const label = relative(root, target);
    step(`removing ${label.startsWith("..") ? "the build work tree" : label}`);
    rmSync(target, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  if (clean) cleanOutputs();
  assertPinnedSubmodule();
  acquireUpstream();
  initialiseSubmodules();
  applyPatches();
  if (sourceOnly) {
    step("--source-only: upstream checkout is prepared; stopping before the native build");
    return;
  }
  // Before the multi-minute compile, so a missing network or a broken tools
  // install fails in seconds rather than after Surge has finished building.
  prepareSdkTools();
  configureAndBuild();
  publishArtifact();
  await packageArchive();
}

await main();
