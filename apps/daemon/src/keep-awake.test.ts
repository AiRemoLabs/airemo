import type { ChildProcess } from "node:child_process";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { KeepAwake, keepAwakeCommand } from "./keep-awake.js";
import { startDaemon } from "./server.js";

function fakeChild() {
  const e = new EventEmitter() as EventEmitter & { kill: () => boolean; killed: boolean };
  e.killed = false;
  e.kill = () => {
    e.killed = true;
    e.emit("exit", null, "SIGTERM");
    return true;
  };
  return e;
}

describe("keepAwakeCommand", () => {
  it("uses caffeinate on macOS, tied to the daemon pid", () => {
    expect(keepAwakeCommand("darwin", 42)).toEqual({
      cmd: "caffeinate",
      args: ["-i", "-s", "-w", "42"],
    });
  });
  it("uses systemd-inhibit on Linux, tied to the daemon pid", () => {
    const c = keepAwakeCommand("linux", 42);
    expect(c?.cmd).toBe("systemd-inhibit");
    expect(c?.args).toContain("--what=idle:sleep");
    expect(c?.args).toContain("--pid=42");
  });
  it("is unsupported elsewhere", () => {
    expect(keepAwakeCommand("win32", 42)).toBeNull();
    expect(new KeepAwake({ platform: "win32" }).start()).toBe("unsupported");
  });
});

describe("KeepAwake", () => {
  it("starts once, and stop releases the lock", () => {
    const children: ReturnType<typeof fakeChild>[] = [];
    const k = new KeepAwake({
      platform: "darwin",
      pid: 7,
      spawn: () => {
        const c = fakeChild();
        children.push(c);
        return c as unknown as ChildProcess;
      },
    });
    expect(k.start()).toBe("on");
    expect(k.start()).toBe("on");
    expect(children).toHaveLength(1);
    k.stop();
    expect(children[0]?.killed).toBe(true);
    expect(k.state).toBe("off");
  });

  it("reports failure when the helper dies or cannot run", () => {
    const logs: string[] = [];
    const c = fakeChild();
    const k = new KeepAwake({
      platform: "darwin",
      spawn: () => c as unknown as ChildProcess,
      log: (m) => logs.push(m),
    });
    k.start();
    c.emit("exit", 1, null);
    expect(k.state).toBe("failed");
    expect(logs[0]).toMatch(/may sleep/);

    const e = fakeChild();
    const k2 = new KeepAwake({ platform: "darwin", spawn: () => e as unknown as ChildProcess });
    k2.start();
    e.emit("error", new Error("ENOENT"));
    expect(k2.state).toBe("failed");
  });
});

describe.runIf(process.platform === "darwin")("KeepAwake on macOS", () => {
  it("holds a real sleep assertion until stopped", async () => {
    const k = new KeepAwake();
    expect(k.start()).toBe("on");
    await new Promise((r) => setTimeout(r, 300));
    const mine = () =>
      execFileSync("pmset", ["-g", "assertions"], { encoding: "utf8" }).includes(
        `caffeinate asserting on behalf of Process ID ${process.pid}`,
      );
    expect(mine()).toBe(true);
    k.stop();
    expect(k.state).toBe("off");
    await new Promise((r) => setTimeout(r, 300));
    expect(mine()).toBe(false);
  });
});

describe("daemon keepAwake option", () => {
  it("is off unless asked, and /status reports it", async () => {
    const d = await startDaemon({ port: 0, dataDir: await tmp() });
    try {
      expect(d.keepAwake).toBeNull();
      const s = await (await fetch(`http://127.0.0.1:${d.port}/status`)).json();
      expect(s.keepAwake).toBe("off");
      expect(s.features).toContain("keep-awake");
    } finally {
      await d.close();
    }
  });
});

async function tmp(): Promise<string> {
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  return mkdtemp(join(tmpdir(), "airemo-ka-"));
}
