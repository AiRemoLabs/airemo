import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cursorPlugin, hasShellPromptFor } from "./index.js";

// A real screen captured from the Cursor TUI (cursor-agent 2026.11.05) while it asked to run
// `echo hi > marker.txt`.
const REAL_SCREEN: string =
  "\n\n  Cursor Agent\n  v2026.11.05-86047df\n  Tip: Use /plan to iterate on an implementation plan before code changes.\n\n                                                                                                             \n  Run this exact shell command and nothing else: echo hi > marker.txt                                        \n                                                                                                             \n\n  Running that exact command now.\n\n  $ echo hi > marker.txt Waiting for approval...\n\n\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n $  echo hi > marker.txt in .\n\n Run this command?\n Not in allowlist: echo\n  \u2192 Run (once) (y)\n    Add Shell(echo) to allowlist? (tab)\n    Run Everything (shift+tab)\n    Skip & tell the agent what to do instead (esc or n)\n\n\n\n\n\n\n\n\n\n\n\n\n";

describe("hasShellPromptFor", () => {
  it("recognises Cursor's prompt for the command the user approved (real screen)", () => {
    expect(hasShellPromptFor(REAL_SCREEN, "echo hi > marker.txt")).toBe(true);
  });

  it("ignores whitespace differences between the approved and the displayed command", () => {
    expect(hasShellPromptFor(REAL_SCREEN, "echo   hi  >\n marker.txt")).toBe(true);
  });

  it("matches a long command that the screen cuts short, but not one that merely starts the same", () => {
    const long = "npm run build && npm test -- --coverage --reporter=verbose && echo finished";
    // The TUI shows only the beginning of a long command.
    const screen = REAL_SCREEN.replace(
      "echo hi > marker.txt in .",
      `${long.slice(0, 55)}\u2026 in .`,
    );
    expect(hasShellPromptFor(screen, long)).toBe(true);
    // A different command is refused, even though the displayed prefix is a prefix of it.
    expect(hasShellPromptFor(REAL_SCREEN, "echo hi > marker.txt && rm -rf ./important")).toBe(
      false,
    );
  });

  it("does not match a prompt for a different command", () => {
    expect(hasShellPromptFor(REAL_SCREEN, "rm -rf /")).toBe(false);
    expect(hasShellPromptFor(REAL_SCREEN, "echo hello > other.txt")).toBe(false);
  });

  it("does not confirm a prompt for a longer command just because it starts with the approved one", () => {
    expect(hasShellPromptFor(REAL_SCREEN, "echo hi")).toBe(false);
    expect(hasShellPromptFor(REAL_SCREEN, "echo")).toBe(false);
    expect(hasShellPromptFor(REAL_SCREEN, "echo hi > marker")).toBe(false);
    expect(hasShellPromptFor(REAL_SCREEN, "echo hi > marker.txt")).toBe(true);
  });

  it("does not match without a prompt, or with an empty command", () => {
    expect(hasShellPromptFor("", "echo hi > marker.txt")).toBe(false);
    expect(
      hasShellPromptFor(
        "  Running that exact command now.\n  $ echo hi > marker.txt Waiting for approval...",
        "echo hi > marker.txt",
      ),
    ).toBe(false);
    expect(hasShellPromptFor(REAL_SCREEN, "")).toBe(false);
    expect(hasShellPromptFor(REAL_SCREEN, "   ")).toBe(false);
  });

  it("does not match a different kind of question, or one with no (y) option", () => {
    const other = REAL_SCREEN.replace("Run this command?", "Allow this tool?").replace(
      "Run (once) (y)",
      "Allow once (a)",
    );
    expect(hasShellPromptFor(other, "echo hi > marker.txt")).toBe(false);
    const noYes = REAL_SCREEN.replace("Run (once) (y)", "Run (once)");
    expect(hasShellPromptFor(noYes, "echo hi > marker.txt")).toBe(false);
  });

  it("does not match a stale prompt that has scrolled up under later output", () => {
    const later = Array.from({ length: 25 }, (_, i) => `  later output line ${i + 1}`).join("\n");
    expect(hasShellPromptFor(`${REAL_SCREEN}\n${later}`, "echo hi > marker.txt")).toBe(false);
  });

  it("does not match when the command only appears far above the question", () => {
    const filler = Array.from({ length: 12 }, (_, i) => ` unrelated line ${i}`).join("\n");
    const screen = [
      " $  echo hi > marker.txt in .",
      filler,
      " Run this command?",
      "  → Run (once) (y)",
    ].join("\n");
    expect(hasShellPromptFor(screen, "echo hi > marker.txt")).toBe(false);
  });
});

describe("afterAllow", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const ctx = (over: Record<string, unknown>) => {
    const writes: string[] = [];
    return {
      writes,
      ctx: {
        sessionId: "s",
        tool: "Shell",
        command: "echo hi > marker.txt",
        screen: () => REAL_SCREEN,
        write: (d: string) => writes.push(d),
        ...over,
      },
    };
  };

  it("presses y once when the prompt for that command is showing", async () => {
    const { ctx: c, writes } = ctx({});
    await cursorPlugin.afterAllow?.(c);
    expect(writes).toEqual(["y"]);
  });

  it("waits for the prompt to appear, then presses y", async () => {
    let screen = "  Running that exact command now.";
    const { ctx: c, writes } = ctx({ screen: () => screen });
    const done = cursorPlugin.afterAllow?.(c);
    await vi.advanceTimersByTimeAsync(500);
    expect(writes).toEqual([]);
    screen = REAL_SCREEN;
    await vi.advanceTimersByTimeAsync(200);
    await done;
    expect(writes).toEqual(["y"]);
  });

  it("types nothing if the prompt never appears (command already trusted, or a different UI)", async () => {
    const { ctx: c, writes } = ctx({ screen: () => "  just some output" });
    const done = cursorPlugin.afterAllow?.(c);
    await vi.advanceTimersByTimeAsync(9000);
    await done;
    expect(writes).toEqual([]);
  });

  it("types nothing for a prompt that belongs to a different command", async () => {
    const { ctx: c, writes } = ctx({ command: "rm -rf /" });
    const done = cursorPlugin.afterAllow?.(c);
    await vi.advanceTimersByTimeAsync(9000);
    await done;
    expect(writes).toEqual([]);
  });

  it("does nothing for tools other than shell commands", async () => {
    const { ctx: c, writes } = ctx({ tool: "Write" });
    await cursorPlugin.afterAllow?.(c);
    expect(writes).toEqual([]);
  });
});
