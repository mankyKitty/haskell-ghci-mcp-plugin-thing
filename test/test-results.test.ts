import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { SessionClient } from "../src/client.js";
import { loadConfig } from "../src/config.js";
import { createMcpServer, formatLoad, parseTestOutput } from "../src/mcp.js";
import { parseLoadOutput } from "../src/diagnostics.js";

afterEach(() => vi.restoreAllMocks());

describe("test result evidence", () => {
  it.each([
    "",
    "hello",
    "Command is not supported (yet) in multi-mode",
    "unknown command ':missing'\nuse :? for help.",
    'expected output: "3 examples, 0 failures"',
  ])("does not claim tests passed without a framework summary: %j", (output) => {
    expect(parseTestOutput(output)).toMatchObject({ framework: "unknown", passed: false, total: null });
  });

  it.each(["0 examples, 0 failures", "All 0 tests passed (0.01s)"])("does not claim a zero-test run passed: %s", (output) => {
    expect(parseTestOutput(output)).toMatchObject({ passed: false, total: 0 });
  });

  it.each([
    "3 examples, 0 failures\n*** Exception: user error (after tests)",
    "3 examples, 0 failures\ncleanup: *** Exception: user error (after tests)",
    "All 7 tests passed (0.01s)\n*** Exception: user error (after tests)",
    "3 examples, 0 failures\nCommand is not supported (yet) in multi-mode",
    "3 examples, 0 failures\nunknown command ':missing'",
    "3 examples, 0 failures\n<interactive>:1:1: error: [GHC-88464]\n    Variable not in scope: x",
    "3 examples, 0 failures\n<no location info>: error: [GHC-87110]\n    Could not load module `Test.Hspec'.",
    "3 examples, 0 failures\n2 examples, 1 failure",
    "All 7 tests passed (0.01s)\n1 out of 3 tests failed (0.01s)",
  ])("does not let a passing summary hide a failure: %j", (output) => {
    expect(parseTestOutput(output).passed).toBe(false);
  });

  it.each([
    ["1 example, 0 failures\r\n", "hspec", 1],
    ["3 examples, 0 failures, 1 pending", "hspec", 3],
    ["All 7 tests passed (0.01s)\n", "tasty", 7],
  ])("keeps supported successful summaries: %s", (output, framework, total) => {
    expect(parseTestOutput(output as string)).toMatchObject({ framework, passed: true, total, failures: 0 });
  });
});

async function callWith(output: string, interrupted = false, name = "ghci_run_tests", args: Record<string, unknown> = {}) {
  // Exercise the real tool handler with deterministic daemon replies. No GHC
  // installation is needed to test the interrupted flag or multi-mode refusal.
  vi.spyOn(SessionClient.prototype, "run").mockResolvedValue({ output, interrupted, durationMs: 10 });
  const server = createMcpServer(loadConfig(process.cwd()));
  const client = new Client({ name: "test-result-check", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(st);
    await client.connect(ct);
    return await client.callTool({ name, arguments: args });
  } finally {
    await client.close();
    await server.close();
  }
}

describe("ghci_run_tests reply", () => {
  it("refuses to append CLI arguments to a Haskell expression without running it", async () => {
    const result = await callWith("3 examples, 0 failures", false, "ghci_run_tests", {
      command: "Main.main", args: '--match "MyModule"',
    });
    expect(SessionClient.prototype.run).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([expect.objectContaining({
      text: expect.stringContaining('System.Environment.withArgs ["--match", "MyModule"] Main.main'),
    })]);
  });

  it("keeps argument forwarding for GHCi commands", async () => {
    const result = await callWith("3 examples, 0 failures", false, "ghci_run_tests", {
      command: ":main", args: '--match "MyModule"',
    });
    expect(SessionClient.prototype.run).toHaveBeenCalledWith(':main --match "MyModule"', undefined);
    expect(result.isError).not.toBe(true);
  });

  it("runs an expression with explicit withArgs unchanged", async () => {
    const command = 'System.Environment.withArgs ["--match", "MyModule"] Main.main';
    const result = await callWith("3 examples, 0 failures", false, "ghci_run_tests", { command });
    expect(SessionClient.prototype.run).toHaveBeenCalledWith(command, undefined);
    expect(result.isError).not.toBe(true);
  });

  it("ignores whitespace-only args on a Haskell expression", async () => {
    await callWith("3 examples, 0 failures", false, "ghci_run_tests", { command: "Main.main", args: "  " });
    expect(SessionClient.prototype.run).toHaveBeenCalledWith("Main.main", undefined);
  });

  it("marks an unsupported command unverified and returns an MCP error", async () => {
    const result = await callWith("Command is not supported (yet) in multi-mode");
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ framework: "unknown", passed: false, total: null });
    expect(result.content).toEqual([expect.objectContaining({ type: "text", text: expect.stringContaining("UNVERIFIED") })]);
  });

  it.each(["3 examples, 0 failures", "All 7 tests passed (0.01s)"])("never reports an interrupted command as passed: %s", async (output) => {
    const result = await callWith(output, true);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ passed: false, interrupted: true, output });
    expect(result.content).toEqual([expect.objectContaining({ type: "text", text: expect.stringContaining("INTERRUPTED") })]);
  });

  it("keeps a completed passing result successful", async () => {
    const result = await callWith("3 examples, 0 failures");
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ framework: "hspec", passed: true, total: 3, interrupted: false });
    expect(result.content).toEqual([expect.objectContaining({ type: "text", text: expect.stringContaining("PASSED (hspec)") })]);
  });
});

describe("unlocated diagnostic replies", () => {
  const output = "<no location info>: error: [GHC-87110]\n    Could not load module `Test.Hspec'.\n";

  it.each([
    ["ghci_eval", { expr: "import Test.Hspec" }],
    ["ghci_type", { expr: "missing" }],
  ] as const)("marks %s's unlocated GHC error as an MCP error", async (tool, args) => {
    const result = await callWith(output, false, tool, args);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ output, diagnostics: [{ severity: "error", code: "GHC-87110" }] });
    expect(result.content).toEqual([{ type: "text", text: output }]);
  });

  it("marks a passing test summary followed by an unlocated error as failed", async () => {
    const result = await callWith("3 examples, 0 failures\n" + output);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ passed: false, diagnostics: [{ severity: "error", code: "GHC-87110" }] });
  });

  it("formats an unlocated diagnostic without undefined coordinates", () => {
    expect(formatLoad(parseLoadOutput(output), output, 10)).toBe(
      "UNKNOWN STATUS (no summary line) (10ms)\n\nERROR <no location info> [GHC-87110]\n    Could not load module `Test.Hspec'.\n",
    );
  });

  it("keeps an unlocated warning successful", async () => {
    const result = await callWith(output.replace(": error:", ": warning:"), false, "ghci_eval", { expr: "import Test.Hspec" });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ diagnostics: [{ severity: "warning" }] });
  });
});
