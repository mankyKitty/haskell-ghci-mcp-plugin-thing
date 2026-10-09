import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { createMcpServer, parseTestOutput } from "../src/mcp.js";
import { loadConfig } from "../src/config.js";
import { Daemon } from "../src/daemon.js";
import { FAKE } from "./session.test.js";

const haveGhci = (() => {
  try {
    execSync("ghci --version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

let dir: string;
let client: Client;
let daemon: Daemon | null = null;

async function call(name: string, args: Record<string, unknown> = {}) {
  const r = await client.callTool({ name, arguments: args });
  const text = (r.content as { type: string; text: string }[]).map((c) => c.text).join("\n");
  return { text, isError: r.isError === true, structured: r.structuredContent as Record<string, unknown> | undefined };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "ghci-mcp-e2e-"));
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "Lib.hs"), "module Lib where\n\nanswer :: Int\nanswer = 42\n");
  writeFileSync(
    join(dir, "src", "Main.hs"),
    'module Main where\nimport Lib\nmain :: IO ()\nmain = putStrLn "3 examples, 0 failures" >> print answer\n',
  );
  const command = haveGhci ? "ghci -isrc src/Main.hs" : FAKE;
  writeFileSync(join(dir, "ghci-mcp.json"), JSON.stringify({ sessions: { default: { command, testCommand: ":main" } } }));

  const cfg = loadConfig(dir);
  const server = createMcpServer(cfg);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  client = new Client({ name: "test", version: "0" });
  await client.connect(ct);
});

afterAll(async () => {
  daemon?.session.kill("SIGKILL");
  await new Promise((r) => setTimeout(r, 100));
  rmSync(dir, { recursive: true, force: true });
});

describe("MCP server (end to end)", () => {
  it("lists the expected tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "ghci_browse", "ghci_doc", "ghci_eval", "ghci_info", "ghci_interrupt", "ghci_kind", "ghci_load",
        "ghci_reload", "ghci_run_tests", "ghci_start", "ghci_status", "ghci_stop",
        "ghci_type", "ghci_type_default",
      ].sort(),
    );
  });

  it("explains how to start a session when none is running", async () => {
    const r = await call("ghci_status");
    expect(r.isError).toBe(true);
    expect(r.text).toContain("ghci-mcp serve --session default --");
    expect(r.text).toContain("ghci_start");
  });

  it("ghci_start launches the configured command detached and ghci_status sees it", async () => {
    const r = await call("ghci_start", { wait: true });
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/ready in/);
    const s = await call("ghci_status");
    expect(s.isError).toBe(false);
    expect(s.structured).toMatchObject({ ready: true, name: "default" });
    // daemon is a separate process; remember to stop it
  }, 60_000);

  it("ghci_reload reports ok with a module count", async () => {
    const r = await call("ghci_reload");
    expect(r.isError).toBe(false);
    expect(r.structured).toMatchObject({ status: "ok" });
    expect(r.text).toMatch(/^OK: \d+ module/);
  });

  it.runIf(haveGhci)("ghci_reload reports structured errors after a bad edit, then recovers", async () => {
    writeFileSync(join(dir, "src", "Lib.hs"), 'module Lib where\n\nanswer :: Int\nanswer = "oops"\n');
    const bad = await call("ghci_reload");
    expect(bad.isError).toBe(false); // a failed typecheck is a successful tool call
    expect(bad.structured).toMatchObject({ status: "failed", errors: 1 });
    const diags = bad.structured!.diagnostics as { file: string; line: number; column: number; severity: string }[];
    expect(diags[0]).toMatchObject({ file: "src/Lib.hs", line: 4, column: 10, severity: "error" });
    expect(bad.text).toContain("ERROR src/Lib.hs:4:10");

    writeFileSync(join(dir, "src", "Lib.hs"), "module Lib where\n\nanswer :: Int\nanswer = 42\n");
    const ok = await call("ghci_reload");
    expect(ok.structured).toMatchObject({ status: "ok", errors: 0 });
  });

  it.runIf(haveGhci)("ghci_type / ghci_info / ghci_eval", async () => {
    expect((await call("ghci_type", { expr: "answer" })).text).toBe("answer :: Int");
    expect((await call("ghci_info", { name: "Maybe" })).text).toContain("data Maybe a = Nothing | Just a");
    expect((await call("ghci_eval", { expr: "answer * 2" })).text).toBe("84");

    const multi = await call("ghci_eval", { expr: "double :: Int -> Int\ndouble x = x * 2" });
    expect(multi.isError).toBe(false);
    expect((await call("ghci_eval", { expr: "double answer" })).text).toBe("84");

    const bad = await call("ghci_eval", { expr: "nope 1" });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("Variable not in scope");
  });

  it.runIf(haveGhci)("ghci_eval times out and interrupts runaway evaluation", async () => {
    const r = await call("ghci_eval", { expr: "length [1 ..]", timeoutMs: 1000 });
    expect(r.text).toContain("[interrupted]");
    expect((await call("ghci_eval", { expr: "1 + 1" })).text).toBe("2");
  });

  it("ghci_run_tests runs :main and parses hspec-style output", async () => {
    const r = await call("ghci_run_tests");
    if (haveGhci) {
      expect(r.isError).toBe(false);
      expect(r.structured).toMatchObject({ framework: "hspec", passed: true, total: 3, failures: 0 });
      expect(r.text).toMatch(/^PASSED \(hspec\)/);
    } else {
      expect(r.structured).toMatchObject({ framework: "unknown" });
    }
  });

  it("ghci_stop shuts the session down", async () => {
    const r = await call("ghci_stop");
    expect(r.isError).toBe(false);
    await new Promise((res) => setTimeout(res, 300));
    const s = await call("ghci_status");
    expect(s.isError).toBe(true);
  });
});

describe("parseTestOutput", () => {
  it("parses hspec and tasty summaries", () => {
    expect(parseTestOutput("Finished in 0.1s\n12 examples, 2 failures, 1 pending")).toMatchObject({ framework: "hspec", passed: false, total: 12, failures: 2 });
    expect(parseTestOutput("1 example, 0 failures")).toMatchObject({ framework: "hspec", passed: true });
    expect(parseTestOutput("All 7 tests passed (0.01s)")).toMatchObject({ framework: "tasty", passed: true, total: 7 });
    expect(parseTestOutput("2 out of 7 tests failed (0.01s)")).toMatchObject({ framework: "tasty", passed: false, failures: 2 });
    expect(parseTestOutput("hello").framework).toBe("unknown");
  });
});
