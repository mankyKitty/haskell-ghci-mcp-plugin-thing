import { spawn } from "node:child_process";
import { mkdirSync, openSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { sessionPaths, guessCommand, type ProjectConfig } from "./config.js";
import { probeStatus } from "./client.js";
import type { SessionStatus } from "./protocol.js";

/**
 * Starting sessions in the background (used by `ghci-mcp start` and by the
 * MCP `ghci_start` tool). The daemon is spawned fully detached with its output
 * going to `<stateDir>/<name>.log`, so it outlives whichever process asked for it.
 */

export interface StartOptions {
  name?: string;
  /** Override the configured command. */
  command?: string;
  /** Wait for the session to become ready (up to startupTimeoutMs). Default false. */
  wait?: boolean;
}

export interface StartResult {
  name: string;
  command: string;
  socketPath: string;
  logPath: string;
  pid: number;
  alreadyRunning: boolean;
  status: SessionStatus | null;
}

export function resolveSession(cfg: ProjectConfig, name = "default") {
  const sc = cfg.sessions[name] ?? {};
  const paths = sessionPaths(cfg, name);
  const command = sc.command ?? (name === "default" ? guessCommand(cfg.root) : null);
  const cwd = sc.cwd ? join(cfg.root, sc.cwd) : cfg.root;
  return { name, sc, paths, command, cwd };
}

export async function startSession(opts: StartOptions, cfg: ProjectConfig): Promise<StartResult> {
  const name = opts.name ?? "default";
  const { sc, paths, command: configured, cwd } = resolveSession(cfg, name);
  const command = opts.command ?? configured;

  const existing = await probeStatus(paths.socket);
  if (existing) {
    return {
      name,
      command: existing.command,
      socketPath: paths.socket,
      logPath: paths.log,
      pid: existing.daemonPid,
      alreadyRunning: true,
      status: existing,
    };
  }

  if (!command) {
    throw new Error(
      `No start command for session "${name}". Add one to ${join(cfg.root, "ghci-mcp.json")}, e.g.\n` +
        `  { "sessions": { "${name}": { "command": "cabal repl lib:mypkg" } } }\n` +
        `or start it yourself in a terminal:\n` +
        `  ghci-mcp serve --session ${name} -- cabal repl lib:mypkg`,
    );
  }

  mkdirSync(cfg.stateDir, { recursive: true });
  const logFd = openSync(paths.log, "a");
  const cli = findCli();
  const args = [cli, "serve", "--session", name, "--root", cfg.root, "--", command];
  const child = spawn(process.execPath, args, {
    cwd,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env, ...(sc.env ?? {}) },
  });
  child.unref();
  const pid = child.pid!;

  let status: SessionStatus | null = null;
  if (opts.wait) {
    const deadline = Date.now() + (sc.startupTimeoutMs ?? 10 * 60_000);
    while (Date.now() < deadline) {
      await sleep(500);
      status = await probeStatus(paths.socket);
      if (status?.ready || status?.exited) break;
      if (!status && !processAlive(pid)) {
        throw new Error(`session daemon exited during startup; see ${paths.log}\n${tail(paths.log)}`);
      }
    }
  } else {
    // give it a moment so an immediate failure is visible
    await sleep(300);
    status = await probeStatus(paths.socket);
    if (!status && !processAlive(pid)) {
      throw new Error(`session daemon failed to start; see ${paths.log}\n${tail(paths.log)}`);
    }
  }

  return { name, command, socketPath: paths.socket, logPath: paths.log, pid, alreadyRunning: false, status };
}

/** Path to the built CLI, so the daemon can be spawned as a separate node process. */
function findCli(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [join(here, "cli.js"), join(here, "..", "dist", "cli.js")]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("ghci-mcp: cannot locate dist/cli.js - run `npm run build`");
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function tail(path: string, bytes = 4000): string {
  try {
    return readFileSync(path, "utf8").slice(-bytes);
  } catch {
    return "";
  }
}
