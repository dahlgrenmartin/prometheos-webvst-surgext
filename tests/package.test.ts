import { describe, it, expect, beforeAll } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  packPresets,
  toManifestArtifacts,
  toManifestPrograms,
  type PackResult,
} from "../scripts/pack-presets";
import { readArchiveEntries } from "./webvst_archive";

/**
 * Acceptance gate for the published `dist/SurgeXT.webvst`.
 *
 * This suite opens the shipped container and asserts the four properties the
 * package makes to a host:
 *
 *   1. it is *deterministic* -- every byte in it is a function of the pinned
 *      inputs, so two builds of the same sources produce the same archive;
 *   2. it contains *exactly* the declared entry set -- one module, the packed
 *      presets, the licenses, the manifest, and nothing else (in particular no
 *      executable JavaScript, which the container format forbids outright);
 *   3. its *identity* is the one `package/webvst.config.json` authored; and
 *   4. it passes the SDK's own `verifyWebVst` -- ABI 1, import allowlist,
 *      probe-vs-manifest class agreement, and valid content hashes.
 *
 * Determinism is proved structurally rather than by building twice (a second
 * Surge compile takes tens of minutes). Every byte of the archive is traced
 * back to a primary source: the module to `build/surgext-webvst.wasm`, the
 * preset artifacts to a fresh `packPresets()` over the pinned factory tree,
 * the licenses to `package/licenses/`, and the container framing itself by
 * re-packing the extracted entries and comparing byte-for-byte. `pnpm run
 * clean-build`, run twice, is the end-to-end check that this suite backstops.
 */

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const archivePath = join(repoRoot, "dist", "SurgeXT.webvst");
const checksumPath = `${archivePath}.sha256`;
const modulePath = join(repoRoot, "build", "surgext-webvst.wasm");
const configPath = join(repoRoot, "package", "webvst.config.json");
const licensesDir = join(repoRoot, "package", "licenses");
const sdkToolsDist = join(repoRoot, "vendor", "webvst-sdk", "tools", "dist");

const LICENSE_FILES = ["GPL-3.0.txt", "SURGE-NOTICE.txt", "WEBVST-SDK-MIT.txt"] as const;

/**
 * The 17 factory categories, as slugs, stated independently of the packer so
 * that a change in either one has to be a deliberate change in both. Task 4
 * derives these from `vendor/surge`'s pinned patch tree.
 */
const PRESET_SLUGS = [
  "basses",
  "brass",
  "chords",
  "fx",
  "keys",
  "leads",
  "mpe",
  "pads",
  "percussion",
  "plucks",
  "polysynths",
  "sequences",
  "splits",
  "templates",
  "tutorials",
  "vocoder",
  "winds",
] as const;

const EXPECTED_CATEGORY_COUNT = 17;
const EXPECTED_PRESET_COUNT = 641;

interface ManifestProgramEntry {
  name: string;
  artifactId: string;
  offset: number;
  size: number;
}
interface ManifestArtifact {
  id: string;
  path: string;
  sha256: string;
  role: string;
}
interface Manifest {
  schemaVersion: number;
  packageId: string;
  version: string;
  abi: string;
  module: { path: string; sha256: string };
  classes: Array<{
    classUid: string;
    name: string;
    vendor: string;
    kind: string;
    exposedParameters: Array<{ parameterId: number; buzz: Record<string, unknown> }>;
    programs?: { categories: Array<{ name: string; entries: ManifestProgramEntry[] }> };
  }>;
  artifacts?: ManifestArtifact[];
}

interface AuthorConfig {
  packageId: string;
  version: string;
  abi: string;
  modulePath: string;
  class: { classUid: string; name: string; vendor: string; kind: string };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function expectedEntryNames(): string[] {
  return [
    "plugin.json",
    "plugin.wasm",
    ...LICENSE_FILES.map((file) => `licenses/${file}`),
    ...PRESET_SLUGS.map((slug) => `presets/${slug}.bin`),
  ].sort();
}

let archive: Uint8Array;
let entries: Map<string, Uint8Array>;
let manifest: Manifest;
let config: AuthorConfig;
let packed: PackResult;
// The SDK's compiled tools, loaded through Node's own resolver so the vendored
// `zod` dependency resolves from the tools workspace rather than this one.
let sdk: {
  packWebVst: (staging: string) => Promise<Uint8Array>;
  verifyWebVst: (archive: Uint8Array) => Promise<{
    packageId: string;
    version: string;
    archiveSha256: string;
    abi: string;
    classes: Array<{ classUid: string; name: string; kind: string; parameterCount: number }>;
    artifacts: Array<{ id: string; path: string; sha256: string }>;
  }>;
};
let allowedImports: Set<string>;

async function loadSdk(): Promise<void> {
  const archiveModule = join(sdkToolsDist, "archive.js");
  if (!existsSync(archiveModule)) {
    throw new Error(
      "the WebVST SDK tools are not built. Run `pnpm run build`, which installs and compiles " +
        "vendor/webvst-sdk/tools before it packs the archive.",
    );
  }
  sdk = (await import(/* @vite-ignore */ pathToFileURL(archiveModule).href)) as typeof sdk;
  const probe = (await import(
    /* @vite-ignore */ pathToFileURL(join(sdkToolsDist, "probe.js")).href
  )) as { ALLOWED_WASM_IMPORTS: Set<string> };
  allowedImports = probe.ALLOWED_WASM_IMPORTS;
}

beforeAll(async () => {
  if (!existsSync(archivePath)) {
    throw new Error(
      "dist/SurgeXT.webvst is missing. Build the package first: pnpm run build (bun scripts/build.ts).",
    );
  }
  archive = new Uint8Array(readFileSync(archivePath));
  entries = readArchiveEntries(archive);
  const manifestBytes = entries.get("plugin.json");
  if (!manifestBytes) throw new Error("the archive contains no plugin.json");
  manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes)) as Manifest;
  config = JSON.parse(readFileSync(configPath, "utf8")) as AuthorConfig;
  packed = packPresets();
  await loadSdk();
}, 300_000);

describe("dist/SurgeXT.webvst container", () => {
  it("contains exactly the declared entry set", () => {
    expect([...entries.keys()].sort()).toEqual(expectedEntryNames());
  });

  it("ships no executable JavaScript sidecar", () => {
    expect([...entries.keys()].filter((name) => /\.(?:js|mjs|cjs)$/i.test(name))).toEqual([]);
  });

  it("ships exactly one WebAssembly module, the one the manifest declares", () => {
    const modules = [...entries.keys()].filter((name) => name.endsWith(".wasm"));
    expect(modules).toEqual(["plugin.wasm"]);
    expect(manifest.module.path).toBe("plugin.wasm");
    expect(manifest.module.path).toBe(config.modulePath);
  });

  it("records the archive SHA-256 in a sidecar next to it", () => {
    expect(existsSync(checksumPath)).toBe(true);
    const sidecar = readFileSync(checksumPath, "utf8");
    const match = /^([0-9a-f]{64}) {2}SurgeXT\.webvst\n$/.exec(sidecar);
    expect(match, `sidecar is "<sha256>  SurgeXT.webvst": ${JSON.stringify(sidecar)}`).not.toBe(
      null,
    );
    expect(match![1]).toBe(sha256(archive));
  });
});

describe("dist/SurgeXT.webvst identity", () => {
  it("carries the package identity package/webvst.config.json authors", () => {
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.packageId).toBe(config.packageId);
    expect(manifest.version).toBe(config.version);
    expect(manifest.abi).toBe(config.abi);
    expect(manifest.abi).toBe("prometheos-vst3-wasm-1");
  });

  it("carries exactly one class, whose identity matches the authored class", () => {
    expect(manifest.classes).toHaveLength(1);
    const [entry] = manifest.classes;
    // The authored block carries a `$comment` alongside the four identity
    // fields; compare the identity, field by field, not the JSON object.
    for (const key of ["classUid", "name", "vendor", "kind"] as const) {
      expect(entry[key], key).toBe(config.class[key]);
    }
    expect(entry.exposedParameters.length).toBeGreaterThan(0);
  });

  it("serialises the manifest as the SDK writes it: one canonical line", () => {
    const text = new TextDecoder().decode(entries.get("plugin.json")!);
    expect(text).toBe(`${JSON.stringify(manifest)}\n`);
    expect(text.split("\n")).toHaveLength(2);
  });
});

describe("dist/SurgeXT.webvst determinism", () => {
  it("carries the module built into build/, byte for byte", () => {
    const shipped = entries.get("plugin.wasm")!;
    const built = new Uint8Array(readFileSync(modulePath));
    expect(Buffer.from(shipped).equals(Buffer.from(built))).toBe(true);
    expect(manifest.module.sha256).toBe(sha256(built));
  });

  it("carries the licenses staged in package/licenses, byte for byte", () => {
    for (const file of LICENSE_FILES) {
      const shipped = entries.get(`licenses/${file}`)!;
      const staged = new Uint8Array(readFileSync(join(licensesDir, file)));
      expect(Buffer.from(shipped).equals(Buffer.from(staged)), file).toBe(true);
    }
  });

  it("carries preset artifacts a fresh pack of the pinned factory tree reproduces", () => {
    for (const category of packed.categories) {
      const shipped = entries.get(category.artifactPath);
      expect(shipped, category.artifactPath).toBeDefined();
      expect(Buffer.from(shipped!).equals(category.bytes), category.artifactPath).toBe(true);
    }
    expect(manifest.artifacts).toEqual(toManifestArtifacts(packed));
    expect(manifest.classes[0].programs).toEqual(toManifestPrograms(packed));
  });

  it("re-packs to the same container bytes from its own contents", async () => {
    const staging = mkdtempSync(join(tmpdir(), "surgext-webvst-repack-"));
    try {
      for (const [name, data] of entries) {
        const target = join(staging, ...name.split("/"));
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, data);
      }
      const repacked = await sdk.packWebVst(staging);
      expect(Buffer.from(repacked).equals(Buffer.from(archive))).toBe(true);
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }, 300_000);
});

describe("dist/SurgeXT.webvst preset programs", () => {
  it("declares 641 presets across 17 categories", () => {
    const categories = manifest.classes[0].programs?.categories ?? [];
    expect(categories).toHaveLength(EXPECTED_CATEGORY_COUNT);
    expect(categories.reduce((total, category) => total + category.entries.length, 0)).toBe(
      EXPECTED_PRESET_COUNT,
    );
    expect(packed.categoryCount).toBe(EXPECTED_CATEGORY_COUNT);
    expect(packed.presetCount).toBe(EXPECTED_PRESET_COUNT);
  });

  it("slices every program out of a preset artifact whose hash the manifest declares", () => {
    const artifacts = new Map((manifest.artifacts ?? []).map((entry) => [entry.id, entry]));
    expect([...artifacts.keys()].sort()).toEqual([...PRESET_SLUGS].sort());
    for (const artifact of artifacts.values()) {
      expect(artifact.role).toBe("preset");
      expect(artifact.path).toBe(`presets/${artifact.id}.bin`);
      expect(sha256(entries.get(artifact.path)!), artifact.path).toBe(artifact.sha256);
    }
  });

  it("points every program at a Surge `sub3` patch inside its artifact", () => {
    const categories = manifest.classes[0].programs?.categories ?? [];
    const decoder = new TextDecoder("latin1");
    for (const category of categories) {
      let expectedOffset = 0;
      for (const program of category.entries) {
        const bytes = entries.get(`presets/${program.artifactId}.bin`);
        expect(bytes, `${category.name}/${program.name}`).toBeDefined();
        expect(program.size, `${category.name}/${program.name} size`).toBeGreaterThan(4);
        expect(program.offset + program.size).toBeLessThanOrEqual(bytes!.byteLength);
        const slice = bytes!.subarray(program.offset, program.offset + program.size);
        expect(decoder.decode(slice.subarray(0, 4)), `${category.name}/${program.name}`).toBe(
          "sub3",
        );
        // The slices tile their artifact exactly: contiguous, ascending, no gaps.
        expect(program.offset, `${category.name}/${program.name} offset`).toBe(expectedOffset);
        expectedOffset += program.size;
      }
      const artifactBytes = entries.get(`presets/${category.entries[0].artifactId}.bin`)!;
      expect(expectedOffset, `${category.name} tiles its artifact`).toBe(artifactBytes.byteLength);
    }
  });
});

describe("dist/SurgeXT.webvst verification", () => {
  it("imports nothing outside the SDK's AudioWorklet-compatible allowlist", async () => {
    const module = await WebAssembly.compile(entries.get("plugin.wasm")!.slice().buffer);
    const used = WebAssembly.Module.imports(module).map((entry) => `${entry.module}.${entry.name}`);
    expect(used.length).toBeGreaterThan(0);
    expect(used.filter((name) => !allowedImports.has(name))).toEqual([]);
  }, 120_000);

  it("passes the SDK's own verifier", async () => {
    const inspection = await sdk.verifyWebVst(archive);
    expect(inspection.abi).toBe("prometheos-vst3-wasm-1");
    expect(inspection.packageId).toBe(config.packageId);
    expect(inspection.version).toBe(config.version);
    expect(inspection.archiveSha256).toBe(sha256(archive));
    expect(inspection.classes).toHaveLength(1);
    expect(inspection.classes[0].classUid).toBe(config.class.classUid);
    expect(inspection.classes[0].name).toBe(config.class.name);
    expect(inspection.classes[0].kind).toBe(config.class.kind);
    expect(inspection.classes[0].parameterCount).toBe(manifest.classes[0].exposedParameters.length);
    expect(inspection.artifacts).toHaveLength(EXPECTED_CATEGORY_COUNT);
    for (const artifact of inspection.artifacts) {
      const declared = (manifest.artifacts ?? []).find((entry) => entry.id === artifact.id);
      expect(declared, artifact.id).toBeDefined();
      expect(artifact.sha256, artifact.path).toBe(declared!.sha256);
    }
  }, 300_000);
});
