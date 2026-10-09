import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon, socketIsAlive } from "../src/daemon.js";
import { SessionClient, NoSessionError, probeStatus } from "../src/client.js";
import { FAKE } from "./session.test.js";

const dirs: string[] = [];
const daemons: Daemon[] = [];

function tmp() {
  const d = mkdtempSync(join(tmpdir(), "ghci-mcp-"));
  dirs.push(d);
  return d;
}

async function startDaemon(env: Record<string, string> = {}) {
  const dir = tmp();
  const socketPath = join(dir, "s.sock");
  const d = new Daemon({
    name: "t",
    socketPath,
    command: FAKE,
    cwd: dir,
    env,
    verbose: false,
    interactive: false,
    handleSignals: false,
    log: () => {},
  });
  daemons.push(d);
  await d.start();
  return { d, socketPath };
}

afterEach(async () => {
  for (const d of daemons.splice(0)) {
    d.session.kill("SIGKILL");
    await new Promise((r) => setTimeout(r, 50));
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Daemon + SessionClient", () => {
  it("serves status, run and shutdown over the socket", async () => {
    const { d, socketPath } = await startDaemon();
    const c = new SessionClient(socketPath);

    const s0 = await c.status();
    expect(s0.name).toBe("t");
    expect(s0.daemonPid).toBe(process.pid);

    // wait for ready
    await new Promise<void>((res) => (d.session.ready ? res() : d.session.once("ready", () => res())));
    const s1 = await c.status();
    expect(s1.ready).toBe(true);

    const r = await c.run("hello");
    expect(r.output).toBe("hello evaluated");

    const closed = new Promise<number>((res) => d.once("closed", res));
    await c.shutdown();
    expect(await closed).toBe(0);
    expect(existsSync(socketPath)).toBe(false);
    c.close();
  });

  it("returns not_ready before GHCi is up and exposes startup output", async () => {
    const { socketPath } = await startDaemon({ FAKE_GHCI_STARTUP_MS: "800", FAKE_GHCI_BANNER: "Loading package foo-1.0" });
    const c = new SessionClient(socketPath);
    await expect(c.run("x")).rejects.toMatchObject({ code: "not_ready" });
    // wait until the banner has been printed, then check status carries it
    await new Promise((r) => setTimeout(r, 900));
    const s = await c.status();
    expect(s.ready).toBe(true);
    c.close();
  });

  it("maps a missing socket to NoSessionError / null status", async () => {
    const dir = tmp();
    const sock = join(dir, "nope.sock");
    await expect(new SessionClient(sock).run("x")).rejects.toBeInstanceOf(NoSessionError);
    expect(await probeStatus(sock)).toBeNull();
    expect(await socketIsAlive(sock)).toBe(false);
  });

  it("refuses to start a second daemon on a live socket", async () => {
    const { socketPath } = await startDaemon();
    const dup = new Daemon({
      name: "t",
      socketPath,
      command: FAKE,
      cwd: dirs[0]!,
      verbose: false,
      interactive: false,
      handleSignals: false,
      log: () => {},
    });
    await expect(dup.start()).rejects.toThrow(/already running/);
  });

  it("supports multiple clients sharing one session", async () => {
    const { d, socketPath } = await startDaemon();
    await new Promise<void>((res) => (d.session.ready ? res() : d.session.once("ready", () => res())));
    const a = new SessionClient(socketPath);
    const b = new SessionClient(socketPath);
    const [ra, rb] = await Promise.all([a.run("from a"), b.run("from b")]);
    expect(ra.output).toBe("from a evaluated");
    expect(rb.output).toBe("from b evaluated");
    a.close();
    b.close();
  });
});
