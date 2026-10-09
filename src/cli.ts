#!/usr/bin/env node
import { parseArgs } from "node:util";
import { join } from "node:path";
import { existsSync, writeFileSync } from "node:fs";
import { loadConfig, sessionPaths, guessCommand, CONFIG_FILENAME } from "./config.js";
import { Daemon } from "./daemon.js";
import { SessionClient, NoSessionError, probeStatus } from "./client.js";
import { startSession, resolveSession, tail } from "./launcher.js";
import { runStdio, formatStatus, formatLoad } from "./mcp.js";
import { parseLoadOutput } from "./diagnostics.js";

const USAGE = `ghci-mcp - a long-lived GHCi session for MCP agents

Usage:
  ghci-mcp serve [--session NAME] [--root DIR] -- <command...>
      Start GHCi with <command> (e.g. cabal repl lib:foo) in this terminal and
      expose it on a socket. Lines you type here still go to GHCi. Ctrl-C
      interrupts the current command; Ctrl-C again (when idle) quits.
      If no command is given, the one from ${CONFIG_FILENAME} is used.

  ghci-mcp start [--session NAME] [--wait] [-- <command...>]
      Same, but detached in the background (log in ~/.cache/ghci-mcp/<project>-<hash>/NAME.log).

  ghci-mcp stop   [--session NAME]       Shut a session down.
  ghci-mcp status [--session NAME]       Show session state.
  ghci-mcp send   [--session NAME] CMD   Send one GHCi command, print output.
  ghci-mcp reload [--session NAME]       :reload and print parsed diagnostics.
  ghci-mcp mcp                           Run the MCP server on stdio (for Claude Code etc.).
  ghci-mcp init                          Write a starter ${CONFIG_FILENAME}.

Environment:
  GHCI_MCP_ROOT   Project root to use instead of walking up from cwd.
`;

async function main(argv: string[]): Promise<void> {
  const sep = argv.indexOf("--");
  const own = sep === -1 ? argv : argv.slice(0, sep);
  const rest = sep === -1 ? [] : argv.slice(sep + 1);

  const { values, positionals } = parseArgs({
    args: own,
    allowPositionals: true,
    options: {
      session: { type: "string", short: "s", default: "default" },
      root: { type: "string" },
      wait: { type: "boolean", default: false },
      quiet: { type: "boolean", short: "q", default: false },
      help: { type: "boolean", short: "h", default: false },
      timeout: { type: "string" },
    },
  });

  const [sub, ...args] = positionals;
  if (values.help || !sub) {
    process.stdout.write(USAGE);
    process.exit(sub ? 0 : 1);
  }

  const cfg = loadConfig(values.root);
  const name = values.session!;
  // Errors propagate to main().catch, which prints them and exits 1.
  const runOnce = async (cmd: string, timeoutMs?: number) => {
    const c = new SessionClient(sessionPaths(cfg, name).socket);
    try {
      return await c.run(cmd, timeoutMs);
    } finally {
      c.close();
    }
  };

  switch (sub) {
    case "serve": {
      const { sc, paths, command: configured, cwd } = resolveSession(cfg, name);
      const command = rest.length ? rest.join(" ") : configured;
      if (!command) {
        die(
          `No command given and none configured for session "${name}".\n` +
            `  ghci-mcp serve -- cabal repl lib:mypkg\n` +
            `or add one to ${join(cfg.root, CONFIG_FILENAME)} (ghci-mcp init writes a starter).`,
        );
      }
      const daemon = new Daemon({
        name,
        socketPath: paths.socket,
        command: command!,
        cwd,
        env: sc.env,
        initCommands: sc.init ?? [],
        startupTimeoutMs: sc.startupTimeoutMs,
        defaultTimeoutMs: sc.commandTimeoutMs,
        verbose: !values.quiet,
      });
      daemon.on("closed", (code) => process.exit(code ?? 0));
      await daemon.start();
      return; // keeps running until GHCi exits or we get a signal
    }

    case "start": {
      const r = await startSession({ name, command: rest.length ? rest.join(" ") : undefined, wait: values.wait }, cfg);
      if (r.alreadyRunning) {
        console.log(`Session "${name}" already running (pid ${r.pid}).`);
      } else {
        console.log(`Started session "${name}" (pid ${r.pid}): ${r.command}\nlog: ${r.logPath}`);
      }
      if (r.status) console.log(formatStatus(r.status));
      if (r.status?.exited) {
        console.log(tail(r.logPath));
        process.exit(1);
      }
      return;
    }

    case "stop": {
      const c = new SessionClient(sessionPaths(cfg, name).socket);
      try {
        await c.shutdown();
        console.log(`Session "${name}" shutting down.`);
      } catch (e) {
        if (e instanceof NoSessionError) die(`Session "${name}" is not running.`);
        throw e;
      } finally {
        c.close();
      }
      return;
    }

    case "status": {
      const s = await probeStatus(sessionPaths(cfg, name).socket);
      if (!s) {
        console.log(`Session "${name}" is not running (project root ${cfg.root}).`);
        process.exit(1);
      }
      console.log(formatStatus(s));
      return;
    }

    case "send": {
      const cmd = args.join(" ");
      if (!cmd) die("usage: ghci-mcp send CMD");
      const r = await runOnce(cmd, values.timeout ? Number(values.timeout) : undefined);
      process.stdout.write(r.output + (r.output.endsWith("\n") || r.output === "" ? "" : "\n"));
      if (r.interrupted) console.error("[interrupted]");
      return;
    }

    case "reload": {
      const r = await runOnce(":reload");
      const summary = parseLoadOutput(r.output);
      console.log(formatLoad(summary, r.output, r.durationMs));
      process.exit(summary.status === "failed" ? 1 : 0);
    }

    case "mcp": {
      await runStdio(cfg);
      return;
    }

    case "init": {
      const path = join(cfg.root, CONFIG_FILENAME);
      if (existsSync(path)) die(`${path} already exists`);
      const starter = {
        sessions: {
          default: {
            command: guessCommand(cfg.root) ?? "cabal repl",
            testCommand: ":main",
            init: [],
          },
        },
      };
      writeFileSync(path, JSON.stringify(starter, null, 2) + "\n");
      console.log(`Wrote ${path}`);
      return;
    }

    default:
      die(`unknown command "${sub}"\n\n${USAGE}`);
  }
}

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

main(process.argv.slice(2)).catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
