import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AfterAllowContext, type AgentPlugin, PluginRegistry } from "@airemo/plugin-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Daemon, startDaemon } from "./server.js";

const until = async (cond: () => boolean, ms = 4000) => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe("afterAllow", () => {
  let daemon: Daemon;
  const calls: Array<
    Pick<AfterAllowContext, "sessionId" | "tool" | "command"> & { screenWas: string }
  > = [];
  let throws = false;

  const plugin: AgentPlugin = {
    id: "aa",
    displayName: "AA",
    capabilities: { structuredOutput: false, permissionHooks: true, pauseResume: false },
    detect: async () => ({ installed: true }),
    launch: ({ cwd }) => ({
      command: "cat",
      args: [],
      env: process.env as Record<string, string>,
      cwd,
    }),
    parseOutput: () => [],
    respondToPermission: () => null,
    afterAllow: async (ctx) => {
      calls.push({
        sessionId: ctx.sessionId,
        tool: ctx.tool,
        command: ctx.command,
        screenWas: ctx.screen(),
      });
      if (throws) throw new Error("plugin bug");
      ctx.write("typed-by-plugin\r"); // `cat` echoes it back onto the screen
    },
  };

  beforeAll(async () => {
    daemon = await startDaemon({
      port: 0,
      dataDir: mkdtempSync(join(tmpdir(), "airemo-aa-")),
      registry: new PluginRegistry().register(plugin),
    });
  });
  afterAll(() => daemon.close());

  const session = async () => daemon.sessions.start("aa", process.cwd());
  const ask = (sessionId: string, command: string) =>
    fetch(`http://127.0.0.1:${daemon.port}/hooks/permission`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-airemo-token": daemon.hookToken },
      body: JSON.stringify({ sessionId, tool: "Shell", command }),
    });
  const pending = (sessionId: string) => daemon.broker.pendingFor(sessionId)[0];

  it("runs after the user allows, with the exact command, a readable screen and the ability to type", async () => {
    calls.length = 0;
    throws = false;
    const s = await session();
    s.write("before\r");
    await until(() => s.screenText().includes("before"));

    const answer = ask(s.id, 'git commit -m "x"');
    await until(() => !!pending(s.id));
    daemon.broker.decide(pending(s.id)?.requestId ?? "", "allow");
    expect(await (await answer).json()).toMatchObject({ decision: "allow" });

    await until(() => calls.length === 1);
    expect(calls[0]).toMatchObject({
      sessionId: s.id,
      tool: "Shell",
      command: 'git commit -m "x"',
    });
    expect(calls[0]?.screenWas).toContain("before");
    await until(() => s.screenText().includes("typed-by-plugin"));
    s.stop();
  });

  it("does not run when the user denies", async () => {
    calls.length = 0;
    const s = await session();
    const answer = ask(s.id, "rm -rf /");
    await until(() => !!pending(s.id));
    daemon.broker.decide(pending(s.id)?.requestId ?? "", "deny");
    await answer;
    await new Promise((r) => setTimeout(r, 300));
    expect(calls).toHaveLength(0);
    s.stop();
  });

  it("does not run when the request times out or the session ends", async () => {
    calls.length = 0;
    const s = await session();
    const answer = ask(s.id, "sleep 100");
    await until(() => !!pending(s.id));
    s.stop(); // session ends: pending requests are denied, not allowed
    await answer;
    await new Promise((r) => setTimeout(r, 300));
    expect(calls).toHaveLength(0);
  });

  it("survives a plugin that throws", async () => {
    calls.length = 0;
    throws = true;
    const s = await session();
    const answer = ask(s.id, "ls");
    await until(() => !!pending(s.id));
    daemon.broker.decide(pending(s.id)?.requestId ?? "", "allow");
    expect(await (await answer).json()).toMatchObject({ decision: "allow" });
    await until(() => calls.length === 1);
    expect(daemon.sessions.get(s.id)).toBeTruthy(); // daemon still fine
    throws = false;
    s.stop();
  });
});
