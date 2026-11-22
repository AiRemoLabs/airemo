import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentPlugin, type LaunchOptions, PluginRegistry } from "@airemo/plugin-sdk";
import { createMessage, parseMessage } from "@airemo/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Daemon, startDaemon } from "./server.js";

const until = async (cond: () => boolean, ms = 4000) => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe("plugin prepare and cleanup", () => {
  let daemon: Daemon;
  const prepared: LaunchOptions[] = [];
  let cleaned = 0;
  let launched = 0;
  let mode: "ok" | "prepare-fails" | "launch-throws" | "launch-dies" = "ok";
  let command = "cat";

  const plugin: AgentPlugin = {
    id: "prep",
    displayName: "Prep",
    capabilities: { structuredOutput: false, permissionHooks: true, pauseResume: false },
    detect: async () => ({ installed: true }),
    prepare: async (opts) => {
      if (mode === "prepare-fails") throw new Error("hooks.json is not valid JSON");
      prepared.push(opts);
      return () => {
        cleaned++;
      };
    },
    launch: ({ cwd }) => {
      launched++;
      if (mode === "launch-throws") throw new Error("cannot build launch spec");
      return {
        command: mode === "launch-dies" ? "/definitely/not/a/command" : command,
        args: [],
        env: process.env as Record<string, string>,
        cwd,
      };
    },
    parseOutput: () => [],
    respondToPermission: () => null,
  };

  beforeAll(async () => {
    daemon = await startDaemon({
      port: 0,
      dataDir: mkdtempSync(join(tmpdir(), "airemo-prep-")),
      registry: new PluginRegistry().register(plugin),
    });
  });
  afterAll(() => daemon.close());

  const reset = () => {
    prepared.length = 0;
    cleaned = 0;
    launched = 0;
    mode = "ok";
    command = "cat";
  };

  it("prepares before launching, with the session's folder and the approval setting", async () => {
    reset();
    const s = await daemon.sessions.start("prep", process.cwd());
    expect(prepared).toHaveLength(1);
    expect(prepared[0]).toMatchObject({ cwd: process.cwd(), requireApproval: true });
    expect(prepared[0]?.env?.AIREMO_SESSION_ID).toBe(s.id); // the hook can find its session
    expect(launched).toBe(1);
    expect(cleaned).toBe(0);
    s.stop();
    await until(() => cleaned === 1);
  });

  it("runs the cleanup exactly once when the agent exits by itself", async () => {
    reset();
    command = "true";
    await daemon.sessions.start("prep", process.cwd());
    await until(() => cleaned === 1);
    await new Promise((r) => setTimeout(r, 200));
    expect(cleaned).toBe(1);
  });

  it("does not start the session if prepare fails, and says why", async () => {
    reset();
    mode = "prepare-fails";
    const before = daemon.sessions.list().length;
    await expect(daemon.sessions.start("prep", process.cwd())).rejects.toThrow(/not valid JSON/);
    expect(launched).toBe(0);
    expect(daemon.sessions.list().length).toBe(before);
  });

  it("cleans up if building the launch spec fails after prepare succeeded", async () => {
    reset();
    mode = "launch-throws";
    await expect(daemon.sessions.start("prep", process.cwd())).rejects.toThrow(
      /cannot build launch spec/,
    );
    expect(cleaned).toBe(1);
  });

  it("cleans up when the agent dies right at startup (for example a missing command)", async () => {
    reset();
    mode = "launch-dies";
    await daemon.sessions.start("prep", process.cwd());
    await until(() => cleaned === 1);
  });

  it("tells a remote or local client why it could not start", async () => {
    reset();
    mode = "prepare-fails";
    const ws = new WebSocket(`ws://127.0.0.1:${daemon.port}/ws`);
    const got = new Promise<string>((resolve) => {
      ws.onmessage = (ev) => {
        const m = parseMessage(JSON.parse(String(ev.data)));
        if (m.type === "error") resolve(m.payload.message);
      };
    });
    await new Promise<void>((r) => {
      ws.onopen = () => r();
    });
    ws.send(JSON.stringify(createMessage("session.start", { agent: "prep", cwd: process.cwd() })));
    expect(await got).toMatch(/not valid JSON/);
    ws.close();
  });

  it("dispose() runs cleanups that are still pending (daemon shutdown)", async () => {
    reset();
    await daemon.sessions.start("prep", process.cwd());
    await daemon.sessions.start("prep", process.cwd());
    expect(cleaned).toBe(0);
    daemon.sessions.dispose();
    expect(cleaned).toBe(2);
    daemon.sessions.dispose(); // idempotent
    expect(cleaned).toBe(2);
    for (const s of daemon.sessions.list()) s.stop();
    await new Promise((r) => setTimeout(r, 300));
    expect(cleaned).toBe(2); // the exit event does not run them a second time
  });
});
