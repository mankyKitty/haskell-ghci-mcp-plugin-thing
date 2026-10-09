import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";

/**
 * GhciSession owns a single GHCi process (started by an arbitrary user
 * command such as `cabal repl lib:foo` or `stack repl`) and turns it into a
 * request/response machine.
 *
 * How it works
 * ------------
 * GHCi is spawned over plain pipes (no pty). stderr is merged into stdout at
 * the fd level via `sh -c 'exec <cmd> 2>&1'` so diagnostics and program output
 * stay in order. Because stdin is not a TTY, GHCi does not use haskeline, does
 * not echo input, and GHC disables coloured diagnostics - so the output is
 * clean text.
 *
 * On startup we send two commands:
 *
 *     :set prompt      "\n<<ghci-mcp:UUID>>\n"
 *     :set prompt-cont "<<ghci-mcp-cont:UUID>>\n"
 *
 * Every subsequent prompt GHCi prints is therefore an unambiguous sentinel on
 * its own line. The output of a command is everything printed between sending
 * it and the next sentinel. Commands are strictly serialised through a queue.
 *
 * A command that exceeds its timeout is interrupted with SIGINT to the process
 * group (exactly what Ctrl-C in a terminal does), which makes GHCi abandon the
 * evaluation and return to the prompt.
 */

export interface SessionOptions {
  /** Shell command to start GHCi (run via `sh -c`). */
  command: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** How long to wait for the first prompt. Default 10 minutes (cabal repl can be slow). */
  startupTimeoutMs?: number;
  /** Default per-command timeout. Default 5 minutes. */
  defaultTimeoutMs?: number;
  /** After SIGINT, how long to wait for the prompt to come back. Default 10s. */
  interruptGraceMs?: number;
  /** Extra GHCi commands to run once ready (e.g. ":set -Wall"). */
  initCommands?: string[];
}

export interface RunResult {
  output: string;
  durationMs: number;
  interrupted: boolean;
}

export class SessionError extends Error {
  constructor(
    public readonly code: "not_ready" | "exited" | "timeout" | "continuation",
    message: string,
  ) {
    super(message);
    this.name = "SessionError";
  }
}

interface Pending {
  cmd: string;
  timeoutMs: number;
  resolve: (r: RunResult) => void;
  reject: (e: Error) => void;
  /** set once the command has been written to GHCi */
  startedAt?: number;
  timer?: NodeJS.Timeout;
  interrupted?: boolean;
  /** if set, the command fails with this error once the prompt returns */
  failWith?: SessionError;
}

export interface SessionEvents {
  /** Raw output seen during startup (before the first prompt). */
  startup: [chunk: string];
  ready: [startupMs: number];
  "command:start": [cmd: string];
  "command:output": [chunk: string];
  "command:end": [cmd: string, result: RunResult];
  exit: [code: number | null, signal: NodeJS.Signals | null];
  error: [err: Error];
}

export class GhciSession extends EventEmitter<SessionEvents> {
  readonly promptSentinel: string;
  readonly contSentinel: string;
  readonly startedAt = Date.now();

  private child: ChildProcessByStdio<Writable, Readable, null> | null = null;
  private decoder = new StringDecoder("utf8");
  private buffer = "";
  private queue: Pending[] = [];
  private current: Pending | null = null;
  private _ready = false;
  startupMs: number | null = null;
  exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  private startupOutput = "";
  private startupSentinelsSeen = 0;
  private startupTimer: NodeJS.Timeout | null = null;
  commandCount = 0;
  private readonly opts: Required<Omit<SessionOptions, "env">> & { env?: NodeJS.ProcessEnv };

  constructor(opts: SessionOptions) {
    super();
    this.opts = {
      ...opts,
      startupTimeoutMs: opts.startupTimeoutMs ?? 10 * 60_000,
      defaultTimeoutMs: opts.defaultTimeoutMs ?? 5 * 60_000,
      interruptGraceMs: opts.interruptGraceMs ?? 10_000,
      initCommands: opts.initCommands ?? [],
    };
    const tag = randomUUID().slice(0, 8);
    this.promptSentinel = `<<ghci-mcp:${tag}>>`;
    this.contSentinel = `<<ghci-mcp-cont:${tag}>>`;
  }

  // ---- public state -------------------------------------------------------

  get ready(): boolean {
    return this._ready;
  }
  get busy(): boolean {
    return this.current !== null;
  }
  get queued(): number {
    return this.queue.length;
  }
  get childPid(): number | null {
    return this.child?.pid ?? null;
  }
  get startupTail(): string {
    return this.startupOutput.slice(-4000);
  }
  get command(): string {
    return this.opts.command;
  }
  get cwd(): string {
    return this.opts.cwd;
  }

  // ---- lifecycle ----------------------------------------------------------

  start(): void {
    if (this.child) throw new Error("session already started");

    // `exec` so the shell is replaced by the real command and signals hit it directly;
    // `2>&1` merges stderr into stdout at the fd level, preserving ordering.
    const child = spawn("sh", ["-c", `exec ${this.opts.command} 2>&1`], {
      cwd: this.opts.cwd,
      env: {
        ...process.env,
        ...this.opts.env,
        // Make sure nothing tries to be clever about colour or paging.
        TERM: "dumb",
        NO_COLOR: "1",
        GHC_NO_UNICODE: "1",
      },
      stdio: ["pipe", "pipe", "ignore"],
      // Own process group, so SIGINT can be delivered to GHCi (and cabal/stack
      // wrappers) the same way a terminal's Ctrl-C would.
      detached: true,
    });
    this.child = child;

    child.stdout.on("data", (d: Buffer) => this.onData(this.decoder.write(d)));
    child.on("error", (e) => this.emit("error", e));
    child.on("exit", (code, signal) => this.onExit(code, signal));

    // Install sentinels. These produce two prompts; startup is complete after the second.
    this.write(`:set prompt "\\n${this.promptSentinel}\\n"`);
    this.write(`:set prompt-cont "${this.contSentinel}\\n"`);

    this.startupTimer = setTimeout(() => {
      if (!this._ready) {
        this.emit(
          "error",
          new SessionError("not_ready", `GHCi did not reach a prompt within ${this.opts.startupTimeoutMs}ms`),
        );
        this.kill();
      }
    }, this.opts.startupTimeoutMs);
  }

  /** Politely ask GHCi to quit, then kill the process group if it lingers. */
  async stop(graceMs = 3000): Promise<void> {
    if (!this.child || this.exited) return;
    const exited = new Promise<void>((res) => this.once("exit", () => res()));
    try {
      this.write(":quit");
    } catch {
      /* ignore */
    }
    const t = setTimeout(() => this.kill(), graceMs);
    await exited;
    clearTimeout(t);
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): void {
    const pid = this.child?.pid;
    if (!pid || this.exited) return;
    try {
      process.kill(-pid, signal);
    } catch {
      try {
        this.child?.kill(signal);
      } catch {
        /* ignore */
      }
    }
  }

  /** Send SIGINT to the GHCi process group (like Ctrl-C). */
  interrupt(): void {
    const pid = this.child?.pid;
    if (!pid || this.exited) return;
    if (this.current) this.current.interrupted = true;
    try {
      process.kill(-pid, "SIGINT");
    } catch {
      /* ignore */
    }
  }

  // ---- running commands ---------------------------------------------------

  /**
   * Run one GHCi command and return its output. Multi-line input is wrapped
   * in `:{ ... :}` automatically unless already wrapped.
   */
  run(cmd: string, timeoutMs?: number): Promise<RunResult> {
    if (this.exited) {
      return Promise.reject(new SessionError("exited", "GHCi process has exited"));
    }
    if (!this._ready) {
      return Promise.reject(new SessionError("not_ready", "GHCi has not reached its first prompt yet"));
    }
    const text = normaliseCommand(cmd);
    return new Promise<RunResult>((resolve, reject) => {
      this.queue.push({ cmd: text, timeoutMs: timeoutMs ?? this.opts.defaultTimeoutMs, resolve, reject });
      this.pump();
    });
  }

  private pump(): void {
    if (this.current || this.queue.length === 0 || !this._ready || this.exited) return;
    const p = this.queue.shift()!;
    this.current = p;
    p.startedAt = Date.now();
    this.buffer = "";
    this.emit("command:start", p.cmd);
    p.timer = setTimeout(() => {
      // First attempt: interrupt. If the prompt still doesn't come back, fail hard.
      this.interrupt();
      p.timer = setTimeout(() => {
        if (this.current === p) {
          this.current = null;
          p.reject(
            new SessionError(
              "timeout",
              `command did not finish within ${p.timeoutMs}ms and GHCi did not respond to interrupt`,
            ),
          );
          this.pump();
        }
      }, this.opts.interruptGraceMs);
    }, p.timeoutMs);
    try {
      this.write(p.cmd);
    } catch (e) {
      this.finish(p, undefined, e as Error);
    }
  }

  private finish(p: Pending, result?: RunResult, err?: Error): void {
    if (p.timer) clearTimeout(p.timer);
    if (this.current === p) this.current = null;
    if (err) p.reject(err);
    else if (result) {
      this.commandCount++;
      this.emit("command:end", p.cmd, result);
      p.resolve(result);
    }
    this.pump();
  }

  private write(line: string): void {
    const child = this.child;
    if (!child || !child.stdin.writable) throw new SessionError("exited", "GHCi stdin is not writable");
    child.stdin.write(line.endsWith("\n") ? line : line + "\n");
  }

  // ---- output handling ----------------------------------------------------

  private onData(text: string): void {
    if (!text) return;
    if (!this._ready) {
      this.onStartupData(text);
      return;
    }
    this.buffer += text;
    if (this.current) this.emit("command:output", text);
    this.scanBuffer();
  }

  private onStartupData(text: string): void {
    this.startupOutput += text;
    this.emit("startup", text);
    // Count prompt sentinels; after both :set commands have taken effect we are ready.
    let idx: number;
    while ((idx = this.startupOutput.indexOf(this.promptSentinel + "\n")) !== -1) {
      this.startupSentinelsSeen++;
      this.startupOutput =
        this.startupOutput.slice(0, idx) + this.startupOutput.slice(idx + this.promptSentinel.length + 1);
      if (this.startupSentinelsSeen >= 2) {
        this.becomeReady();
        return;
      }
    }
  }

  private becomeReady(): void {
    if (this.startupTimer) clearTimeout(this.startupTimer);
    this._ready = true;
    this.startupMs = Date.now() - this.startedAt;
    this.buffer = "";
    this.emit("ready", this.startupMs);
    for (const c of this.opts.initCommands) {
      this.run(c).catch(() => {});
    }
    this.pump();
  }

  private scanBuffer(): void {
    const p = this.current;
    if (!p) {
      // Unsolicited output (e.g. a forked thread printing, or a user typing in
      // the daemon terminal directly). Keep the buffer bounded.
      if (this.buffer.length > 64_000) this.buffer = this.buffer.slice(-32_000);
      return;
    }

    // The prompt is "\n<<sentinel>>\n": the leading newline terminates any
    // unterminated last line of output, so output never bleeds into the marker.
    const marker = "\n" + this.promptSentinel + "\n";
    const idx = this.buffer.indexOf(marker);
    if (idx !== -1) {
      let out = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + marker.length);
      // Strip continuation prompts (printed once per line inside :{ :} blocks).
      out = out.replaceAll(this.contSentinel + "\n", "").replaceAll(this.contSentinel, "");
      // Trim a single trailing newline (e.g. from `print`) for tidier results.
      if (out.endsWith("\n")) out = out.slice(0, -1);
      if (p.failWith) {
        this.finish(p, undefined, p.failWith);
        return;
      }
      const result: RunResult = {
        output: out,
        durationMs: Date.now() - p.startedAt!,
        interrupted: p.interrupted === true,
      };
      this.finish(p, result);
      return;
    }

    // GHCi is waiting for more input. For an N-line command GHCi prints N-1
    // continuation prompts and then a real prompt; if we have seen N or more
    // continuation prompts the input was incomplete and GHCi is stuck waiting.
    // Interrupt to abandon the partial input; the resulting prompt ends the command.
    if (this.buffer.endsWith(this.contSentinel + "\n") && !p.interrupted) {
      const contSeen = this.buffer.split(this.contSentinel + "\n").length - 1;
      const linesSent = p.cmd.split("\n").length;
      if (contSeen >= linesSent) {
        p.interrupted = true;
        p.failWith = new SessionError(
          "continuation",
          "GHCi was waiting for more input (unterminated :{ block or incomplete multi-line input). The input was discarded.",
        );
        this.interrupt();
      }
    }
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.exited = { code, signal };
    if (this.startupTimer) clearTimeout(this.startupTimer);
    const err = new SessionError(
      "exited",
      `GHCi process exited (code=${code ?? "null"}, signal=${signal ?? "null"})` +
        (!this._ready ? `\n--- startup output (tail) ---\n${this.startupTail}` : ""),
    );
    if (this.current) {
      const p = this.current;
      this.current = null;
      if (p.timer) clearTimeout(p.timer);
      p.reject(err);
    }
    for (const p of this.queue.splice(0)) p.reject(err);
    this.emit("exit", code, signal);
  }
}

/** Wrap multi-line input in :{ ... :} unless it already is. */
export function normaliseCommand(cmd: string): string {
  const text = cmd.replace(/\r\n/g, "\n").replace(/\n+$/, "");
  if (!text.includes("\n")) return text;
  // If the caller already uses :{ they are driving the block themselves.
  if (text.trimStart().startsWith(":{")) return text;
  return `:{\n${text}\n:}`;
}
