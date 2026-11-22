import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { claudeCodePlugin, describeToolInput, permissionHookPath } from "./index.js";

describe("claude-code plugin", () => {
  it("launches claude with the Airemo permission hook", () => {
    const spec = claudeCodePlugin.launch({ cwd: "/tmp/p", args: ["--foo"] });
    expect(spec).toMatchObject({ command: "claude", cwd: "/tmp/p" });
    expect(spec.args[0]).toBe("--settings");
    expect(spec.args.at(-1)).toBe("--foo");
    const settings = JSON.parse(spec.args[1] as string);
    const handler = settings.hooks.PermissionRequest[0].hooks[0];
    expect(handler.type).toBe("command");
    expect(handler.args).toEqual([permissionHookPath]);
    expect(existsSync(permissionHookPath)).toBe(true);
  });

  it("forces the ask-first permission mode when approval is required", () => {
    const gated = claudeCodePlugin.launch({ cwd: "/p", requireApproval: true });
    expect(gated.args).toContain("--permission-mode");
    expect(gated.args[gated.args.indexOf("--permission-mode") + 1]).toBe("default");
    const open = claudeCodePlugin.launch({ cwd: "/p" });
    expect(open.args).not.toContain("--permission-mode");
    const explicit = claudeCodePlugin.launch({
      cwd: "/p",
      requireApproval: true,
      args: ["--permission-mode", "plan"],
    });
    expect(explicit.args.filter((a) => a === "--permission-mode")).toHaveLength(1);
  });

  it("uses the classic renderer so the phone can scroll without scrolling the computer", () => {
    process.env.CLAUDE_CODE_NO_FLICKER = "1"; // a user's own preference must not win here
    try {
      expect(claudeCodePlugin.launch({ cwd: "/p" }).env.CLAUDE_CODE_NO_FLICKER).toBe("0");
    } finally {
      delete process.env.CLAUDE_CODE_NO_FLICKER;
    }
  });

  it("resumes with --resume, last, with or without a conversation id", () => {
    const picker = claudeCodePlugin.launch({ cwd: "/p", requireApproval: true, resume: {} });
    expect(picker.args.at(-1)).toBe("--resume");
    expect(picker.args).toContain("--permission-mode"); // still gated
    const one = claudeCodePlugin.launch({ cwd: "/p", resume: { id: "abc-123" } });
    expect(one.args.slice(-2)).toEqual(["--resume", "abc-123"]);
    expect(claudeCodePlugin.launch({ cwd: "/p" }).args).not.toContain("--resume");
  });

  it("describes the exact action", () => {
    expect(describeToolInput("Bash", { command: "rm -rf node_modules" })).toBe(
      "rm -rf node_modules",
    );
    expect(describeToolInput("Edit", { file_path: "/a/b.ts", old_string: "x" })).toBe(
      "Edit: /a/b.ts",
    );
    expect(describeToolInput("WebFetch", { url: "https://x" })).toBe(
      'WebFetch: {"url":"https://x"}',
    );
  });
});
