import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Cached Nix sources and linked worktrees can contain their own test suites.
    include: ["test/**/*.test.ts"],
  },
});
