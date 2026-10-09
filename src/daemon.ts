import { createConnection, createServer, type Server, type Socket } from "node:net";
import { existsSync, mkdirSync, unlinkSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { EventEmitter } from "node:events";
import { GhciSession, SessionError, type SessionOptions } from "./session.js";
import type { Request, Response, SessionStatus } from "./protocol.js";

/**
 * The session daemon: owns one GhciSession and exposes it on a Unix socket.
 *
 * It is designed to be run by the *user* in a terminal (`ghci-mcp serve -- cabal repl`)
 * so that they control exactly how GHCi is started and can watch what the
 * agent does. It can also be launched detached by the MCP server when
 * configured to do so - the daemon itself does not care.
 *
 * When `interactive` is on, lines typed into the daemon's own stdin are sent
 * to GHCi through the same queue, so the terminal still works as a REPL.
 */

export interface DaemonOptions extends SessionOptions {
  name: string;
  socketPath: string;
  /** Echo agent traffic to stderr/stdout. Default true. */
  verbose?: boolean;
  /** Forward lines from our own stdin to GHCi. Default: true if stdin is a TTY. */
  interactive?: boolean;
  /** Install SIGINT/SIGTERM/SIGHUP handlers on this process. Default true. */
  handleSignals?: boolean;
  log?: (line: string) => void;
}

export class Daemon extends EventEmitter<{ closed: [exitCode: number] }> {
  readonly session: GhciSession;
  private server: Server | null = null;
  private readonly log: (line: string) => void;
  private closing = false;
  private readonly conns = new Set<Socket>();

  constructor(private readonly opts: DaemonOptions) {
    super();
    this.session = new GhciSession(opts);
    this.log = opts.log ?? ((l) => process.stderr.write(l + "\n"));
  }

  status(): SessionStatus {
    const s = this.session;
    return {
      name: this.opts.name,
      command: s.command,
      cwd: s.cwd,
      daemonPid: process.pid,
      childPid: s.childPid,
      ready: s.ready,
      busy: s.busy,
      queued: s.queued,
      uptimeMs: Date.now() - s.startedAt,
      startupMs: s.startupMs,
      commandsRun: s.commandCount,
      exited: s.exited ? { code: s.exited.code, signal: s.exited.signal } : null,
      startupTail: s.startupTail,
    };
  }

  async start(): Promise<void> {
    const { socketPath, verbose = true } = this.opts;
    mkdirSync(dirname(socketPath), { recursive: true });

    // Refuse to clobber a live session; clean up a stale socket.
    if (existsSync(socketPath)) {
      if (await socketIsAlive(socketPath)) {
        throw new Error(
          `A session named "${this.opts.name}" is already running (socket ${socketPath}). ` +
            `Stop it first, or use --session <other-name>.`,
        );
      }
      unlinkSync(socketPath);
    }

    const s = this.session;
    if (verbose) {
      s.on("startup", (chunk) => process.stdout.write(chunk));
      s.on("ready", (ms) => this.log(`\n[ghci-mcp] session "${this.opts.name}" ready in ${(ms / 1000).toFixed(1)}s; listening on ${socketPath}`));
      s.on("command:start", (cmd) => this.log(`\n[ghci-mcp] > ${oneLine(cmd)}`));
      s.on("command:output", (chunk) => process.stdout.write(chunk));
      s.on("command:end", (_cmd, r) =>
        this.log(`[ghci-mcp] (${r.durationMs}ms${r.interrupted ? ", interrupted" : ""})`),
      );
    }
    s.on("error", (e) => this.log(`[ghci-mcp] error: ${e.message}`));
    s.on("exit", (code, signal) => {
      this.log(`\n[ghci-mcp] GHCi exited (code=${code}, signal=${signal}); shutting down.`);
      void this.close();
    });

    this.server = createServer((sock) => this.handleConnection(sock));
    await new Promise<void>((res, rej) => {
      this.server!.once("error", rej);
      this.server!.listen(socketPath, () => {
        this.server!.off("error", rej);
        res();
      });
    });

    s.start();
    this.log(`[ghci-mcp] starting: ${s.command}\n[ghci-mcp] cwd: ${s.cwd}`);

    const interactive = this.opts.interactive ?? process.stdin.isTTY === true;
    if (interactive) this.attachStdin();

    if (this.opts.handleSignals === false) return;
    const shutdown = () => void this.close();
    process.on("SIGINT", () => {
      // Ctrl-C in the daemon terminal: forward to GHCi if it's busy, else quit.
      if (s.busy) {
        this.log("[ghci-mcp] interrupting current command");
        s.interrupt();
      } else {
        shutdown();
      }
    });
    process.on("SIGTERM", shutdown);
    process.on("SIGHUP", shutdown);
  }

  private attachStdin(): void {
    const rl = createInterface({ input: process.stdin, terminal: false });
    rl.on("line", (line) => {
      if (!line.trim()) return;
      this.session.run(line).catch((e: Error) => this.log(`[ghci-mcp] ${e.message}`));
    });
    rl.on("close", () => void this.close());
  }

  private handleConnection(sock: Socket): void {
    this.conns.add(sock);
    sock.on("close", () => this.conns.delete(sock));
    const rl = createInterface({ input: sock, terminal: false });
    const send = (r: Response) => {
      if (!sock.destroyed) sock.write(JSON.stringify(r) + "\n");
    };
    rl.on("line", (line) => {
      let req: Request;
      try {
        req = JSON.parse(line) as Request;
      } catch {
        send({ id: "?", ok: false, error: "invalid JSON", code: "bad_request" });
        return;
      }
      void this.handleRequest(req).then(send);
    });
    sock.on("error", () => {
      /* client went away */
    });
  }

  private async handleRequest(req: Request): Promise<Response> {
    const id = req.id ?? "?";
    try {
      switch (req.op) {
        case "status":
          return { id, ok: true, op: "status", status: this.status() };
        case "interrupt":
          this.session.interrupt();
          return { id, ok: true, op: "interrupt" };
        case "shutdown":
          setTimeout(() => void this.close(), 10);
          return { id, ok: true, op: "shutdown" };
        case "run": {
          if (typeof req.cmd !== "string") {
            return { id, ok: false, error: "`cmd` must be a string", code: "bad_request" };
          }
          const r = await this.session.run(req.cmd, req.timeoutMs);
          return { id, ok: true, op: "run", output: r.output, durationMs: r.durationMs, interrupted: r.interrupted };
        }
        default:
          return { id, ok: false, error: `unknown op ${(req as { op: string }).op}`, code: "bad_request" };
      }
    } catch (e) {
      if (e instanceof SessionError) return { id, ok: false, error: e.message, code: e.code };
      return { id, ok: false, error: (e as Error).message, code: "internal" };
    }
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    await this.session.stop();
    for (const c of this.conns) c.end();
    await new Promise<void>((res) => (this.server ? this.server.close(() => res()) : res()));
    try {
      rmSync(this.opts.socketPath, { force: true });
    } catch {
      /* ignore */
    }
    this.emit("closed", this.session.exited?.code ?? 0);
  }
}

function oneLine(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > 120 ? t.slice(0, 117) + "..." : t;
}

/** Probe a socket path: true if something accepts connections there. */
export function socketIsAlive(path: string, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const c = createConnection(path);
    const t = setTimeout(() => {
      c.destroy();
      resolve(false);
    }, timeoutMs);
    c.once("connect", () => {
      clearTimeout(t);
      c.destroy();
      resolve(true);
    });
    c.once("error", () => {
      clearTimeout(t);
      resolve(false);
    });
  });
}
