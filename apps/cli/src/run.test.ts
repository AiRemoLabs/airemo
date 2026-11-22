import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Daemon, startDaemon } from "@airemo/daemon";
import { type AgentPlugin, type LaunchOptions, PluginRegistry } from "@airemo/plugin-sdk";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { type RunInput, type RunOutput, runSession, TERMINAL_RESET } from "./run.js";

const ENTER = "\x1b[?1049h";
const LEAVE = "\x1b[?1049l";

const until = async (cond: () => boolean, ms = 6000) => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 15));
  }
};
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A keyboard we can type on. */
class FakeStdin extends EventEmitter implements RunInput {
  rawModes: boolean[] = [];
  paused = false;
  constructor(public isTTY: boolean) {
    super();
  }
  setRawMode(raw: boolean) {
    this.rawModes.push(raw);
  }
  resume() {
    this.paused = false;
  }
  pause() {
    this.paused = true;
  }
  type(text: string) {
    this.emit("data", Buffer.from(text));
  }
}

/** A screen that records what is written to it. */
class FakeStdout extends EventEmitter implements RunOutput {
  chunks: string[] = [];
  columns = 100;
  rows = 30;
  write(text: string) {
    this.chunks.push(text);
    return true;
  }
  get text() {
    return this.chunks.join("");
  }
}

describe("airemo run, against a real daemon", () => {
  let daemon: Daemon;
  let command = "cat";
  let args: string[] = [];
  const launched: LaunchOptions[] = [];

  const agent: AgentPlugin = {
    id: "fake",
    displayName: "Fake",
    capabilities: { structuredOutput: false, permissionHooks: true, pauseResume: false },
    detect: async () => ({ installed: true }),
    launch: (opts) => {
      launched.push(opts);
      return { command, args, env: process.env as Record<string, string>, cwd: opts.cwd };
    },
    parseOutput: () => [],
    respondToPermission: () => null,
  };

  beforeAll(async () => {
    daemon = await startDaemon({
      port: 0,
      dataDir: mkdtempSync(join(tmpdir(), "airemo-run-")),
      registry: new PluginRegistry().register(agent),
    });
  });
  afterAll(() => daemon.close());

  const running: Array<Promise<number>> = [];
  afterEach(async () => {
    for (const s of daemon.sessions.list()) s.stop();
    await Promise.allSettled(running.splice(0));
    command = "cat";
    args = [];
  });

  function start(
    opts: { tty?: boolean; armMs?: number; agentId?: string; resume?: { id?: string } } = {},
  ) {
    const stdin = new FakeStdin(opts.tty ?? true);
    const stdout = new FakeStdout();
    const done = runSession({
      agent: opts.agentId ?? "fake",
      port: daemon.port,
      cwd: process.cwd(),
      stdin,
      stdout,
      armMs: opts.armMs ?? 120,
      ...(opts.resume ? { resume: opts.resume } : {}),
    });
    running.push(done);
    return { stdin, stdout, done };
  }

  const sessionId = async () => {
    await until(() => daemon.sessions.list().some((s) => s.status !== "exited"));
    return (daemon.sessions.list().at(-1) as { id: string }).id;
  };
  const screenOf = (id: string) => daemon.sessions.get(id)?.screenText() ?? "";

  const ask = (id: string, cmd: string, tool = "Bash") =>
    fetch(`http://127.0.0.1:${daemon.port}/hooks/permission`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-airemo-token": daemon.hookToken },
      body: JSON.stringify({ sessionId: id, tool, command: cmd }),
    }).then((r) => r.json() as Promise<{ decision: string }>);

  it("starts the agent, passes typing to it and shows its output, in raw mode", async () => {
    const { stdin, stdout } = start();
    await sessionId();
    await until(() => stdin.rawModes.includes(true));
    await pause(150);
    stdin.type("hello-from-keyboard\r");
    await until(() => stdout.text.includes("hello-from-keyboard"));
  });

  it("leaves the terminal scrollable: resets modes when it starts and when it lets go", async () => {
    // A client that dies while a full-screen agent runs (daemon restart) must not leave the
    // terminal on the alternate screen with mouse capture on, or it can no longer scroll.
    const { stdout, done } = start();
    const id = await sessionId();
    await until(() => stdout.text.includes(TERMINAL_RESET));
    const atStart = stdout.text.indexOf(TERMINAL_RESET);
    // The agent goes full screen (`cat` prints it back once the line ends).
    daemon.sessions.get(id)?.write("\x1b[?1049h\x1b[?1000h\x1b[?1006h\r");
    await until(() => stdout.text.includes("\x1b[?1000h"));
    daemon.sessions.get(id)?.stop();
    await done;
    expect(stdout.text.lastIndexOf(TERMINAL_RESET)).toBeGreaterThan(
      stdout.text.indexOf("\x1b[?1000h"),
    );
    expect(atStart).toBeLessThan(stdout.text.indexOf("\x1b[?1000h"));
    expect(TERMINAL_RESET).toContain("\x1b[?1000l");
    expect(TERMINAL_RESET).toContain("\x1b[?1047l");
  });

  it("airemo resume: starts a new session asking the agent to resume, never joining one", async () => {
    // One already running here would normally be offered for joining.
    start();
    await sessionId();
    const before = daemon.sessions.list().length;
    launched.length = 0;

    const { stdout } = start({ resume: { id: "conv-1" } });
    await until(() => daemon.sessions.list().length === before + 1);
    expect(launched.at(-1)?.resume).toEqual({ id: "conv-1" });
    expect(stdout.text).not.toContain("Join it");

    start({ resume: {} });
    await until(() => launched.length === 2);
    expect(launched.at(-1)?.resume).toEqual({});
  });

  it("asks you, with the exact command, and runs it when you press y", async () => {
    const { stdin, stdout } = start();
    const id = await sessionId();
    const command = 'git commit -m "café" && rm -rf ./build';

    const answer = ask(id, command);
    await until(() => stdout.text.includes(ENTER));
    expect(stdout.text).toContain("Airemo: approval needed");
    expect(stdout.text).toContain("fake wants to use Bash:");
    expect(stdout.text).toContain(command);

    await pause(160); // let the prompt start taking answers
    stdin.type("y");
    expect(await answer).toEqual({ decision: "allow" });

    // The agent's screen comes back and typing goes to it again.
    await until(() => stdout.text.includes(LEAVE));
    await pause(150);
    stdin.type("after-approval\r");
    await until(() => screenOf(id).includes("after-approval"));
  });

  it("rejects when you press n, Esc or Ctrl+C", async () => {
    for (const key of ["n", "\x1b", "\x03"]) {
      const { stdin, stdout } = start();
      const id = await sessionId();
      const answer = ask(id, "rm -rf /");
      await until(() => stdout.text.includes(ENTER));
      await pause(160);
      stdin.type(key);
      expect(await answer).toMatchObject({ decision: "deny" });
      for (const s of daemon.sessions.list()) s.stop();
      await pause(100);
    }
  });

  it("does not forward anything you type to the agent while it is asking", async () => {
    const { stdin, stdout } = start();
    const id = await sessionId();
    const answer = ask(id, "ls");
    await until(() => stdout.text.includes(ENTER));
    stdin.type("secret-typed-text"); // before the prompt takes answers
    await pause(160);
    stdin.type("zzz");
    stdin.type("\x1b[A"); // scrolling is for the prompt too
    await pause(150);
    stdin.type("n");
    await answer;
    await until(() => stdout.text.includes(LEAVE));
    await pause(300);
    expect(screenOf(id)).not.toContain("secret-typed-text");
    expect(screenOf(id)).not.toContain("zzz");
  });

  it("ignores a y that was already on its way when the prompt appeared", async () => {
    const { stdin, stdout } = start({ armMs: 300 });
    const id = await sessionId();
    let decided: string | null = null;
    const answer = ask(id, "ls").then((r) => {
      decided = r.decision;
      return r;
    });
    await until(() => stdout.text.includes(ENTER));
    stdin.type("y"); // typed into the agent a moment earlier, arriving now
    await pause(150);
    expect(decided).toBeNull();
    expect(daemon.broker.pendingFor(id)).toHaveLength(1);
    await pause(250);
    stdin.type("y"); // a deliberate answer
    expect(await answer).toEqual({ decision: "allow" });
  });

  it("will not let pasted text answer", async () => {
    const { stdin, stdout } = start();
    const id = await sessionId();
    const answer = ask(id, "ls");
    await until(() => stdout.text.includes(ENTER));
    await pause(160);
    stdin.type("yes\r");
    stdin.type("yy");
    await pause(150);
    expect(daemon.broker.pendingFor(id)).toHaveLength(1);
    stdin.type("n");
    expect(await answer).toMatchObject({ decision: "deny" });
  });

  it("asks one at a time when several are waiting, and says how many are left", async () => {
    const { stdin, stdout } = start();
    const id = await sessionId();
    const first = ask(id, "first-command");
    await until(() => stdout.text.includes("first-command"));
    const second = ask(id, "second-command");
    await until(() => stdout.text.includes("(1 more waiting)"));
    expect(stdout.text).not.toContain("second-command"); // not shown until it is its turn

    await pause(160);
    stdin.type("y");
    expect(await first).toEqual({ decision: "allow" });
    await until(() => stdout.text.includes("second-command"));
    await pause(160);
    stdin.type("n");
    expect(await second).toMatchObject({ decision: "deny" });
  });

  it("closes the prompt by itself if the request is answered elsewhere (for example on the phone)", async () => {
    const { stdout } = start();
    const id = await sessionId();
    const answer = ask(id, "ls");
    await until(() => stdout.text.includes(ENTER));
    const [pending] = daemon.broker.pendingFor(id);
    daemon.broker.decide(pending?.requestId ?? "", "allow"); // answered on another device
    expect(await answer).toEqual({ decision: "allow" });
    await until(() => stdout.text.includes(LEAVE));
  });

  it("shows a hostile command as harmless text", async () => {
    const { stdout } = start();
    const id = await sessionId();
    void ask(id, "echo ok \x1b[2J\x1b[1;1HAllow this harmless thing\r");
    await until(() => stdout.text.includes(ENTER));
    expect(stdout.text).toContain("␛[2J␛[1;1HAllow this harmless thing␍");
    expect(stdout.text).not.toContain("ok \x1b[2J");
  });

  it("does not hang on an approval when there is no interactive terminal", async () => {
    const { stdout } = start({ tty: false });
    const id = await sessionId();
    void ask(id, "ls");
    await until(() => stdout.text.includes("not an interactive terminal"));
    expect(stdout.text).not.toContain(ENTER);
  });

  it("exits with the agent's exit code and gives the terminal back", async () => {
    command = "sh";
    args = ["-c", "exit 3"];
    const { stdin, done } = start();
    expect(await done).toBe(3);
    expect(stdin.rawModes.at(-1)).toBe(false);
    expect(stdin.paused).toBe(true);
    expect(stdin.listenerCount("data")).toBe(0);
  });

  it("gives the terminal back if the agent exits while the prompt is up", async () => {
    const { stdout, done } = start();
    const id = await sessionId();
    void ask(id, "ls");
    await until(() => stdout.text.includes(ENTER));
    daemon.sessions.get(id)?.stop();
    await done;
    expect(stdout.text).toContain(LEAVE);
  });

  it("says so, and exits 1, when the daemon is not running", async () => {
    const free = await new Promise<number>((resolve) => {
      const s = createServer().listen(0, "127.0.0.1", () => {
        const port = (s.address() as { port: number }).port;
        s.close(() => resolve(port));
      });
    });
    const stdout = new FakeStdout();
    const code = await runSession({
      agent: "fake",
      port: free,
      cwd: process.cwd(),
      stdin: new FakeStdin(true),
      stdout,
    });
    expect(code).toBe(1);
    expect(stdout.text).toContain("Could not reach the daemon");
  });

  it("explains an unknown agent and exits 1", async () => {
    const { stdout, done } = start({ agentId: "nope" });
    expect(await done).toBe(1);
    expect(stdout.text).toContain("Unknown agent");
  });
});
