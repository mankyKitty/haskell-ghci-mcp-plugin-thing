import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findProjectRoot } from "../src/config.js";

describe("findProjectRoot", () => {
  it("agrees from the repo root, the project dir and a package dir below it", () => {
    const repo = mkdtempSync(join(tmpdir(), "ghci-mcp-root-"));
    const proj = join(repo, "brossa");
    mkdirSync(join(proj, "pkg"), { recursive: true });
    writeFileSync(join(proj, "cabal.project"), "");
    writeFileSync(join(proj, "pkg", "pkg.cabal"), "");
    expect(findProjectRoot(repo)).toBe(proj);
    expect(findProjectRoot(proj)).toBe(proj);
    expect(findProjectRoot(join(proj, "pkg"))).toBe(proj);
  });
});
