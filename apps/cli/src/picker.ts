import type { RunInput } from "./run.js";

export interface PickItem {
  value: string;
  label: string;
  /** Shown dimmed after the label, for example a version. */
  hint?: string;
}

export interface PickIo {
  stdin: RunInput;
  stdout: { write(text: string): unknown; columns?: number };
}

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, "g");
const visible = (s: string) => s.replace(ANSI, "");

/** How many terminal rows these lines take, counting lines that wrap. */
export function rowsFor(lines: string[], columns: number | undefined): number {
  const width = columns && columns > 0 ? columns : 80;
  return lines.reduce((n, l) => n + Math.max(1, Math.ceil([...visible(l)].length / width)), 0);
}

export interface PickOptions {
  /** Several items can be ticked (space), Enter confirms. Otherwise Enter picks the highlighted one. */
  multiple?: boolean;
  /** Multiple only: the fewest items that must be ticked before Enter is accepted. Default 1. */
  min?: number;
  /** Multiple only: items ticked at the start. */
  selected?: string[];
}

const UP = new Set(["\x1b[A", "\x1bOA", "k"]);
const DOWN = new Set(["\x1b[B", "\x1bOB", "j"]);
const ENTER = new Set(["\r", "\n"]);
const CANCEL = new Set(["\x03", "\x1b", "q"]);

/** Split a chunk of terminal input into keys (escape sequences stay whole). */
export function splitKeys(text: string): string[] {
  const keys: string[] = [];
  for (let i = 0; i < text.length; ) {
    if (text[i] === "\x1b" && (text[i + 1] === "[" || text[i + 1] === "O") && i + 2 < text.length) {
      keys.push(text.slice(i, i + 3));
      i += 3;
    } else {
      keys.push(text[i] as string);
      i += 1;
    }
  }
  return keys;
}

/**
 * An arrow-key list in the terminal. Resolves with the chosen values, or null if the person
 * cancelled (Esc, q or Ctrl-C). Needs a TTY: the caller checks that first.
 *
 *   ↑/↓ (or k/j)  move      space  tick or untick (multiple)
 *   a             tick all  Enter  confirm
 */
export function pick(
  io: PickIo,
  title: string,
  items: PickItem[],
  opts: PickOptions = {},
): Promise<string[] | null> {
  const { stdin, stdout } = io;
  const multiple = opts.multiple ?? false;
  const min = Math.min(opts.min ?? 1, items.length);
  const ticked = new Set((opts.selected ?? []).filter((v) => items.some((i) => i.value === v)));
  let cursor = 0;
  let warning = "";
  let drawnLines = 0;

  const help = multiple
    ? "↑/↓ move · space select · a all · Enter confirm · Esc cancel"
    : "↑/↓ move · Enter choose · Esc cancel";

  const render = () => {
    const lines = [
      title,
      ...items.map((item, i) => {
        const pointer = i === cursor ? "\x1b[36m❯\x1b[0m" : " ";
        const box = multiple ? (ticked.has(item.value) ? "\x1b[32m◉\x1b[0m " : "◯ ") : "";
        const hint = item.hint ? ` \x1b[2m${item.hint}\x1b[0m` : "";
        return `${pointer} ${box}${item.label}${hint}`;
      }),
      warning ? `\x1b[33m${warning}\x1b[0m` : `\x1b[2m${help}\x1b[0m`,
    ];
    // Go back to the top of the previous drawing and clear it, then draw again.
    const back = drawnLines > 0 ? `\r\x1b[${drawnLines}A\x1b[J` : "";
    stdout.write(`${back}${lines.join("\r\n")}\r\n`);
    drawnLines = rowsFor(lines, stdout.columns);
  };

  return new Promise((resolve) => {
    const done = (result: string[] | null) => {
      stdin.removeListener("data", onData);
      stdin.setRawMode?.(false);
      stdin.pause?.();
      stdout.write("\x1b[?25h"); // cursor back on
      resolve(result);
    };

    const onData = (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      for (const key of splitKeys(text)) {
        warning = "";
        if (CANCEL.has(key)) return done(null);
        if (UP.has(key)) cursor = (cursor - 1 + items.length) % items.length;
        else if (DOWN.has(key)) cursor = (cursor + 1) % items.length;
        else if (multiple && key === " ") {
          const v = (items[cursor] as PickItem).value;
          if (ticked.has(v)) ticked.delete(v);
          else ticked.add(v);
        } else if (multiple && key === "a") {
          const all = ticked.size === items.length;
          ticked.clear();
          if (!all) for (const i of items) ticked.add(i.value);
        } else if (ENTER.has(key)) {
          if (!multiple) return done([(items[cursor] as PickItem).value]);
          if (ticked.size >= min) {
            // Keep the list order, not the order things were ticked in.
            return done(items.filter((i) => ticked.has(i.value)).map((i) => i.value));
          }
          warning = `Select at least ${min} (space to select).`;
        }
      }
      render();
    };

    stdout.write("\x1b[?25l"); // hide the cursor while the list is up
    render();
    stdin.setRawMode?.(true);
    stdin.on("data", onData);
    stdin.resume?.();
  });
}
