/**
 * Wire protocol between the session daemon (`ghci-mcp serve`) and its clients
 * (the MCP server, `ghci-mcp send`, etc.).
 *
 * Newline-delimited JSON over a Unix domain socket. Every request carries an
 * `id`; the daemon replies with exactly one message carrying the same `id`.
 */

import type { SessionError } from "./session.js";

export type Request =
  | { id: string; op: "run"; cmd: string; timeoutMs?: number }
  | { id: string; op: "status" }
  | { id: string; op: "interrupt" }
  | { id: string; op: "shutdown" };

export interface SessionStatus {
  /** Session name (from config / --session). */
  name: string;
  /** The user-supplied command that started GHCi. */
  command: string;
  /** Working directory the command was started in. */
  cwd: string;
  /** PID of the daemon process (not GHCi itself). */
  daemonPid: number;
  /** PID of the spawned shell/GHCi process, if alive. */
  childPid: number | null;
  /** Whether the first prompt sentinel has been seen (GHCi is accepting commands). */
  ready: boolean;
  /** Whether a command is currently executing. */
  busy: boolean;
  /** Number of commands waiting behind the current one. */
  queued: number;
  /** ms since the daemon started. */
  uptimeMs: number;
  /** ms the startup took (time to first prompt), once known. */
  startupMs: number | null;
  /** Total commands executed so far. */
  commandsRun: number;
  /** Set when the child has exited. */
  exited: { code: number | null; signal: string | null } | null;
  /** Tail of raw startup output (useful if startup failed). */
  startupTail: string;
}

export type Response =
  | { id: string; ok: true; op: "run"; output: string; durationMs: number; interrupted: boolean }
  | { id: string; ok: true; op: "status"; status: SessionStatus }
  | { id: string; ok: true; op: "interrupt" }
  | { id: string; ok: true; op: "shutdown" }
  | { id: string; ok: false; error: string; code: ErrorCode };

export type ErrorCode = SessionError["code"] | "bad_request" | "internal";
