export type Decision = "allow" | "deny";

export interface ScreenIo {
  write(text: string): void;
  size(): { cols: number; rows: number };
}

export interface ApprovalView {
  agent: string;
  tool: string;
  /** The exact command or action, shown in full. */
  command: string;
  /** How many more approvals are waiting behind this one. */
  queued: number;
}

// Characters that can hide what a command really does: invisible ones and text-direction
// overrides. They are shown as <U+XXXX> instead of being rendered.
const INVISIBLE: Array<[number, number]> = [
  [0x00ad, 0x00ad],
  [0x034f, 0x034f],
  [0x061c, 0x061c],
  [0x180e, 0x180e],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x2064],
  [0x2066, 0x2069],
  [0xfeff, 0xfeff],
  [0xfff9, 0xfffb],
  [0xe0000, 0xe007f],
];

const hex = (cp: number) => `<U+${cp.toString(16).toUpperCase().padStart(4, "0")}>`;

/**
 * Make text safe to print on a terminal. The text comes from the agent, so it must not be able
 * to move the cursor, clear the screen, overwrite a line (carriage return) or reorder itself
 * with direction marks to disguise what it is. Anything like that is shown visibly instead.
 */
export function sanitize(text: string): string {
  let out = "";
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (ch === "\n") out += ch;
    else if (ch === "\t") out += "    ";
    else if (cp < 0x20)
      out += String.fromCodePoint(0x2400 + cp); // control pictures: "␛" for Esc
    else if (cp === 0x7f) out += "␡";
    else if (cp >= 0x80 && cp <= 0x9f) out += hex(cp);
    else if (INVISIBLE.some(([lo, hi]) => cp >= lo && cp <= hi)) out += hex(cp);
    else out += ch;
  }
  return out;
}

/** Break text into lines of at most `width` characters, keeping existing line breaks. */
export function wrapText(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const line of text.split("\n")) {
    const chars = Array.from(line);
    if (chars.length === 0) lines.push("");
    for (let i = 0; i < chars.length; i += width) lines.push(chars.slice(i, i + width).join(""));
  }
  return lines;
}

const clip = (s: string, max: number) =>
  Array.from(s).length > max
    ? `${Array.from(s)
        .slice(0, max - 1)
        .join("")}…`
    : s;

const ENTER = "\x1b[?1049h\x1b[?25l"; // alternate screen, hide cursor
const LEAVE = "\x1b[?25h\x1b[?1049l";

/**
 * A full-screen prompt that asks the person at the keyboard to allow or reject an agent action.
 *
 * It uses the terminal's alternate screen, so the agent's own screen is untouched underneath.
 * While it is showing, every key belongs to the prompt and none reach the agent.
 */
export class ApprovalScreen {
  private view: ApprovalView | null = null;
  private scroll = 0;
  private armedAt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private io: ScreenIo,
    private options: { now?: () => number; armMs?: number } = {},
  ) {}

  get active(): boolean {
    return this.view !== null;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  /** Show an approval. If one is already showing, it is replaced (scroll resets). */
  show(view: ApprovalView): void {
    if (!this.view) this.io.write(ENTER);
    this.view = view;
    this.scroll = 0;
    // Ignore keys for a moment: something typed into the agent just before this appeared must
    // not answer a question the person has not seen yet.
    const arm = this.options.armMs ?? 600;
    this.armedAt = this.now() + arm;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.render(), arm + 20);
    this.render();
  }

  setQueued(queued: number): void {
    if (!this.view) return;
    this.view = { ...this.view, queued };
    this.render();
  }

  /** Redraw, for example after the terminal was resized. */
  redraw(): void {
    if (this.view) this.render();
  }

  dismiss(): void {
    if (!this.view) return;
    this.view = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.io.write(LEAVE);
  }

  /**
   * Feed one chunk of keyboard input. Returns the decision once the person has made one.
   * Only exact single keys count, so a pasted block of text can never answer the prompt.
   */
  handleKey(chunk: string): Decision | null {
    if (!this.view || this.now() < this.armedAt) return null;
    switch (chunk) {
      case "y":
      case "Y":
        return "allow";
      case "n":
      case "N":
      case "q":
      case "\x1b": // Esc on its own
      case "\x03": // Ctrl+C
        return "deny";
      case "\x1b[A":
      case "k":
        this.scrollBy(-1);
        return null;
      case "\x1b[B":
      case "j":
        this.scrollBy(1);
        return null;
      case "\x1b[5~":
        this.scrollBy(-this.bodyRows());
        return null;
      case "\x1b[6~":
        this.scrollBy(this.bodyRows());
        return null;
      case "g":
        this.scrollBy(-Infinity);
        return null;
      case "G":
        this.scrollBy(Infinity);
        return null;
      default:
        return null;
    }
  }

  private bodyRows(): number {
    return Math.max(3, this.io.size().rows - 8);
  }

  private bodyLines(): string[] {
    const width = Math.max(20, this.io.size().cols - 3);
    return wrapText(sanitize(this.view?.command ?? ""), width);
  }

  private scrollBy(delta: number): void {
    const max = Math.max(0, this.bodyLines().length - this.bodyRows());
    this.scroll = Math.min(max, Math.max(0, this.scroll + delta));
    this.render();
  }

  private render(): void {
    const view = this.view;
    if (!view) return;
    const { cols, rows } = this.io.size();
    const body = this.bodyLines();
    const bodyRows = this.bodyRows();
    this.scroll = Math.min(this.scroll, Math.max(0, body.length - bodyRows));
    const shown = body.slice(this.scroll, this.scroll + bodyRows);
    const armed = this.now() >= this.armedAt;

    const title = `\x1b[1m Airemo: approval needed\x1b[0m${view.queued > 0 ? `  (${view.queued} more waiting)` : ""}`;
    const who = ` ${clip(sanitize(view.agent), 40)} wants to use ${clip(sanitize(view.tool), 40)}:`;
    const lines: string[] = [title, "", who, ""];
    for (const line of shown) lines.push(`  ${line}`);
    const more = body.length > bodyRows;
    const info = more
      ? ` \x1b[2mlines ${this.scroll + 1}-${this.scroll + shown.length} of ${body.length}  (up/down to scroll)\x1b[0m`
      : "";
    const footer = armed
      ? " \x1b[1m[y]\x1b[0m Allow    \x1b[1m[n]\x1b[0m Reject (Esc)"
      : " \x1b[2mAnswer in a moment...\x1b[0m";

    let out = "\x1b[2J";
    lines.forEach((line, i) => {
      out += `\x1b[${i + 1};1H${line}\x1b[K`;
    });
    if (info) out += `\x1b[${Math.min(rows - 2, lines.length + 1)};1H${info}\x1b[K`;
    out += `\x1b[${Math.max(1, rows - 1)};1H${footer}\x1b[K`;
    this.io.write(out);
    void cols;
  }
}
