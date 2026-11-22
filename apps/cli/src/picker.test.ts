import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { pick, rowsFor, splitKeys } from "./picker.js";

class Keys extends EventEmitter {
  isTTY = true;
  raw: boolean[] = [];
  setRawMode(r: boolean) {
    this.raw.push(r);
  }
  press(...keys: string[]) {
    for (const k of keys) this.emit("data", Buffer.from(k));
  }
}
class Screen {
  out = "";
  write(t: string) {
    this.out += t;
  }
}

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const agents = [
  { value: "claude-code", label: "Claude Code", hint: "2.1" },
  { value: "cursor", label: "Cursor" },
];

function setup() {
  const stdin = new Keys();
  const stdout = new Screen();
  return { stdin, stdout, io: { stdin, stdout } };
}

describe("pick", () => {
  it("splits arrow keys from plain keys", () => {
    expect(splitKeys(`${DOWN} \r`)).toEqual([DOWN, " ", "\r"]);
    expect(splitKeys("\x1b")).toEqual(["\x1b"]);
  });

  it("counts wrapped rows so a long folder path redraws in place", () => {
    expect(rowsFor(["short", "\x1b[32m◉\x1b[0m x"], 80)).toBe(2);
    expect(rowsFor(["a".repeat(170)], 80)).toBe(3);
    expect(rowsFor([""], 0)).toBe(1);
  });

  it("needs at least one ticked agent before Enter is accepted", async () => {
    const { stdin, stdout, io } = setup();
    const result = pick(io, "Which agents?", agents, { multiple: true, min: 1 });
    stdin.press("\r");
    expect(stdout.out).toContain("Select at least 1");
    stdin.press(DOWN, " ", "\r");
    expect(await result).toEqual(["cursor"]);
    expect(stdin.raw).toEqual([true, false]);
    expect(stdin.listenerCount("data")).toBe(0);
  });

  it("ticks several, keeps list order, and untick works", async () => {
    const { stdin, io } = setup();
    const result = pick(io, "t", agents, { multiple: true });
    stdin.press(DOWN, " ", UP, " ", DOWN, " ", " ", "\r");
    expect(await result).toEqual(["claude-code", "cursor"]);
  });

  it("starts with the given items ticked, and `a` toggles all", async () => {
    const first = setup();
    const kept = pick(first.io, "t", agents, { multiple: true, selected: ["cursor", "nope"] });
    first.stdin.press("\r");
    expect(await kept).toEqual(["cursor"]);

    const second = setup();
    const none = pick(second.io, "t", agents, { multiple: true });
    second.stdin.press("a", "\r");
    expect(await none).toEqual(["claude-code", "cursor"]);
  });

  it("Esc, q or Ctrl-C cancels", async () => {
    for (const key of ["\x1b", "q", "\x03"]) {
      const { stdin, io } = setup();
      const result = pick(io, "t", agents, { multiple: true });
      stdin.press(key);
      expect(await result).toBeNull();
    }
  });

  it("single choice: Enter picks the highlighted item, wrapping around", async () => {
    const { stdin, io } = setup();
    const result = pick(io, "t", agents);
    stdin.press(UP, "\r");
    expect(await result).toEqual(["cursor"]);
  });

  it("shows the hint and the title", async () => {
    const { stdin, stdout, io } = setup();
    const result = pick(io, "Which agents may your phone use?", agents, { multiple: true });
    stdin.press("q");
    await result;
    expect(stdout.out).toContain("Which agents may your phone use?");
    expect(stdout.out).toContain("Claude Code");
    expect(stdout.out).toContain("2.1");
  });
});
