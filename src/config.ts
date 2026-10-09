import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

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
  /** Directory holding sockets and logs: `~/.cache/ghci-mcp/<project>-<hash>` (see stateDirFor). */
  stateDir: string;
}

export const CONFIG_FILENAME = "ghci-mcp.json";
export const DEFAULT_SESSION = "default";

export function findProjectRoot(startDir: string = process.env.GHCI_MCP_ROOT ?? process.cwd()): string {
  const start = resolve(startDir);
  // Walking up, prefer ghci-mcp.json, then the nearest cabal.project/stack.yaml (so a package dir
  // inside a multi-package project resolves to the project), then hie.yaml / a .cabal file.
  let project: string | null = null;
  let pkg: string | null = null;
  for (let dir = start; ; dir = dirname(dir)) {
    if (existsSync(join(dir, CONFIG_FILENAME))) return dir;
    project ??= isProjectDir(dir) ? dir : null;
    pkg ??= existsSync(join(dir, "hie.yaml")) || hasCabalFile(dir) ? dir : null;
    if (dirname(dir) === dir) break;
  }
  // Nothing above? The project may live below, e.g. a git repo with the Haskell code in a
  // subdirectory: use the single project dir within two levels, so a client started at the repo
  // root and a daemon started in the subdirectory agree on the root (and socket path).
  return project ?? pkg ?? findSingleProjectBelow(start) ?? start;
}

function isProjectDir(dir: string): boolean {
  return [CONFIG_FILENAME, "cabal.project", "stack.yaml"].some((f) => existsSync(join(dir, f)));
}

// ponytail: fixed depth 2; ambiguous (2+ matches) falls back to startDir - use ghci-mcp.json or GHCI_MCP_ROOT then.
function findSingleProjectBelow(start: string): string | null {
  const subdirs = (dir: string) => {
    try {
      return readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules" && e.name !== "dist-newstyle")
        .map((e) => join(dir, e.name));
    } catch {
      return [];
    }
  };
  const level1 = subdirs(start);
  for (const level of [level1, level1.flatMap(subdirs)]) {
    const hits = level.filter(isProjectDir);
    if (hits.length === 1) return hits[0]!;
    if (hits.length > 1) return null;
  }
  return null;
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
  return { root, configPath: found, sessions, stateDir: stateDirFor(root) };
}

/**
 * Per-project state dir outside the repo: `$XDG_CACHE_HOME/ghci-mcp/<basename>-<hash of root>`
 * (default `~/.cache/ghci-mcp/...`). Kept short: Unix socket paths are limited to ~104 bytes.
 */
export function stateDirFor(root: string): string {
  const hash = createHash("sha256").update(root).digest("hex").slice(0, 12);
  const cache = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return join(cache, "ghci-mcp", `${basename(root).slice(0, 24)}-${hash}`);
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
