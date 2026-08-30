/**
 * Deterministic Emscripten build of the Surge XT WebVST module.
 *
 * Run with Bun: `bun scripts/build.ts` (or `pnpm run build`).
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
 *   5. configure with the Emscripten CMake toolchain and build with Ninja;
 *   6. copy the result to `build/surgext-webvst.wasm`.
 *
 * Every input path is derived at runtime from this repository, its two
 * submodules, or the Emscripten SDK found on PATH. No developer-specific
 * absolute path is baked in (tests/provenance.test.ts enforces that).
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

const sourceOnly = process.argv.includes("--source-only");

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

async function main(): Promise<void> {
  assertPinnedSubmodule();
  acquireUpstream();
  initialiseSubmodules();
  applyPatches();
  if (sourceOnly) {
    step("--source-only: upstream checkout is prepared; stopping before the native build");
    return;
  }
  configureAndBuild();
  publishArtifact();
}

await main();
