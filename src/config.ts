import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Project configuration: `ghci-mcp.json` found by walking up from the current
 * directory (or from $GHCI_MCP_ROOT if set).
 *
 * Example:
 * {
 *   "sessions": {
 *     "default": {
 *       "command": "cabal repl lib:myproject",
 *       "testCommand": ":main",
 *       "init": [":set -Wall"]
 *     },
 *     "test": { "command": "cabal repl test:spec", "testCommand": ":main" }
 *   }
 * }
 *
 * A shorthand with no `sessions` key is treated as the `default` session:
 * { "command": "stack repl" }
 */

export interface SessionConfig {
  /** Shell command that starts GHCi. Required to auto-start; optional if the user always starts it manually. */
  command?: string;
  /** Working directory for the command, relative to the project root. Default: project root. */
  cwd?: string;
  /** GHCi commands to run once the session is ready. */
  init?: string[];
  /** Expression/command that runs the test suite from within GHCi. Default ":main". */
  testCommand?: string;
  /** Milliseconds to wait for the first prompt. Default 600000 (10 min). */
  startupTimeoutMs?: number;
  /** Default per-command timeout in ms. Default 300000 (5 min). */
  commandTimeoutMs?: number;
  /** Extra environment variables for the GHCi process. */
  env?: Record<string, string>;
}

export interface ProjectConfig {
  root: string;
  configPath: string | null;
  sessions: Record<string, SessionConfig>;
  /** Directory holding sockets and logs: `<root>/.ghci-mcp`. */
  stateDir: string;
}

export const CONFIG_FILENAME = "ghci-mcp.json";
export const DEFAULT_SESSION = "default";

export function findProjectRoot(startDir: string = process.env.GHCI_MCP_ROOT ?? process.cwd()): string {
  let dir = resolve(startDir);
  // Prefer a directory with ghci-mcp.json; fall back to one with a cabal/stack/hie marker; else startDir.
  let fallback: string | null = null;
  for (;;) {
    if (existsSync(join(dir, CONFIG_FILENAME))) return dir;
    if (
      fallback === null &&
      (existsSync(join(dir, "cabal.project")) ||
        existsSync(join(dir, "stack.yaml")) ||
        existsSync(join(dir, "hie.yaml")) ||
        existsSync(join(dir, ".ghci-mcp")) ||
        hasCabalFile(dir))
    ) {
      fallback = dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return fallback ?? resolve(startDir);
}

function hasCabalFile(dir: string): boolean {
  try {
    return readdirSync(dir).some((f) => f.endsWith(".cabal"));
  } catch {
    return false;
  }
}

export function loadConfig(startDir?: string): ProjectConfig {
  const root = findProjectRoot(startDir);
  const configPath = join(root, CONFIG_FILENAME);
  let sessions: Record<string, SessionConfig> = {};
  let found: string | null = null;

  if (existsSync(configPath)) {
    found = configPath;
    const raw = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    // shorthand: top-level keys describe the default session
    sessions =
      raw.sessions && typeof raw.sessions === "object"
        ? (raw.sessions as Record<string, SessionConfig>)
        : { [DEFAULT_SESSION]: raw as SessionConfig };
  }

  if (!sessions[DEFAULT_SESSION]) sessions[DEFAULT_SESSION] = {};
  return { root, configPath: found, sessions, stateDir: join(root, ".ghci-mcp") };
}

export function sessionPaths(cfg: ProjectConfig, name: string) {
  return {
    socket: join(cfg.stateDir, `${name}.sock`),
    log: join(cfg.stateDir, `${name}.log`),
  };
}

/** Best-effort guess of a start command when none is configured. */
export function guessCommand(root: string): string | null {
  if (existsSync(join(root, "stack.yaml"))) return "stack repl";
  if (existsSync(join(root, "cabal.project")) || hasCabalFile(root)) return "cabal repl";
  return null;
}
