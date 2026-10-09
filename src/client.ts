import { createConnection, type Socket } from "node:net";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import type { Request, Response, SessionStatus } from "./protocol.js";

/**
 * Thin client for the session daemon. One connection per client; requests are
 * multiplexed by id. Connection failures are turned into NoSessionError so the
 * caller can give the user a precise "start it like this" message.
 */

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

export class NoSessionError extends Error {
  constructor(
    public readonly socketPath: string,
    cause: string,
  ) {
    super(`No GHCi session is listening at ${socketPath} (${cause})`);
    this.name = "NoSessionError";
  }
}

export class DaemonError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DaemonError";
  }
}

export class SessionClient {
  private sock: Socket | null = null;
  private pending = new Map<string, { resolve: (r: Response) => void; reject: (e: Error) => void }>();

  constructor(readonly socketPath: string) {}

  async connect(): Promise<void> {
    if (this.sock && !this.sock.destroyed) return;
    await new Promise<void>((resolve, reject) => {
      const sock = createConnection(this.socketPath);
      sock.once("connect", () => {
        this.sock = sock;
        const rl = createInterface({ input: sock, terminal: false });
        rl.on("line", (line) => {
          let r: Response;
          try {
            r = JSON.parse(line) as Response;
          } catch {
            return;
          }
          const p = this.pending.get(r.id);
          if (p) {
            this.pending.delete(r.id);
            p.resolve(r);
          }
        });
        sock.on("close", () => {
          const err = new NoSessionError(this.socketPath, "connection closed");
          for (const p of this.pending.values()) p.reject(err);
          this.pending.clear();
          this.sock = null;
        });
        sock.on("error", () => {
          /* surfaced via close */
        });
        resolve();
      });
      sock.once("error", (e: NodeJS.ErrnoException) => {
        reject(new NoSessionError(this.socketPath, e.code ?? e.message));
      });
    });
  }

  close(): void {
    this.sock?.destroy();
    this.sock = null;
  }

  private async request<T extends Response>(req: DistributiveOmit<Request, "id">): Promise<T> {
    await this.connect();
    const id = randomUUID();
    const full = { id, ...req } as Request;
    const res = await new Promise<Response>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.sock!.write(JSON.stringify(full) + "\n");
    });
    if (!res.ok) throw new DaemonError(res.code, res.error);
    return res as T;
  }

  async run(cmd: string, timeoutMs?: number): Promise<{ output: string; durationMs: number; interrupted: boolean }> {
    return this.request<Extract<Response, { op: "run" }>>({ op: "run", cmd, timeoutMs });
  }

  async status(): Promise<SessionStatus> {
    const r = await this.request<Extract<Response, { op: "status" }>>({ op: "status" });
    return r.status;
  }

  async interrupt(): Promise<void> {
    await this.request({ op: "interrupt" });
  }

  async shutdown(): Promise<void> {
    await this.connect(); // not running → NoSessionError reaches the caller
    try {
      await this.request({ op: "shutdown" });
    } catch (e) {
      if (!(e instanceof NoSessionError)) throw e;
    }
  }
}

/** Convenience: one-shot status check that never throws. */
export async function probeStatus(socketPath: string): Promise<SessionStatus | null> {
  const c = new SessionClient(socketPath);
  try {
    return await c.status();
  } catch {
    return null;
  } finally {
    c.close();
  }
}
