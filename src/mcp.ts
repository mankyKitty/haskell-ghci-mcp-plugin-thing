import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig, type ProjectConfig } from "./config.js";
import { SessionClient, NoSessionError, DaemonError } from "./client.js";
import { resolveSession, startSession, tail } from "./launcher.js";
import { parseLoadOutput, parseDiagnostics, type LoadSummary, type Diagnostic } from "./diagnostics.js";
import type { SessionStatus } from "./protocol.js";

/**
 * The MCP server. Deliberately thin: every tool call connects to the session
 * daemon's socket, sends one GHCi command, and shapes the result. It never
 * owns the GHCi process, so it can be restarted freely, several agents can
 * share one session, and the expensive GHCi startup is paid once.
 */

type ToolResult = {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

const text = (t: string, structured?: Record<string, unknown>, isError = false): ToolResult => ({
  content: [{ type: "text", text: t }],
  ...(structured ? { structuredContent: structured } : {}),
  ...(isError ? { isError: true } : {}),
});

export function createMcpServer(cfg: ProjectConfig = loadConfig()): McpServer {
  const server = new McpServer({ name: "ghci-mcp", version: "0.1.0" });
  const clients = new Map<string, SessionClient>();

  const sessionArg = z
    .string()
    .optional()
    .describe('Session name from ghci-mcp.json (default "default"). Most projects only have one.');
  const timeoutArg = z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Per-command timeout in milliseconds. The command is interrupted (Ctrl-C) if it exceeds this.");

  function client(name: string): SessionClient {
    let c = clients.get(name);
    if (!c) {
      c = new SessionClient(resolveSession(cfg, name).paths.socket);
      clients.set(name, c);
    }
    return c;
  }

  function noSessionMessage(name: string): string {
    const { command, paths } = resolveSession(cfg, name);
    const start = command
      ? `  ghci-mcp serve --session ${name} -- ${command}`
      : `  ghci-mcp serve --session ${name} -- <your repl command, e.g. cabal repl lib:mypkg>`;
    return (
      `No GHCi session "${name}" is running for ${cfg.root} (expected socket ${paths.socket}).\n\n` +
      `Ask the user to start one in a terminal:\n${start}\n\n` +
      (command
        ? `Or call the ghci_start tool to launch it in the background with the configured command.`
        : `There is no configured command, so ghci_start needs an explicit \`command\` argument, ` +
          `or the user can add one to ${cfg.configPath ?? cfg.root + "/ghci-mcp.json"}.`)
    );
  }

  async function withSession<T>(name: string, fn: (c: SessionClient) => Promise<T>): Promise<T | ToolResult> {
    try {
      return await fn(client(name));
    } catch (e) {
      if (e instanceof NoSessionError) return text(noSessionMessage(name), undefined, true);
      if (e instanceof DaemonError) {
        let hint = "";
        if (e.code === "not_ready") hint = "\n\nGHCi is still starting up. Call ghci_status to watch progress, then retry.";
        if (e.code === "exited") hint = "\n\nThe GHCi process has exited; the session must be started again (ghci_start, or ask the user).";
        if (e.code === "timeout") hint = "\n\nConsider a larger timeoutMs, or check for an infinite loop / blocking IO in the expression.";
        return text(`GHCi session error (${e.code}): ${e.message}${hint}`, { code: e.code }, true);
      }
      throw e;
    }
  }

  // ---------------------------------------------------------------- status

  server.registerTool(
    "ghci_status",
    {
      title: "GHCi session status",
      description:
        "Check whether a GHCi session is running and ready. Call this first if you are unsure, " +
        "and after ghci_start to see when startup has finished. Cheap.",
      inputSchema: { session: sessionArg },
    },
    async ({ session = "default" }) =>
      withSession(session, async (c) => {
        const s = await c.status();
        return text(formatStatus(s), { ...s });
      }),
  );

  server.registerTool(
    "ghci_start",
    {
      title: "Start GHCi session in background",
      description:
        "Start a GHCi session daemon in the background using the command configured in ghci-mcp.json " +
        "(or an explicit command). Returns immediately unless wait=true; GHCi can take minutes to start on " +
        "big projects, so poll ghci_status. Prefer asking the user to start the session themselves if the " +
        "project has unusual setup needs - they know their build.",
      inputSchema: {
        session: sessionArg,
        command: z
          .string()
          .optional()
          .describe('Shell command to start GHCi, e.g. "cabal repl lib:foo" or "stack repl". Overrides config.'),
        wait: z.boolean().optional().describe("Block until the session is ready (or fails). Default false."),
      },
    },
    async ({ session = "default", command, wait = false }) => {
      try {
        const r = await startSession({ name: session, command, wait }, cfg);
        if (r.alreadyRunning) {
          return text(`Session "${session}" is already running.\n\n${formatStatus(r.status!)}`, { ...r });
        }
        const st = r.status;
        const summary = st?.ready
          ? `ready in ${((st.startupMs ?? 0) / 1000).toFixed(1)}s`
          : st?.exited
            ? `EXITED during startup (code ${st.exited.code}). Log tail:\n${tail(r.logPath)}`
            : `starting... poll ghci_status`;
        return text(
          `Started session "${session}" (pid ${r.pid}) with: ${r.command}\nLog: ${r.logPath}\nState: ${summary}`,
          { ...r },
          st?.exited != null,
        );
      } catch (e) {
        return text((e as Error).message, undefined, true);
      }
    },
  );

  server.registerTool(
    "ghci_stop",
    {
      title: "Stop GHCi session",
      description:
        "Shut down a GHCi session daemon. Only do this if the user asks, or the session is wedged - restarting is expensive.",
      inputSchema: { session: sessionArg },
    },
    async ({ session = "default" }) =>
      withSession(session, async (c) => {
        await c.shutdown();
        clients.delete(session);
        return text(`Session "${session}" asked to shut down.`);
      }),
  );

  server.registerTool(
    "ghci_interrupt",
    {
      title: "Interrupt current GHCi command",
      description: "Send Ctrl-C to GHCi to abort a running evaluation (e.g. an infinite loop) without restarting the session.",
      inputSchema: { session: sessionArg },
    },
    async ({ session = "default" }) =>
      withSession(session, async (c) => {
        await c.interrupt();
        return text("Interrupt sent.");
      }),
  );

  // ---------------------------------------------------------------- load / reload

  server.registerTool(
    "ghci_reload",
    {
      title: "Reload (typecheck) the project",
      description:
        "Run :reload in GHCi: recompiles every changed module and reports GHC errors and warnings as structured " +
        "diagnostics. This is the fast replacement for `cabal build` while iterating: use it after every edit. " +
        "Save files before calling. Reports status ok|failed, module count and each diagnostic with file/line/col.",
      inputSchema: { session: sessionArg, timeoutMs: timeoutArg },
    },
    async ({ session = "default", timeoutMs }) =>
      withSession(session, async (c) => {
        const r = await c.run(":reload", timeoutMs);
        const summary = parseLoadOutput(r.output);
        return text(formatLoad(summary, r.output, r.durationMs), { ...summary, durationMs: r.durationMs, raw: r.output });
      }),
  );

  server.registerTool(
    "ghci_load",
    {
      title: "Load / add modules",
      description:
        "Add modules or files to the GHCi session (:add, the default) or replace the loaded target set (:load). " +
        "Use :add when a brand-new file isn't picked up by ghci_reload. Prefer ghci_reload for ordinary edits. " +
        "Accepts file paths or module names.",
      inputSchema: {
        targets: z.array(z.string()).min(1).describe('e.g. ["src/Foo/Bar.hs"] or ["Foo.Bar"]'),
        mode: z.enum(["add", "load"]).optional().describe("`add` keeps existing targets (default); `load` replaces them."),
        session: sessionArg,
        timeoutMs: timeoutArg,
      },
    },
    async ({ targets, mode = "add", session = "default", timeoutMs }) =>
      withSession(session, async (c) => {
        const cmd = `:${mode} ${targets.map(shellishQuote).join(" ")}`;
        const r = await c.run(cmd, timeoutMs);
        const summary = parseLoadOutput(r.output);
        return text(formatLoad(summary, r.output, r.durationMs), { ...summary, durationMs: r.durationMs, raw: r.output });
      }),
  );

  // ---------------------------------------------------------------- eval

  server.registerTool(
    "ghci_eval",
    {
      title: "Evaluate Haskell expression",
      description:
        "Evaluate an expression or run a statement in GHCi (IO actions are executed; pure values are shown). " +
        "Multi-line input is wrapped in :{ :} automatically, so you can define functions and data types too. " +
        "Type errors come back as structured diagnostics. Any raw GHCi command works too (e.g. ':set -XGADTs', ':show modules', ':main arg1'). " +
        "Note: definitions made here live only in the session; put real code in files and ghci_reload.",
      inputSchema: {
        expr: z.string().describe("Haskell expression, statement, or multi-line definitions."),
        session: sessionArg,
        timeoutMs: timeoutArg,
      },
    },
    async ({ expr, session = "default", timeoutMs }) =>
      withSession(session, async (c) => {
        const r = await c.run(expr, timeoutMs);
        const diags = parseDiagnostics(r.output);
        const errs = diags.filter((d) => d.severity === "error");
        const header = r.interrupted ? "[interrupted]\n" : "";
        return text(
          header + (r.output === "" ? "(no output)" : r.output),
          { output: r.output, durationMs: r.durationMs, interrupted: r.interrupted, diagnostics: diags },
          errs.length > 0,
        );
      }),
  );

  // ---------------------------------------------------------------- queries

  const query = (
    tool: string,
    ghciCmd: string,
    title: string,
    description: string,
    argName: string,
    argDesc: string,
  ) =>
    server.registerTool(
      tool,
      {
        title,
        description,
        inputSchema: { [argName]: z.string().describe(argDesc), session: sessionArg } as Record<string, z.ZodTypeAny>,
      },
      async (args: Record<string, unknown>) => {
        const session = (args.session as string | undefined) ?? "default";
        const arg = args[argName] as string;
        return withSession(session, async (c) => {
          const r = await c.run(`${ghciCmd} ${arg}`);
          const diags = parseDiagnostics(r.output);
          const isErr = diags.some((d) => d.severity === "error");
          return text(r.output === "" ? "(no output)" : r.output, { output: r.output, diagnostics: diags }, isErr);
        });
      },
    );

  query(
    "ghci_type",
    ":type",
    "Type of expression",
    "Get the inferred type of an expression (:type). The cheapest way to check an API or your understanding before writing code. " +
      "Pass e.g. 'foldr', 'Map.insert', or a partial application '(<>) \"a\"'.",
    "expr",
    "Expression to type.",
  );
  query(
    "ghci_type_default",
    ":type +d",
    "Type of expression with defaulting",
    "Like ghci_type but applies type defaulting (:type +d), giving the concrete, less-polymorphic type you'd see in practice.",
    "expr",
    "Expression to type.",
  );
  query(
    "ghci_info",
    ":info",
    "Info about a name",
    "Show the definition, instances, fixity and defining module of a type, class, or function (:info). " +
      "Use this to see constructors, class methods, and which instances exist instead of guessing.",
    "name",
    "Type, class, constructor, or function name.",
  );
  query(
    "ghci_kind",
    ":kind!",
    "Kind of a type (with type-family reduction)",
    "Show the kind of a type and normalise type families (:kind!). Pass a type expression such as 'Maybe', 'Map String' or 'F Int'.",
    "type",
    "Type expression.",
  );
  query(
    "ghci_browse",
    ":browse",
    "Browse a module's exports",
    "List everything a module exports with types (:browse). Use it to discover available functions in your own or library modules.",
    "module",
    "Module name, e.g. Data.Map.Strict or MyProject.Core.",
  );
  query(
    "ghci_doc",
    ":doc",
    "Haddock documentation for a name",
    "Show the Haddock documentation of a name (:doc). Requires the module to be loaded with docs (-haddock); may say no docs are available.",
    "name",
    "Identifier to document.",
  );

  // ---------------------------------------------------------------- tests

  server.registerTool(
    "ghci_run_tests",
    {
      title: "Run test suite in GHCi",
      description:
        "Run the test suite from inside the session (default command from ghci-mcp.json `testCommand`, else :main). " +
        "Works when the session was started on the test target (e.g. `cabal repl test:spec`) or the test module is loaded. " +
        "Pass `args` to filter, e.g. hspec: '-m \"MyModule\"', tasty: '-p /name/'. Returns output and a parsed pass/fail summary " +
        "for hspec and tasty.",
      inputSchema: {
        args: z.string().optional().describe("Arguments appended to the test command (as with :main)."),
        command: z.string().optional().describe("Override the GHCi command used to run tests, e.g. 'hspec spec' or ':main'."),
        session: sessionArg,
        timeoutMs: timeoutArg,
      },
    },
    async ({ args, command, session = "default", timeoutMs }) =>
      withSession(session, async (c) => {
        const { sc } = resolveSession(cfg, session);
        const base = command ?? sc.testCommand ?? ":main";
        const cmd = args ? `${base} ${args}` : base;
        const r = await c.run(cmd, timeoutMs);
        const summary = parseTestOutput(r.output);
        const diags = parseDiagnostics(r.output);
        const head =
          summary.framework === "unknown"
            ? `Ran: ${cmd} (${r.durationMs}ms)${r.interrupted ? " [interrupted]" : ""}`
            : `${summary.passed ? "PASSED" : "FAILED"} (${summary.framework}): ${summary.summaryLine} (${r.durationMs}ms)`;
        return text(
          `${head}\n\n${r.output}`,
          { ...summary, command: cmd, durationMs: r.durationMs, interrupted: r.interrupted, diagnostics: diags, output: r.output },
          (summary.framework !== "unknown" && !summary.passed) || diags.some((d) => d.severity === "error"),
        );
      }),
  );

  return server;
}

export async function runStdio(cfg?: ProjectConfig): Promise<void> {
  const server = createMcpServer(cfg);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// ------------------------------------------------------------------ formatting

export function formatStatus(s: SessionStatus): string {
  const lines = [
    `session: ${s.name}`,
    `state:   ${s.exited ? `EXITED (code ${s.exited.code}, signal ${s.exited.signal})` : s.ready ? (s.busy ? `ready, busy (${s.queued} queued)` : "ready, idle") : "starting (not yet at prompt)"}`,
    `command: ${s.command}`,
    `cwd:     ${s.cwd}`,
    `uptime:  ${(s.uptimeMs / 1000).toFixed(0)}s` + (s.startupMs != null ? ` (startup ${(s.startupMs / 1000).toFixed(1)}s)` : ""),
    `commands run: ${s.commandsRun}`,
  ];
  if (!s.ready && s.startupTail) lines.push(`\n--- startup output (tail) ---\n${s.startupTail.trimEnd()}`);
  return lines.join("\n");
}

export function formatLoad(summary: LoadSummary, raw: string, durationMs: number): string {
  const head =
    summary.status === "ok"
      ? `OK: ${summary.modulesLoaded ?? "?"} module(s) loaded`
      : summary.status === "failed"
        ? `FAILED: ${summary.errors} error(s), ${summary.warnings} warning(s); ${summary.modulesLoaded ?? "?"} module(s) still loaded`
        : `UNKNOWN STATUS (no summary line)`;
  const parts = [`${head} (${durationMs}ms)`];
  if (summary.compiled.length) parts.push(`compiled: ${summary.compiled.map((c) => c.module).join(", ")}`);
  if (summary.diagnostics.length) {
    parts.push("");
    for (const d of summary.diagnostics) parts.push(formatDiag(d));
  } else if (summary.status === "unknown") {
    parts.push("", raw);
  }
  if (summary.otherOutput && summary.status !== "unknown") parts.push("", summary.otherOutput);
  return parts.join("\n");
}

function formatDiag(d: Diagnostic): string {
  const loc = `${d.file}:${d.line}:${d.column}` + (d.endLine != null && d.endLine !== d.line ? `-${d.endLine}:${d.endColumn}` : d.endColumn != null ? `-${d.endColumn}` : "");
  const code = d.code ? ` [${d.code}]` : "";
  return `${d.severity.toUpperCase()} ${loc}${code}\n${indent(d.message, 4)}\n`;
}

const indent = (s: string, n: number) => s.split("\n").map((l) => (l ? " ".repeat(n) + l : l)).join("\n");

function shellishQuote(s: string): string {
  return /[\s"]/.test(s) ? JSON.stringify(s) : s;
}

export interface TestSummary {
  framework: "hspec" | "tasty" | "unknown";
  passed: boolean;
  total: number | null;
  failures: number | null;
  summaryLine: string;
}

export function parseTestOutput(output: string): TestSummary {
  // hspec: "12 examples, 0 failures" / "12 examples, 2 failures, 1 pending"
  const hspec = /(\d+) examples?, (\d+) failures?(?:, (\d+) pending)?/.exec(output);
  if (hspec) {
    const total = Number(hspec[1]);
    const failures = Number(hspec[2]);
    return { framework: "hspec", passed: failures === 0, total, failures, summaryLine: hspec[0] };
  }
  // tasty: "All 12 tests passed (0.01s)" / "3 out of 12 tests failed (0.02s)"
  const tastyOk = /All (\d+) tests? passed/.exec(output);
  if (tastyOk) return { framework: "tasty", passed: true, total: Number(tastyOk[1]), failures: 0, summaryLine: tastyOk[0] };
  const tastyFail = /(\d+) out of (\d+) tests? failed/.exec(output);
  if (tastyFail) {
    return { framework: "tasty", passed: false, total: Number(tastyFail[2]), failures: Number(tastyFail[1]), summaryLine: tastyFail[0] };
  }
  return { framework: "unknown", passed: !/\*\*\* Exception|error:/.test(output), total: null, failures: null, summaryLine: "" };
}
