import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  FXP_HEADER_SIZE,
  FXP_PRGNAME_OFFSET,
  FXP_PRGNAME_SIZE,
  listFactoryPresets,
  packPresets,
  slugify,
  summaryLine,
  toManifestArtifacts,
  toManifestPrograms,
} from "../scripts/pack-presets";

/**
 * TDD lock for Task 4: the factory preset packer.
 *
 * Every assertion runs against the REAL, pinned `vendor/surge` factory patch
 * tree -- no fixtures. It verifies recursive discovery, the exact 641/17 split,
 * byte-exact `sub3` payload strips, offsets that tile each category artifact
 * with no gap or overlap, the largest category's range, the nested `Tutorials`
 * descent, and that the fixed 28-byte PRGNAME field is taken verbatim rather
 * than reconstructed from a longer filename.
 */

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const factoryDir = join(
  repoRoot,
  "vendor",
  "surge",
  "resources",
  "data",
  "patches_factory",
);

const EXPECTED_CATEGORIES = [
  "Basses",
  "Brass",
  "Chords",
  "FX",
  "Keys",
  "Leads",
  "MPE",
  "Pads",
  "Percussion",
  "Plucks",
  "Polysynths",
  "Sequences",
  "Splits",
  "Templates",
  "Tutorials",
  "Vocoder",
  "Winds",
] as const;

const EXPECTED_COUNTS: Record<string, number> = {
  Basses: 59,
  Brass: 11,
  Chords: 8,
  FX: 27,
  Keys: 16,
  Leads: 131,
  MPE: 9,
  Pads: 65,
  Percussion: 9,
  Plucks: 111,
  Polysynths: 104,
  Sequences: 45,
  Splits: 5,
  Templates: 16,
  Tutorials: 14,
  Vocoder: 3,
  Winds: 8,
};

const EXPECTED_TOTAL = 641;

/**
 * Regression anchor: SHA-256 of the concatenated `sub3` payloads of the
 * largest category (Leads), packed from the pinned `vendor/surge` checkout.
 * A mismatch means the vendored factory data or the strip logic moved --
 * STOP and re-verify against upstream, do not re-bless this value.
 */
const LEADS_SHA256 =
  "b2d1696daa2cb82b48475ffd0b7f20d14b9498351bb60a8d12b6599bcb23fb74";

/** Independent recursive walk, so the packer's discovery is checked, not trusted. */
function walkFxp(dir: string): string[] {
  return readdirSync(dir, { recursive: true })
    .map((entry) => String(entry).split(/[\\/]/).join("/"))
    .filter((entry) => entry.toLowerCase().endsWith(".fxp"));
}

const result = packPresets(factoryDir);
const byName = new Map(result.categories.map((category) => [category.name, category]));

describe("recursive discovery", () => {
  it("finds every .fxp under the factory tree, and only .fxp files", () => {
    const discovered = listFactoryPresets(factoryDir);
    const independent = walkFxp(factoryDir);
    expect(discovered.length).toBe(independent.length);
    expect(discovered.length).toBe(EXPECTED_TOTAL);
    expect(discovered.every((preset) => preset.relPath.toLowerCase().endsWith(".fxp"))).toBe(true);
  });

  it("groups into exactly 17 categories in .sort() order", () => {
    const names = result.categories.map((category) => category.name);
    expect(names).toEqual([...EXPECTED_CATEGORIES]);
    expect(names).toEqual([...names].sort());
    expect(result.categoryCount).toBe(17);
  });

  it("packs the expected per-category entry counts totalling 641", () => {
    for (const category of result.categories) {
      expect(category.entries.length, category.name).toBe(EXPECTED_COUNTS[category.name]);
    }
    expect(result.presetCount).toBe(EXPECTED_TOTAL);
    const summed = result.categories.reduce((total, c) => total + c.entries.length, 0);
    expect(summed).toBe(EXPECTED_TOTAL);
  });
});

describe("stripped payloads", () => {
  it("keeps only the proven 60-byte VST2 wrapper strip", () => {
    expect(FXP_HEADER_SIZE).toBe(60);
    expect(FXP_PRGNAME_OFFSET).toBe(28);
    expect(FXP_PRGNAME_SIZE).toBe(28);

    const first = listFactoryPresets(factoryDir)[0];
    const raw = readFileSync(first.absPath);
    expect(raw.subarray(0, 4).toString("latin1")).toBe("CcnK");
    expect(raw.subarray(8, 12).toString("latin1")).toBe("FPCh");
    expect(raw.subarray(16, 20).toString("latin1")).toBe("cjs3");
    expect(raw.subarray(60, 64).toString("latin1")).toBe("sub3");

    const packedFirst = byName.get(first.category)!.entries[0];
    expect(packedFirst.size).toBe(raw.length - FXP_HEADER_SIZE);
  });

  it("every packed slice begins with the sub3 tag", () => {
    for (const category of result.categories) {
      for (const entry of category.entries) {
        const tag = category.bytes.subarray(entry.offset, entry.offset + 4).toString("latin1");
        expect(tag, `${category.name}/${entry.name}`).toBe("sub3");
      }
    }
  });
});

describe("deterministic offsets", () => {
  it("tiles each category artifact exactly: contiguous, ascending, no gap or overlap", () => {
    for (const category of result.categories) {
      let expectedOffset = 0;
      let previousOffset = -1;
      for (const entry of category.entries) {
        expect(entry.offset, `${category.name}/${entry.name} offset`).toBe(expectedOffset);
        expect(entry.offset).toBeGreaterThan(previousOffset);
        expect(entry.size).toBeGreaterThan(0);
        expect(entry.offset).toBeGreaterThanOrEqual(0);
        expect(entry.offset).toBeLessThan(category.bytes.length);
        expect(entry.offset + entry.size).toBeLessThanOrEqual(category.bytes.length);
        previousOffset = entry.offset;
        expectedOffset += entry.size;
      }
      expect(expectedOffset, `${category.name} tiled length`).toBe(category.bytes.length);
      const summedSize = category.entries.reduce((total, e) => total + e.size, 0);
      expect(summedSize).toBe(category.bytes.length);
    }
  });

  it("records a self-consistent SHA-256 per category", () => {
    for (const category of result.categories) {
      expect(category.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(category.sha256).toBe(createHash("sha256").update(category.bytes).digest("hex"));
    }
  });

  it("is reproducible: a second pack yields identical bytes and hashes", () => {
    const again = packPresets(factoryDir);
    expect(again.categories.length).toBe(result.categories.length);
    for (let index = 0; index < result.categories.length; index += 1) {
      expect(again.categories[index].name).toBe(result.categories[index].name);
      expect(again.categories[index].sha256).toBe(result.categories[index].sha256);
      expect(again.categories[index].bytes.equals(result.categories[index].bytes)).toBe(true);
      expect(again.categories[index].entries).toEqual(result.categories[index].entries);
    }
  });
});

describe("largest category", () => {
  it("is Leads with 131 entries and a byte range that spans its whole artifact", () => {
    const largest = [...result.categories].sort(
      (a, b) => b.entries.length - a.entries.length,
    )[0];
    expect(largest.name).toBe("Leads");
    expect(largest.entries.length).toBe(131);

    for (const other of result.categories) {
      if (other.name !== "Leads") expect(other.entries.length).toBeLessThan(131);
    }

    expect(largest.entries[0].offset).toBe(0);
    const last = largest.entries[largest.entries.length - 1];
    expect(last.offset + last.size).toBe(largest.bytes.length);
    expect(largest.sha256).toBe(LEADS_SHA256);
  });
});

describe("nested Tutorials descent", () => {
  it("collects the Tutorials patches from one directory deeper", () => {
    const tutorials = listFactoryPresets(factoryDir).filter(
      (preset) => preset.category === "Tutorials",
    );
    expect(tutorials.length).toBe(14);
    // Every Tutorials patch is reached through a subdirectory (path has a separator).
    expect(tutorials.every((preset) => preset.relPath.includes("/"))).toBe(true);
    expect(tutorials.some((preset) => preset.relPath.startsWith("Formula Modulator/"))).toBe(true);

    // The recursive walk feeds the packer in .sort() order.
    const relPaths = tutorials.map((preset) => preset.relPath);
    expect(relPaths).toEqual([...relPaths].sort());

    // ...and that order is the packed order.
    const packed = byName.get("Tutorials")!;
    expect(packed.entries[0].name).toBe("01 A Simple Formula");
    expect(packed.entries[packed.entries.length - 1].name).toBe("14 Portamento Using The Shar");
  });

  it("is the only category that nests", () => {
    const nested = listFactoryPresets(factoryDir).filter((preset) =>
      preset.relPath.includes("/"),
    );
    expect(nested.length).toBeGreaterThan(0);
    expect(new Set(nested.map((preset) => preset.category))).toEqual(new Set(["Tutorials"]));
  });
});

describe("truncated fixed-format patch names", () => {
  it("takes the 28-byte PRGNAME field verbatim, not the longer filename", () => {
    const packed = byName.get("Tutorials")!;
    const entry = packed.entries.find((candidate) => candidate.name.startsWith("08 Quis"))!;
    expect(entry).toBeDefined();
    expect(entry.name).toBe("08 Quis Modulatiet Ipsos Mod");
    expect(entry.name.length).toBe(28);
    expect(entry.name).not.toBe("08 Quis Modulatiet Ipsos Modulates");

    // Cross-check straight off the raw file's fixed field.
    const raw = readFileSync(
      join(factoryDir, "Tutorials", "Formula Modulator", "08 Quis Modulatiet Ipsos Modulates.fxp"),
    );
    const field = raw
      .subarray(FXP_PRGNAME_OFFSET, FXP_PRGNAME_OFFSET + FXP_PRGNAME_SIZE)
      .toString("latin1");
    const nul = field.indexOf("\0");
    expect((nul === -1 ? field : field.slice(0, nul)).trim()).toBe(entry.name);
  });

  it("never emits an entry name longer than the 28-byte field", () => {
    for (const category of result.categories) {
      for (const entry of category.entries) {
        expect(entry.name.length, `${category.name}/${entry.name}`).toBeGreaterThan(0);
        expect(entry.name.length, `${category.name}/${entry.name}`).toBeLessThanOrEqual(
          FXP_PRGNAME_SIZE,
        );
      }
    }
  });
});

describe("slugs and manifest projection", () => {
  it("generates stable lowercase slugs used as artifact IDs", () => {
    expect(slugify("Basses")).toBe("basses");
    expect(slugify("FX")).toBe("fx");
    expect(slugify("MPE")).toBe("mpe");
    expect(slugify("Formula Modulator")).toBe("formula-modulator");
    expect(slugify("  --Weird  Name!!  ")).toBe("weird-name");

    for (const category of result.categories) {
      expect(category.slug).toBe(slugify(category.name));
      expect(category.slug).toMatch(/^[a-z0-9][a-z0-9-]{0,63}$/);
      expect(category.artifactPath).toBe(`presets/${category.slug}.bin`);
      expect(category.entries.every((entry) => entry.artifactId === category.slug)).toBe(true);
    }
    const slugs = result.categories.map((category) => category.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("projects the manifest programs + artifacts shape Task 5 merges", () => {
    const programs = toManifestPrograms(result);
    expect(programs.categories.map((category) => category.name)).toEqual([...EXPECTED_CATEGORIES]);
    const sampleEntry = programs.categories[0].entries[0];
    expect(Object.keys(sampleEntry).sort()).toEqual(["artifactId", "name", "offset", "size"]);
    expect(sampleEntry.artifactId).toBe("basses");
    expect(sampleEntry.offset).toBe(0);

    const artifacts = toManifestArtifacts(result);
    expect(artifacts).toHaveLength(17);
    expect(artifacts[0]).toEqual({
      id: "basses",
      path: "presets/basses.bin",
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      role: "preset",
    });
    for (const artifact of artifacts) {
      expect(artifact.path.startsWith("presets/")).toBe(true);
      expect(artifact.role).toBe("preset");
    }
  });
});

describe("summary line", () => {
  it('reports "641 presets across 17 categories"', () => {
    const line = summaryLine(result);
    // eslint-disable-next-line no-console
    console.log(line);
    expect(line).toBe("641 presets across 17 categories");
  });
});
