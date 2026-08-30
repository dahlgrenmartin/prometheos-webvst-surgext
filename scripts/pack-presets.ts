/**
 * Packs every Surge XT factory preset into one deterministic artifact per
 * category and projects the WebVST manifest `programs` / `artifacts` shapes.
 *
 * Run with Bun: `bun scripts/pack-presets.ts` (or `pnpm run pack-presets`).
 *
 * What it does
 * ------------
 *   1. lists the category directories under `vendor/surge/.../patches_factory`,
 *      directories only, ordinal `.sort()`;
 *   2. walks each category RECURSIVELY -- most are flat, but `Tutorials` nests
 *      its patches one level deeper (`Tutorials/Formula Modulator/*.fxp`) --
 *      keeps the `.fxp` files, ordinal `.sort()` on the POSIX-normalised
 *      relative path;
 *   3. strips the proven 60-byte VST2 `fxChunkSetCustom` wrapper off each file
 *      (see `stripFxp`), leaving the `sub3` state blob the module loads as-is;
 *   4. concatenates each category's blobs, in that sorted order, into one
 *      `<slug>.bin`; every entry's `{ offset, size }` tiles the artifact
 *      exactly -- contiguous, ascending, no gap or overlap.
 *
 * Outputs
 * -------
 *   - `package/presets/<slug>.bin` per category (staging; git-ignored, the
 *     `.webvst` archive build regenerates it).
 *   - `packPresets()` returns the in-memory structure: per category the display
 *     `name`, a stable generated `slug`, the artifact's archive-relative path,
 *     its SHA-256, and `entries: [{ name, artifactId, offset, size }]` with
 *     `artifactId` === the category slug.
 *   - `toManifestPrograms()` / `toManifestArtifacts()` project that into the
 *     exact shapes `scripts/build.ts` (Task 5) merges into the SDK manifest
 *     before `validateManifest()`.
 *
 * `stripFxp` and the walk are ported verbatim from
 * `apps/buzz-remote/scripts/generate-surgext.ts` in the source backend; only
 * the separator normalisation (`\` -> `/` before `.sort()`) is added, so the
 * concatenation order is identical on every platform.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

/** Populated `vendor/surge` factory patch tree (17 category dirs, 641 `.fxp`). */
export const FACTORY_PATCHES_DIR = join(
  repoRoot,
  "vendor",
  "surge",
  "resources",
  "data",
  "patches_factory",
);

/** Staging directory for the generated per-category `.bin` artifacts. */
export const PRESETS_STAGING_DIR = join(repoRoot, "package", "presets");

/** Archive-relative root every preset artifact path sits under. */
export const PRESET_ARTIFACT_PREFIX = "presets/";

// --- .fxp wrapper strip ------------------------------------------------------

export const FXP_HEADER_SIZE = 60;
export const FXP_PRGNAME_OFFSET = 28;
export const FXP_PRGNAME_SIZE = 28;

/**
 * Strips the 60-byte VST2 `fxChunkSetCustom` wrapper off a factory `.fxp`,
 * returning the `sub3` payload the module's state loader accepts as-is.
 *
 * All three magic fields and the payload tag are verified rather than trusting
 * the offset blindly, so a differently-shaped file fails the pack instead of
 * silently producing a corrupt slice.
 *
 * `name` is the fixed 28-byte PRGNAME field taken verbatim (up to the first
 * NUL, trimmed) -- for `Tutorials` that is a truncation of the file name, and
 * it is kept as the truncation, never reconstructed from the path. An empty
 * field falls back to the file's base name.
 */
export function stripFxp(bytes: Buffer, path: string): { name: string; payload: Buffer } {
  if (bytes.length <= FXP_HEADER_SIZE) throw new Error(`${path}: too small to be an .fxp`);
  const magic = bytes.subarray(0, 4).toString("latin1");
  const fxMagic = bytes.subarray(8, 12).toString("latin1");
  const fxId = bytes.subarray(16, 20).toString("latin1");
  if (magic !== "CcnK" || fxMagic !== "FPCh" || fxId !== "cjs3") {
    throw new Error(`${path}: not a Surge .fxp (magic ${magic}/${fxMagic}/${fxId})`);
  }
  const payload = bytes.subarray(FXP_HEADER_SIZE);
  const tag = payload.subarray(0, 4).toString("latin1");
  if (tag !== "sub3") {
    throw new Error(`${path}: payload at ${FXP_HEADER_SIZE} starts with ${tag}, expected sub3`);
  }
  const rawName = bytes
    .subarray(FXP_PRGNAME_OFFSET, FXP_PRGNAME_OFFSET + FXP_PRGNAME_SIZE)
    .toString("latin1");
  const nul = rawName.indexOf("\0");
  const name = (nul === -1 ? rawName : rawName.slice(0, nul)).trim();
  return {
    name: name.length > 0 ? name : basename(path, ".fxp"),
    payload: Buffer.from(payload),
  };
}

// --- slug ------------------------------------------------------------------

/** Lowercase, `[^a-z0-9]+` -> `-`, trimmed of `-`. Deterministic and stable. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// --- discovery ------------------------------------------------------------

export interface FactoryPreset {
  /** Top-level category directory name, unchanged. */
  category: string;
  /** POSIX path of the `.fxp` relative to its category directory. */
  relPath: string;
  /** Absolute path on disk. */
  absPath: string;
}

function categoryNames(factoryDir: string): string[] {
  if (!existsSync(factoryDir)) {
    throw new Error(
      `Surge XT factory patches missing at ${factoryDir}. Run: git submodule update --init vendor/surge`,
    );
  }
  return readdirSync(factoryDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/** Recursive: relative POSIX paths of every `.fxp` in a category, ordinal `.sort()`. */
function categoryFiles(factoryDir: string, category: string): string[] {
  return readdirSync(join(factoryDir, category), { recursive: true })
    .map((file) => String(file).split(/[\\/]/).join("/"))
    .filter((file) => file.toLowerCase().endsWith(".fxp"))
    .sort();
}

/**
 * Every factory `.fxp` in deterministic pack order: category ascending, then
 * relative path ascending. The order this returns is exactly the concatenation
 * order `packPresets()` uses.
 */
export function listFactoryPresets(factoryDir: string = FACTORY_PATCHES_DIR): FactoryPreset[] {
  const presets: FactoryPreset[] = [];
  for (const category of categoryNames(factoryDir)) {
    for (const relPath of categoryFiles(factoryDir, category)) {
      presets.push({ category, relPath, absPath: join(factoryDir, category, relPath) });
    }
  }
  return presets;
}

// --- pack ----------------------------------------------------------------

export interface PackedEntry {
  /** The 28-byte PRGNAME field, verbatim. */
  name: string;
  /** The owning category's slug -- the artifact this entry is sliced from. */
  artifactId: string;
  /** Byte offset of this entry's `sub3` blob within the category artifact. */
  offset: number;
  /** Byte length of the `sub3` blob. */
  size: number;
}

export interface PackedCategory {
  /** Category display name, verbatim from the directory. */
  name: string;
  /** Stable generated slug; the artifact ID for every entry below. */
  slug: string;
  /** Archive-relative path of this category's packed artifact (`presets/<slug>.bin`). */
  artifactPath: string;
  /** Lowercase-hex SHA-256 of `bytes`. */
  sha256: string;
  /** The concatenated `sub3` payloads, in `entries` order. */
  bytes: Buffer;
  entries: PackedEntry[];
}

export interface PackResult {
  categories: PackedCategory[];
  presetCount: number;
  categoryCount: number;
}

/**
 * Walks `factoryDir` and returns the packed structure in memory. Pure: it
 * reads the factory tree but writes nothing. Use `writePresetArtifacts()` to
 * stage the `.bin` files.
 */
export function packPresets(factoryDir: string = FACTORY_PATCHES_DIR): PackResult {
  const categories: PackedCategory[] = [];
  const slugOwner = new Map<string, string>();

  for (const name of categoryNames(factoryDir)) {
    const files = categoryFiles(factoryDir, name);
    if (files.length === 0) continue;

    const slug = slugify(name);
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)) {
      throw new Error(`category "${name}" produced an invalid artifact slug "${slug}"`);
    }
    const owner = slugOwner.get(slug);
    if (owner) throw new Error(`categories "${owner}" and "${name}" collide on slug "${slug}"`);
    slugOwner.set(slug, name);

    const chunks: Buffer[] = [];
    const entries: PackedEntry[] = [];
    let offset = 0;
    for (const relPath of files) {
      const absPath = join(factoryDir, name, relPath);
      const { name: presetName, payload } = stripFxp(readFileSync(absPath), absPath);
      entries.push({ name: presetName, artifactId: slug, offset, size: payload.length });
      chunks.push(payload);
      offset += payload.length;
    }

    const bytes = Buffer.concat(chunks);
    categories.push({
      name,
      slug,
      artifactPath: `${PRESET_ARTIFACT_PREFIX}${slug}.bin`,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes,
      entries,
    });
  }

  return {
    categories,
    categoryCount: categories.length,
    presetCount: categories.reduce((total, category) => total + category.entries.length, 0),
  };
}

// --- manifest projections (consumed by scripts/build.ts, Task 5) -----------

export interface ManifestPrograms {
  categories: Array<{
    name: string;
    entries: Array<{ name: string; artifactId: string; offset: number; size: number }>;
  }>;
}

/** The `classes[].programs` value: categories -> entries, in pack order. */
export function toManifestPrograms(result: PackResult): ManifestPrograms {
  return {
    categories: result.categories.map((category) => ({
      name: category.name,
      entries: category.entries.map((entry) => ({
        name: entry.name,
        artifactId: entry.artifactId,
        offset: entry.offset,
        size: entry.size,
      })),
    })),
  };
}

export interface ManifestArtifact {
  id: string;
  path: string;
  sha256: string;
  role: "preset";
}

/** The top-level `artifacts` array: one `preset` artifact per category. */
export function toManifestArtifacts(result: PackResult): ManifestArtifact[] {
  return result.categories.map((category) => ({
    id: category.slug,
    path: category.artifactPath,
    sha256: category.sha256,
    role: "preset",
  }));
}

// --- staging output -----------------------------------------------------

/**
 * Writes `<stagingDir>/<slug>.bin` for every category and removes any stale
 * `.bin` no longer produced. Returns the paths written.
 */
export function writePresetArtifacts(
  result: PackResult,
  stagingDir: string = PRESETS_STAGING_DIR,
): string[] {
  mkdirSync(stagingDir, { recursive: true });
  const expected = new Set(result.categories.map((category) => `${category.slug}.bin`));
  for (const file of readdirSync(stagingDir)) {
    if (file.endsWith(".bin") && !expected.has(file)) rmSync(join(stagingDir, file));
  }
  const written: string[] = [];
  for (const category of result.categories) {
    const target = join(stagingDir, `${category.slug}.bin`);
    writeFileSync(target, category.bytes);
    written.push(target);
  }
  return written;
}

/** The one-line pack summary. Exact form: `641 presets across 17 categories`. */
export function summaryLine(result: PackResult): string {
  return `${result.presetCount} presets across ${result.categoryCount} categories`;
}

// --- CLI ---------------------------------------------------------------

function main(): void {
  const result = packPresets();
  const written = writePresetArtifacts(result);
  for (const category of result.categories) {
    console.log(
      `  ${category.slug.padEnd(12)} ${String(category.entries.length).padStart(3)} presets  ` +
        `${String(category.bytes.length).padStart(9)} B  ${category.sha256}`,
    );
  }
  console.log(`wrote ${written.length} artifact(s) to ${PRESETS_STAGING_DIR}`);
  console.log(summaryLine(result));
}

// Bun sets `import.meta.main` for the entry module; on import (tests, Task 5)
// it is falsy, so nothing runs.
if ((import.meta as { main?: boolean }).main) main();
