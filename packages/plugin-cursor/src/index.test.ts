import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { classify, READ_ONLY_TOOLS } from "../hook/decide.mjs";
import { describeCursorTool } from "../hook/describe.mjs";
import { approvalHookPath, cursorPlugin, HOOK_MARKER, installApprovalHook } from "./index.js";

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "airemo-cursor-")));
const HOOK = "/opt/airemo/hook/airemo-approval-hook.mjs";
const read = (p: string) => JSON.parse(readFileSync(p, "utf8"));

describe("cursor plugin", () => {
  it("launches the agent in a trusted workspace without any force flag", () => {
    const spec = cursorPlugin.launch({ cwd: "/work/app", args: ["--model", "auto"] });
    expect(spec).toMatchObject({ command: "cursor-agent", cwd: "/work/app" });
    expect(spec.args).toEqual(["--trust", "--model", "auto"]);
    expect(spec.args).not.toContain("--force");
    expect(spec.args).not.toContain("--yolo");
  });

  it("resumes with --resume, with or without a chat id", () => {
    expect(cursorPlugin.launch({ cwd: "/w", resume: {} }).args).toEqual(["--trust", "--resume"]);
    expect(cursorPlugin.launch({ cwd: "/w", resume: { id: "c1" } }).args).toEqual([
      "--trust",
      "--resume",
      "c1",
    ]);
  });

  it("installs the hook only when approval is required, and removes it again", async () => {
    const dir = tmp();
    expect(await cursorPlugin.prepare?.({ cwd: dir })).toBeUndefined();
    expect(existsSync(join(dir, ".cursor"))).toBe(false);

    const cleanup = await cursorPlugin.prepare?.({ cwd: dir, requireApproval: true });
    expect(read(join(dir, ".cursor/hooks.json")).hooks.preToolUse[0].command).toContain(
      approvalHookPath,
    );
    cleanup?.();
    expect(existsSync(join(dir, ".cursor"))).toBe(false);
  });

  it("declares approvals, and ships the hook script", () => {
    expect(cursorPlugin.capabilities.permissionHooks).toBe(true);
    expect(existsSync(approvalHookPath)).toBe(true);
    expect(approvalHookPath.endsWith(HOOK_MARKER)).toBe(true);
  });
});

describe("classify: what may run without asking", () => {
  const root = tmp();
  const outside = tmp();
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src/a.ts"), "x");
  writeFileSync(join(outside, "secret.txt"), "s");
  symlinkSync(outside, join(root, "link-out")); // inside the project, points outside it
  const sibling = `${root}-evil`;
  mkdirSync(sibling);
  const roots = [root];

  it("asks for everything that is not read-only, including unknown tools", () => {
    for (const tool of [
      "Shell",
      "Write",
      "Delete",
      "WebFetch",
      "WebSearch",
      "Task",
      "EditNotebook",
      "mcp__server__tool",
      "SomethingNew",
      "",
    ]) {
      expect(classify(tool, { file_path: join(root, "src/a.ts") }, roots)).toBe("ask");
    }
  });

  it("allows read-only tools inside the workspace", () => {
    expect([...READ_ONLY_TOOLS]).toContain("Read");
    expect(classify("Read", { file_path: join(root, "src/a.ts") }, roots)).toBe("allow");
    expect(classify("Grep", { pattern: "x", file_path: root }, roots)).toBe("allow");
    expect(classify("Read", { file_path: "src/a.ts" }, roots, root)).toBe("allow"); // relative
    expect(classify("Read", { file_path: join(root, "src/new.ts") }, roots)).toBe("allow"); // not there yet
    expect(classify("Glob", { glob_pattern: "**/*.ts", target_directory: root }, roots)).toBe(
      "allow",
    );
    expect(classify("Grep", { pattern: "x" }, roots)).toBe("allow"); // no path given
  });

  it("asks before reading outside the workspace", () => {
    expect(classify("Read", { file_path: join(outside, "secret.txt") }, roots)).toBe("ask");
    expect(classify("Read", { file_path: "/etc/passwd" }, roots)).toBe("ask");
    expect(classify("Grep", { pattern: "x", file_path: outside }, roots)).toBe("ask");
    expect(classify("Read", { file_path: join(sibling, "x") }, roots)).toBe("ask"); // shares the prefix
    expect(classify("Read", { file_path: join(root, "src", "..", "..", "x") }, roots)).toBe("ask");
    expect(classify("Read", { file_path: "../x" }, roots, root)).toBe("ask");
  });

  it("is not fooled by a symlink that points out of the project", () => {
    expect(classify("Read", { file_path: join(root, "link-out", "secret.txt") }, roots)).toBe(
      "ask",
    );
    expect(classify("Read", { file_path: join(root, "link-out", "not-yet.txt") }, roots)).toBe(
      "ask",
    );
  });

  it("asks when a glob escapes the workspace", () => {
    expect(classify("Glob", { glob_pattern: "../**/*.env" }, roots)).toBe("ask");
    expect(classify("Glob", { glob_pattern: `${outside}/**` }, roots)).toBe("ask");
    expect(classify("Glob", { glob_pattern: `${root}/src/**` }, roots)).toBe("allow");
  });

  it("asks when it cannot tell where the workspace is", () => {
    expect(classify("Read", { file_path: join(root, "src/a.ts") }, [])).toBe("ask");
    expect(classify("Read", { file_path: join(root, "src/a.ts") }, undefined)).toBe("ask");
  });

  it("copes with odd input", () => {
    expect(classify("Read", null, roots)).toBe("allow");
    expect(classify("Read", "text", roots)).toBe("allow");
    expect(classify("Read", { file_path: 42 }, roots)).toBe("allow");
  });
});

describe("describeCursorTool: what the user sees", () => {
  it("shows a shell command exactly, however long", () => {
    const cmd = `git commit -m "fix: é" && rm -rf ./build\n# ${"x".repeat(50000)}`;
    expect(describeCursorTool("Shell", { command: cmd, cwd: "/p" })).toBe(cmd);
  });

  it("shows the file and content for a write, and says when content is cut", () => {
    const small = describeCursorTool("Write", { file_path: "/p/a.txt", content: "hello" });
    expect(small).toContain("Write /p/a.txt (5 characters)");
    expect(small).toContain("hello");
    const big = describeCursorTool("Write", { file_path: "/p/b.txt", content: "y".repeat(20000) });
    expect(big).toContain("20000 characters");
    expect(big).toContain("more characters not shown");
  });

  it("describes deletes, simple reads and other tools", () => {
    expect(describeCursorTool("Delete", { file_path: "/p/a.txt" })).toBe("Delete /p/a.txt");
    expect(describeCursorTool("Read", { file_path: "/etc/passwd" })).toBe("Read /etc/passwd");
    expect(describeCursorTool("WebFetch", { url: "https://x.example" })).toBe(
      'WebFetch: {"url":"https://x.example"}',
    );
    expect(describeCursorTool("Mystery", null)).toBe("Mystery: null");
  });
});

describe("installApprovalHook", () => {
  const project = () => {
    const dir = tmp();
    return { dir, file: join(dir, ".cursor/hooks.json") };
  };

  it("creates the file when there is none, and removes it (and the folder) afterwards", () => {
    const { dir, file } = project();
    const cleanup = installApprovalHook(dir, { hookPath: HOOK, nodePath: "/usr/bin/node" });
    const json = read(file);
    expect(json.version).toBe(1);
    expect(json.hooks.preToolUse).toEqual([
      { command: `"/usr/bin/node" "${HOOK}"`, timeout: 600, failClosed: true },
    ]);
    cleanup();
    expect(existsSync(file)).toBe(false);
    expect(existsSync(join(dir, ".cursor"))).toBe(false);
  });

  it("keeps the user's own hooks and settings, and restores the file byte for byte", () => {
    const { dir, file } = project();
    mkdirSync(join(dir, ".cursor"));
    const original = `{\n    "version": 1,\n  "hooks": {"afterFileEdit": [{"command": "./fmt.sh"}], "preToolUse": [{"command": "./mine.sh", "matcher": "Shell"}]},\n  "custom": true\n}\n`;
    writeFileSync(file, original);

    const cleanup = installApprovalHook(dir, { hookPath: HOOK });
    const json = read(file);
    expect(json.custom).toBe(true);
    expect(json.hooks.afterFileEdit).toEqual([{ command: "./fmt.sh" }]);
    expect(json.hooks.preToolUse).toHaveLength(2);
    expect(json.hooks.preToolUse[0]).toEqual({ command: "./mine.sh", matcher: "Shell" });

    cleanup();
    expect(readFileSync(file, "utf8")).toBe(original);
  });

  it("is shared between sessions in the same folder", () => {
    const { dir, file } = project();
    const a = installApprovalHook(dir, { hookPath: HOOK });
    const b = installApprovalHook(dir, { hookPath: HOOK });
    expect(read(file).hooks.preToolUse).toHaveLength(1);
    a();
    a(); // running a cleanup twice must not release the other session's hold
    expect(existsSync(file)).toBe(true);
    b();
    expect(existsSync(file)).toBe(false);
  });

  it("replaces a stale entry left by a crashed session instead of adding another", () => {
    const { dir, file } = project();
    mkdirSync(join(dir, ".cursor"));
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        hooks: {
          preToolUse: [{ command: `node /old/path/${HOOK_MARKER}` }, { command: "./mine.sh" }],
        },
      }),
    );
    const cleanup = installApprovalHook(dir, { hookPath: HOOK });
    const pre = read(file).hooks.preToolUse;
    expect(pre).toHaveLength(2);
    expect(pre.filter((e: { command: string }) => e.command.includes(HOOK_MARKER))).toHaveLength(1);
    expect(pre.some((e: { command: string }) => e.command.includes("/old/path"))).toBe(false);
    cleanup();
  });

  it("refuses, without touching the file, when it cannot understand the existing one", () => {
    for (const bad of [
      "{ not json",
      "[]",
      "null",
      '{"hooks": []}',
      '{"hooks": {"preToolUse": {}}}',
      '"text"',
    ]) {
      const { dir, file } = project();
      mkdirSync(join(dir, ".cursor"));
      writeFileSync(file, bad);
      expect(() => installApprovalHook(dir, { hookPath: HOOK })).toThrow(
        /cannot add its approval hook/,
      );
      expect(readFileSync(file, "utf8")).toBe(bad);
    }
  });

  it("removes only its own entry if the file was edited while the session ran", () => {
    const { dir, file } = project();
    const cleanup = installApprovalHook(dir, { hookPath: HOOK });
    const json = read(file);
    json.hooks.stop = [{ command: "./added-later.sh" }];
    writeFileSync(file, JSON.stringify(json));
    cleanup();
    const after = read(file);
    expect(after.hooks.stop).toEqual([{ command: "./added-later.sh" }]);
    expect(after.hooks.preToolUse).toBeUndefined();
  });

  it("quotes paths with spaces and shell characters", () => {
    const { dir, file } = project();
    const cleanup = installApprovalHook(dir, {
      hookPath: '/opt/my "dir"/$HOME/hook.mjs',
      nodePath: "/usr/local/my node",
    });
    expect(read(file).hooks.preToolUse[0].command).toBe(
      '"/usr/local/my node" "/opt/my \\"dir\\"/\\$HOME/hook.mjs"',
    );
    cleanup();
  });

  describe("in a git repository", () => {
    const repo = () => {
      const dir = tmp();
      execFileSync("git", ["init", "-q"], { cwd: dir });
      return dir;
    };
    const excluded = (dir: string) =>
      readFileSync(join(dir, ".git/info/exclude"), "utf8")
        .split("\n")
        .includes("/.cursor/hooks.json");

    it("keeps the generated file out of git status, then removes the exclude line", () => {
      const dir = repo();
      const cleanup = installApprovalHook(dir, { hookPath: HOOK });
      expect(excluded(dir)).toBe(true);
      expect(
        execFileSync("git", ["status", "--porcelain", "-uall"], { cwd: dir, encoding: "utf8" }),
      ).not.toContain(".cursor");
      cleanup();
      expect(excluded(dir)).toBe(false);
    });

    it("does not remove an exclude line that was already there", () => {
      const dir = repo();
      writeFileSync(join(dir, ".git/info/exclude"), "# mine\n/.cursor/hooks.json\n");
      installApprovalHook(dir, { hookPath: HOOK })();
      expect(excluded(dir)).toBe(true);
    });

    it("leaves git alone when the project tracks its own hooks.json", () => {
      const dir = repo();
      mkdirSync(join(dir, ".cursor"));
      writeFileSync(join(dir, ".cursor/hooks.json"), '{"version":1,"hooks":{}}\n');
      execFileSync("git", ["add", ".cursor/hooks.json"], { cwd: dir });
      const cleanup = installApprovalHook(dir, { hookPath: HOOK });
      expect(excluded(dir)).toBe(false);
      cleanup();
      expect(readFileSync(join(dir, ".cursor/hooks.json"), "utf8")).toBe(
        '{"version":1,"hooks":{}}\n',
      );
    });
  });

  it("works outside git", () => {
    const { dir, file } = project();
    installApprovalHook(dir, { hookPath: HOOK })();
    expect(existsSync(file)).toBe(false);
  });
});

describe("the hook script, run for real", () => {
  let server: Server;
  let url: string;
  const requests: Array<{ token: string | undefined; body: Record<string, string> }> = [];
  let respond: () => { status: number; body: unknown } = () => ({
    status: 200,
    body: { decision: "allow" },
  });

  beforeAll(async () => {
    server = createServer((req, res) => {
      let data = "";
      req.on("data", (c) => {
        data += c;
      });
      req.on("end", () => {
        requests.push({
          token: req.headers["x-airemo-token"] as string | undefined,
          body: JSON.parse(data),
        });
        const r = respond();
        res.writeHead(r.status, { "content-type": "application/json" });
        res.end(JSON.stringify(r.body));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => server.close());

  const root = tmp();
  const run = (
    input: unknown,
    env: Record<string, string> | null = {
      AIREMO_DAEMON_URL: url,
      AIREMO_SESSION_ID: "sess-1",
      AIREMO_HOOK_TOKEN: "secret",
    },
  ) =>
    new Promise<{ out: unknown; code: number | null }>((resolve) => {
      const child = spawn(process.execPath, [approvalHookPath], {
        env: { PATH: process.env.PATH ?? "", ...(env ?? {}) },
      });
      let out = "";
      child.stdout.on("data", (c) => {
        out += c;
      });
      child.on("close", (code) => resolve({ out: out ? JSON.parse(out) : null, code }));
      child.stdin.end(typeof input === "string" ? input : JSON.stringify(input));
    });
  const call = (tool_name: string, tool_input: unknown) => ({
    tool_name,
    tool_input,
    workspace_roots: [root],
    cwd: root,
  });

  it("has no opinion outside an Airemo session (so a leftover config changes nothing)", async () => {
    const r = await run(call("Shell", { command: "ls" }), null);
    expect(r).toEqual({ out: {}, code: 0 });
  });

  it("lets read-only work inside the workspace through without asking", async () => {
    requests.length = 0;
    const r = await run(call("Read", { file_path: join(root, "a.txt") }));
    expect(r.out).toEqual({ permission: "allow" });
    expect(requests).toHaveLength(0);
  });

  it("asks the daemon, with the exact command, for a shell command, and obeys allow", async () => {
    requests.length = 0;
    respond = () => ({ status: 200, body: { decision: "allow" } });
    const command = 'rm -rf ./build && echo "é"';
    const r = await run(call("Shell", { command, cwd: root }));
    expect(r).toEqual({ out: { permission: "allow" }, code: 0 });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      token: "secret",
      body: { sessionId: "sess-1", tool: "Shell", command },
    });
  });

  it("obeys deny and tells the agent not to retry", async () => {
    respond = () => ({
      status: 200,
      body: { decision: "deny", message: "Denied by the user via Airemo" },
    });
    const r = await run(call("Write", { file_path: join(root, "x.txt"), content: "data" }));
    expect(r.code).toBe(0);
    expect(r.out).toMatchObject({
      permission: "deny",
      user_message: "Denied by the user via Airemo",
    });
    expect((r.out as { agent_message: string }).agent_message).toMatch(/Do not retry/);
    expect(requests.at(-1)?.body.command).toContain("Write ");
  });

  it("asks before reading outside the workspace", async () => {
    requests.length = 0;
    respond = () => ({ status: 200, body: { decision: "deny" } });
    const r = await run(call("Read", { file_path: "/etc/passwd" }));
    expect(requests).toHaveLength(1);
    expect(requests[0]?.body.command).toBe("Read /etc/passwd");
    expect((r.out as { permission: string }).permission).toBe("deny");
  });

  it("denies when the daemon errors, is unreachable, or the input is bad", async () => {
    respond = () => ({ status: 500, body: {} });
    expect((await run(call("Shell", { command: "ls" }))).out).toMatchObject({ permission: "deny" });
    respond = () => ({ status: 200, body: { nonsense: true } });
    expect((await run(call("Shell", { command: "ls" }))).out).toMatchObject({ permission: "deny" });

    const down = await run(call("Shell", { command: "ls" }), {
      AIREMO_DAEMON_URL: "http://127.0.0.1:9",
      AIREMO_SESSION_ID: "s",
      AIREMO_HOOK_TOKEN: "t",
    });
    expect(down.out).toMatchObject({ permission: "deny" });
    expect(down.code).toBe(0);

    expect((await run("{ not json")).out).toMatchObject({ permission: "deny" });
    expect((await run({ tool_input: {} })).out).toMatchObject({ permission: "deny" });
    expect((await run("")).out).toMatchObject({ permission: "deny" });
  });

  it("treats an unknown tool as needing approval", async () => {
    requests.length = 0;
    respond = () => ({ status: 200, body: { decision: "allow" } });
    await run(call("BrandNewTool", { anything: 1 }));
    expect(requests).toHaveLength(1);
    expect(requests[0]?.body.command).toBe('BrandNewTool: {"anything":1}');
  });
});
