import { afterEach, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { GhciSession, SessionError, normaliseCommand } from "../src/session.js";

const here = dirname(fileURLToPath(import.meta.url));
export const FAKE = `node ${JSON.stringify(join(here, "fake-ghci.mjs"))}`;

const sessions: GhciSession[] = [];
export function fake(env: Record<string, string> = {}, opts: Partial<ConstructorParameters<typeof GhciSession>[0]> = {}) {
  const s = new GhciSession({ command: FAKE, cwd: here, env, startupTimeoutMs: 10_000, ...opts });
  sessions.push(s);
  return s;
}
export const ready = (s: GhciSession) =>
  new Promise<number>((res, rej) => {
    s.once("ready", res);
    s.once("error", rej);
    s.once("exit", (code) => rej(new Error(`exited ${code}`)));
    s.start();
  });

afterEach(async () => {
  for (const s of sessions.splice(0)) s.kill("SIGKILL");
});

describe("GhciSession", () => {
  it("reaches ready after the sentinel prompts are installed", async () => {
    const s = fake();
    expect(s.ready).toBe(false);
    const ms = await ready(s);
    expect(ms).toBeGreaterThanOrEqual(0);
    expect(s.ready).toBe(true);
    expect(s.startupTail).toContain("GHCi, version 9.9.9");
    expect(s.startupTail).not.toContain(s.promptSentinel);
  });

  it("runs commands and returns their exact output", async () => {
    const s = fake();
    await ready(s);
    const r = await s.run("1 + 1");
    expect(r.output).toBe("1 + 1 evaluated");
    expect(r.interrupted).toBe(false);
    const t = await s.run(":t foo");
    expect(t.output).toBe("foo :: Int -> Int");
    expect(s.commandCount).toBe(2);
  });

  it("handles output with no trailing newline", async () => {
    const s = fake();
    await ready(s);
    expect((await s.run("noeol")).output).toBe("no trailing newline");
  });

  it("merges stderr into the output stream", async () => {
    const s = fake();
    await ready(s);
    expect((await s.run("stderr")).output).toBe("to stderr");
  });

  it("serialises concurrent commands in order", async () => {
    const s = fake();
    await ready(s);
    const rs = await Promise.all(["a", "b", "c"].map((c) => s.run(c)));
    expect(rs.map((r) => r.output)).toEqual(["a evaluated", "b evaluated", "c evaluated"]);
  });

  it("wraps multi-line input in :{ :} and strips continuation prompts", async () => {
    const s = fake();
    await ready(s);
    const r = await s.run("f :: Int -> Int\nf x = x + 1");
    expect(r.output).toBe("defined 2 line(s)");
    expect(r.output).not.toContain(s.contSentinel);
  });

  it("detects an unterminated :{ block and recovers", async () => {
    const s = fake();
    await ready(s);
    await expect(s.run(":{\nf x = x")).rejects.toMatchObject({ code: "continuation" });
    // session is still usable afterwards
    expect((await s.run("ok")).output).toBe("ok evaluated");
  });

  it("interrupts a command that exceeds its timeout", async () => {
    const s = fake();
    await ready(s);
    const r = await s.run(":sleep 5000", 300);
    expect(r.interrupted).toBe(true);
    expect(r.output).toContain("Interrupted.");
    expect(r.durationMs).toBeLessThan(3000);
    expect((await s.run("after")).output).toBe("after evaluated");
  });

  it("rejects pending commands when GHCi exits and reports exit", async () => {
    const s = fake();
    await ready(s);
    const exited = new Promise((res) => s.once("exit", (code) => res(code)));
    await expect(s.run(":quit")).rejects.toBeInstanceOf(SessionError);
    expect(await exited).toBe(0);
    expect(s.exited).toEqual({ code: 0, signal: null });
    await expect(s.run("x")).rejects.toMatchObject({ code: "exited" });
  });

  it("surfaces startup failure with the output tail", async () => {
    const s = fake({ FAKE_GHCI_CRASH: "1" });
    await expect(ready(s)).rejects.toThrow(/exited 3/);
    expect(s.exited?.code).toBe(3);
    expect(s.startupTail).toContain("boom");
  });

  it("refuses commands before ready", async () => {
    const s = fake({ FAKE_GHCI_STARTUP_MS: "500" });
    s.start();
    await expect(s.run("x")).rejects.toMatchObject({ code: "not_ready" });
  });

  it("runs init commands once ready", async () => {
    const s = fake({}, { initCommands: [":fail"] });
    await ready(s);
    const r = await s.run(":reload");
    expect(r.output).toContain("Failed, one module loaded.");
  });
});

describe("normaliseCommand", () => {
  it("leaves single lines alone", () => {
    expect(normaliseCommand("1 + 1\n")).toBe("1 + 1");
  });
  it("wraps multi-line and respects existing wrapping", () => {
    expect(normaliseCommand("a\nb")).toBe(":{\na\nb\n:}");
    expect(normaliseCommand(":{\na\n:}")).toBe(":{\na\n:}");
  });
});
