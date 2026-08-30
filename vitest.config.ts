import { defineConfig } from "vitest/config";

/**
 * Scope the runner to this repository's own tests.
 *
 * Without this, a bare `vitest run` also collects the vendored WebVST SDK's
 * suites under `vendor/webvst-sdk/**` -- the SDK's own tests, which need the
 * SDK's own dependencies (`zod`) and its built fixture packages, neither of
 * which exist in this workspace. They fail here for reasons that have nothing
 * to do with this package, and `pnpm test` is a release gate for the packaging
 * tasks, so it has to mean "this package is good".
 *
 * Every test this repository owns lives in `tests/`; vendored code is verified
 * in its own repository.
 */
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
  },
});
