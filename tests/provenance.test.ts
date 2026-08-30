import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Machine-checkable provenance for the Surge XT WebVST source boundary.
 *
 * This suite is the immutability lock for Task 1: it pins both source
 * dependencies by commit, forbids branch-tracking, verifies the three
 * upstream patches byte-for-byte against the SHA-256 values recorded in
 * PROVENANCE.md, checks the GPLv3 license text, checks that the MIT-licensed
 * WebVST SDK notice is retained, and fails if any absolute developer path
 * leaks into a tracked build file.
 */

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const selfPath = fileURLToPath(import.meta.url);

// --- Immutable pins -------------------------------------------------------------
const SURGE_PIN = "2644c613fb729cf2ce924c39dc75cf6a61ee9324";
const SDK_PIN = "777b4077aee6d88aa66e0c07d328de7450b69458";
const SURGE_URL = "https://github.com/surge-synthesizer/surge.git";
const SDK_URL = "../prometheos-vst3-wasm-sdk";

// --- Patches and their expected SHA-256 (CRLF bytes, as applied in Buzz) -------
const PATCHES = [
  {
    file: "0001-emscripten-build-portability.patch",
    sha256: "d000131f6825b819222a82f933c1bc7bb66e7346890a139e5fbe4bffdb729f7c",
  },
  {
    file: "0002-sst-plugininfra-emscripten-stacktrace.patch",
    sha256: "b496512a6dd85c4c4695d7a164fe2feac7c873d2d4b417c526b954f58993b577",
  },
  {
    file: "0003-sst-plugininfra-emscripten-shared-library-path.patch",
    sha256: "aabe251d83277ce6e60c4f48ba7e45551f54543ec6c5a4a481fba859d5ae8e3b",
  },
] as const;

// Absolute developer-path shapes that must never appear in a tracked build
// file. Assembled from fragments so the literals never appear in this file.
const ABS_PATH_NEEDLES = [
  ["C:", "\\Users\\"].join(""),
  ["C:", "/Users/"].join(""),
  ["D:", "\\"].join(""),
  ["/", "home/"].join(""),
  ["/", "Users/"].join(""),
];

function submoduleHead(path: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: join(repoRoot, path),
    encoding: "utf8",
  }).trim();
}

interface GitmodulesSection {
  [key: string]: string;
}

function parseGitmodules(text: string): Record<string, GitmodulesSection> {
  const sections: Record<string, GitmodulesSection> = {};
  let current = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const header = /^\[submodule "([^"]+)"\]$/.exec(line);
    if (header) {
      current = header[1];
      sections[current] = {};
      continue;
    }
    const kv = /^([A-Za-z][A-Za-z0-9-]*)\s*=\s*(.*)$/.exec(line);
    if (kv && current) {
      sections[current][kv[1].toLowerCase()] = kv[2].trim();
    }
  }
  return sections;
}

const TEXT_EXTENSIONS = new Set([
  ".patch",
  ".json",
  ".md",
  ".ts",
  ".yaml",
  ".yml",
  ".cmake",
  ".txt",
]);
const TEXT_BASENAMES = new Set([".gitmodules", ".gitattributes", "CMakeLists.txt"]);

function collectTrackedTextFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (
      entry.name === ".git" ||
      entry.name === "node_modules" ||
      entry.name === "vendor" ||
      // git-ignored: scripts/build.ts writes the .wasm here and `cmake -B
      // build/native` writes CMake's own path-laden scaffolding here. This scan
      // is for *tracked* build files; generated output under build/ is not one.
      entry.name === "build"
    ) {
      continue;
    }
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectTrackedTextFiles(full, acc);
      continue;
    }
    if (full === selfPath) continue; // a scanner does not scan itself
    const dot = entry.name.lastIndexOf(".");
    const ext = dot >= 0 ? entry.name.slice(dot) : "";
    if (TEXT_EXTENSIONS.has(ext) || TEXT_BASENAMES.has(entry.name)) {
      acc.push(full);
    }
  }
  return acc;
}

describe("Surge XT WebVST provenance", () => {
  it("pins the Surge submodule to an immutable 40-hex commit", () => {
    expect(existsSync(join(repoRoot, "vendor/surge/.git"))).toBe(true);
    const head = submoduleHead("vendor/surge");
    expect(head).toMatch(/^[0-9a-f]{40}$/);
    expect(head).toBe(SURGE_PIN);
  });

  it("pins the WebVST SDK submodule to an immutable 40-hex commit", () => {
    expect(existsSync(join(repoRoot, "vendor/webvst-sdk/.git"))).toBe(true);
    const head = submoduleHead("vendor/webvst-sdk");
    expect(head).toMatch(/^[0-9a-f]{40}$/);
    expect(head).toBe(SDK_PIN);
  });

  it("configures .gitmodules with URL/path only and no branch tracking", () => {
    const gitmodulesPath = join(repoRoot, ".gitmodules");
    expect(existsSync(gitmodulesPath)).toBe(true);
    const sections = parseGitmodules(readFileSync(gitmodulesPath, "utf8"));

    expect(Object.keys(sections).sort()).toEqual(["vendor/surge", "vendor/webvst-sdk"]);

    expect(sections["vendor/surge"].path).toBe("vendor/surge");
    expect(sections["vendor/surge"].url).toBe(SURGE_URL);
    expect(sections["vendor/webvst-sdk"].path).toBe("vendor/webvst-sdk");
    expect(sections["vendor/webvst-sdk"].url).toBe(SDK_URL);

    for (const name of ["vendor/surge", "vendor/webvst-sdk"]) {
      expect(Object.keys(sections[name])).not.toContain("branch");
    }
  });

  it("carries the three upstream patches byte-for-byte, recorded in PROVENANCE.md", () => {
    const provenance = readFileSync(join(repoRoot, "PROVENANCE.md"), "utf8");
    for (const patch of PATCHES) {
      const bytes = readFileSync(join(repoRoot, "patches", patch.file));
      const digest = createHash("sha256").update(bytes).digest("hex");
      expect(digest, `sha256(${patch.file})`).toBe(patch.sha256);
      expect(provenance, `PROVENANCE.md records sha256 of ${patch.file}`).toContain(patch.sha256);
    }
  });

  it("records patch origin, targets, toolchain, and apply sequence in PROVENANCE.md", () => {
    const provenance = readFileSync(join(repoRoot, "PROVENANCE.md"), "utf8");
    expect(provenance).toContain(SURGE_PIN);
    expect(provenance).toContain(SDK_PIN);
    // historical Buzz origin, kept as a RELATIVE path so the file stays clean
    expect(provenance).toMatch(/apps\/buzz-remote\/native\/surgext/);
    // upstream files each patch targets
    expect(provenance).toContain("src/common/CMakeLists.txt");
    expect(provenance).toContain("src/misc_linux.cpp");
    expect(provenance).toContain("src/paths_linux.cpp");
    // toolchain versions
    expect(provenance).toContain("4.0.10"); // Emscripten
    expect(provenance).toContain("3.31.0"); // CMake
    // command sequence that applies the patches
    expect(provenance).toContain("git apply");
    expect(provenance).toContain("libs/sst/sst-plugininfra");
    // SDK-is-unpublished disclosure
    expect(provenance).toContain(
      "must be updated to the public URL when the SDK is published",
    );
  });

  it("ships the full GPLv3 license text", () => {
    const license = readFileSync(join(repoRoot, "LICENSE"), "utf8");
    expect(license).toContain("GNU GENERAL PUBLIC LICENSE");
    expect(license).toContain("Version 3");
  });

  it("retains the MIT-licensed WebVST SDK notice", () => {
    const sdkLicense = readFileSync(join(repoRoot, "vendor/webvst-sdk/LICENSE"), "utf8");
    expect(sdkLicense).toContain("MIT License");

    const notice = readFileSync(join(repoRoot, "NOTICE.md"), "utf8");
    expect(notice).toContain("MIT");
    expect(notice).toMatch(/SDK/);
  });

  it("leaks no absolute developer path into a tracked build file", () => {
    const files = collectTrackedTextFiles(repoRoot);
    const violations: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const needle of ABS_PATH_NEEDLES) {
        if (text.includes(needle)) {
          violations.push(`${relative(repoRoot, file)} contains ${JSON.stringify(needle)}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
