import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApprovalScreen, sanitize, wrapText } from "./approval-ui.js";

// Built at runtime so the pattern itself contains no control character.
const ESC = String.fromCharCode(27);
const ANY_ESCAPE = new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, "g");
const OWN_ESCAPES = new RegExp(`${ESC}\\[(?:2J|\\d+;1H|K|1m|0m|2m)`, "g");

describe("sanitize: agent text must not be able to drive the terminal", () => {
  it("shows escape sequences, carriage returns and other control characters visibly", () => {
    const hostile = "echo \x1b[31mRED\x1b[0m\rFAKE\x07\x08\x00end";
    const safe = sanitize(hostile);
    expect(safe).toBe("echo ␛[31mRED␛[0m␍FAKE␇␈␀end");
    // Nothing in the result can move the cursor, clear the screen or overwrite a line.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: this is the check
    expect(safe).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f]/);
  });

  it("keeps newlines, expands tabs, and leaves ordinary text alone", () => {
    expect(sanitize("a\nb\tc")).toBe("a\nb    c");
    expect(sanitize('café 中文 \u{1F600} git commit -m "x"')).toBe(
      'café 中文 \u{1F600} git commit -m "x"',
    );
  });

  it("makes direction overrides and invisible characters visible, so text cannot be disguised", () => {
    // Right-to-left override, zero-width space, BOM, soft hyphen, word joiner, tag characters, C1 controls, DEL.
    expect(sanitize("a‮b")).toBe("a<U+202E>b");
    expect(sanitize("rm​ -rf")).toBe("rm<U+200B> -rf");
    expect(sanitize("﻿x­y⁠")).toBe("<U+FEFF>x<U+00AD>y<U+2060>");
    expect(sanitize("\u{E0041}")).toBe("<U+E0041>");
    expect(sanitize("a\u0085b\u009bc")).toBe("a<U+0085>b<U+009B>c");
    expect(sanitize("a\u007fb")).toBe("a␡b");
  });
});

describe("wrapText", () => {
  it("wraps long lines, keeps blank lines and line breaks", () => {
    expect(wrapText("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
    expect(wrapText("ab\n\ncd", 10)).toEqual(["ab", "", "cd"]);
    expect(wrapText("", 10)).toEqual([""]);
  });

  it("counts characters, not UTF-16 units, so emoji are never split", () => {
    expect(wrapText("\u{1F600}\u{1F600}\u{1F600}", 2)).toEqual(["\u{1F600}\u{1F600}", "\u{1F600}"]);
  });
});

describe("ApprovalScreen", () => {
  let written: string[];
  let time: number;
  let size: { cols: number; rows: number };
  let screen: ApprovalScreen;

  const out = () => written.join("");
  const lastRender = () => written.filter((w) => w.includes("\x1b[2J")).at(-1) ?? "";
  const view = (command: string, queued = 0) => ({
    agent: "Claude Code",
    tool: "Bash",
    command,
    queued,
  });

  beforeEach(() => {
    vi.useFakeTimers();
    written = [];
    time = 1000;
    size = { cols: 80, rows: 24 };
    screen = new ApprovalScreen(
      { write: (t) => written.push(t), size: () => size },
      { now: () => time, armMs: 600 },
    );
  });
  afterEach(() => {
    screen.dismiss();
    vi.useRealTimers();
  });

  const armed = () => {
    time += 700;
  };

  it("takes over the terminal and shows who wants what, with the exact command", () => {
    screen.show(view('git commit -m "fix: café" && rm -rf ./build'));
    expect(screen.active).toBe(true);
    expect(out()).toContain("\x1b[?1049h"); // alternate screen: the agent's screen stays underneath
    const r = lastRender();
    expect(r).toContain("Airemo: approval needed");
    expect(r).toContain("Claude Code wants to use Bash:");
    expect(r).toContain('git commit -m "fix: café" && rm -rf ./build');
  });

  it("gives the screen back when dismissed, and enters and leaves exactly once", () => {
    screen.show(view("ls"));
    screen.show(view("pwd")); // replacing an approval does not nest
    screen.dismiss();
    screen.dismiss();
    expect(out().split("\x1b[?1049h")).toHaveLength(2); // one enter
    expect(out().split("\x1b[?1049l")).toHaveLength(2); // one leave
    expect(screen.active).toBe(false);
  });

  it("refuses to take an answer straight away", () => {
    screen.show(view("ls"));
    expect(lastRender()).toContain("Answer in a moment");
    expect(screen.handleKey("y")).toBeNull();
    expect(screen.handleKey("n")).toBeNull();
    time += 599;
    expect(screen.handleKey("y")).toBeNull();
    time += 1;
    expect(screen.handleKey("y")).toBe("allow");
  });

  it("shows the answer keys once it will take them", () => {
    screen.show(view("ls"));
    time += 700;
    vi.advanceTimersByTime(700);
    expect(lastRender()).toContain("[y]");
    expect(lastRender()).toContain("[n]");
    expect(lastRender()).not.toContain("Answer in a moment");
  });

  it("allows with y, rejects with n, q, Esc and Ctrl+C", () => {
    screen.show(view("ls"));
    armed();
    expect(screen.handleKey("y")).toBe("allow");
    expect(screen.handleKey("Y")).toBe("allow");
    for (const key of ["n", "N", "q", "\x1b", "\x03"]) expect(screen.handleKey(key)).toBe("deny");
  });

  it("ignores pasted text and anything that is not exactly one key", () => {
    screen.show(view("ls"));
    armed();
    for (const chunk of ["yy", "yes", "y\r", "\ry", "ok", "yes please\r\n", " y", "y "]) {
      expect(screen.handleKey(chunk)).toBeNull();
    }
    expect(screen.handleKey("")).toBeNull();
    expect(screen.handleKey("x")).toBeNull();
  });

  it("answers nothing when no approval is showing", () => {
    armed();
    expect(screen.handleKey("y")).toBeNull();
  });

  it("scrolls a command that does not fit, and says where you are", () => {
    size = { cols: 40, rows: 16 }; // 8 body rows
    const command = Array.from({ length: 30 }, (_, i) => `line-${i + 1}`).join("\n");
    screen.show(view(command));
    armed();
    let r = lastRender();
    expect(r).toContain("line-1");
    expect(r).toContain("line-8");
    expect(r).not.toContain("line-9");
    expect(r).toContain("lines 1-8 of 30");

    expect(screen.handleKey("\x1b[B")).toBeNull();
    r = lastRender();
    expect(r).toContain("lines 2-9 of 30");
    expect(r).not.toContain("line-1\x1b");

    screen.handleKey("\x1b[6~"); // page down
    expect(lastRender()).toContain("lines 10-17 of 30");
    screen.handleKey("G");
    expect(lastRender()).toContain("lines 23-30 of 30");
    expect(lastRender()).toContain("line-30");
    screen.handleKey("\x1b[B"); // cannot scroll past the end
    expect(lastRender()).toContain("lines 23-30 of 30");
    screen.handleKey("g");
    expect(lastRender()).toContain("lines 1-8 of 30");
    screen.handleKey("\x1b[A"); // cannot scroll above the start
    expect(lastRender()).toContain("lines 1-8 of 30");
    screen.handleKey("k");
    screen.handleKey("j");
    expect(lastRender()).toContain("lines 2-9 of 30");
  });

  it("wraps a long single-line command instead of cutting it off", () => {
    size = { cols: 30, rows: 24 };
    const command = `echo ${"x".repeat(100)}`;
    screen.show(view(command));
    const rendered = lastRender().replace(ANY_ESCAPE, "");
    expect(rendered.replace(/\s+/g, "")).toContain(command.replace(/\s+/g, ""));
  });

  it("shows a hostile command as harmless text and never forwards its escape codes", () => {
    const hostile =
      "echo hi \x1b[2J\x1b[1;1H Airemo: approval needed \x1b[Kallow\r        \rsafe-looking";
    screen.show(view(hostile));
    const r = lastRender();
    expect(r).toContain("␛[2J␛[1;1H");
    expect(r).toContain("␍");
    // The only escape sequences in the output are the screen's own (cursor moves, clears, bold).
    const own = r.replace(OWN_ESCAPES, "");
    expect(own).not.toContain("\x1b");
    expect(own).not.toContain("\r");
  });

  it("sanitises the agent and tool names too", () => {
    screen.show({ agent: "Evil\x1b[2J", tool: "T‮ool", command: "ls", queued: 0 });
    const r = lastRender();
    expect(r).toContain("Evil␛[2J wants to use T<U+202E>ool");
  });

  it("says how many more approvals are waiting", () => {
    screen.show(view("ls", 2));
    expect(lastRender()).toContain("(2 more waiting)");
    screen.setQueued(0);
    expect(lastRender()).not.toContain("more waiting");
    screen.setQueued(1);
    expect(lastRender()).toContain("(1 more waiting)");
  });

  it("redraws at the new size", () => {
    screen.show(view("echo ".concat("y".repeat(60))));
    size = { cols: 25, rows: 20 };
    written.length = 0;
    screen.redraw();
    expect(lastRender()).toContain(`\x1b[${19};1H`); // footer row follows the new height
  });
});
