import { realpathSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { createMessage, type Message, type MessageType, parseMessage } from "@airemo/protocol";
import { ApprovalScreen, type Decision } from "./approval-ui.js";

export interface RunInput {
  isTTY?: boolean;
  setRawMode?(raw: boolean): unknown;
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  removeListener(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  resume?(): unknown;
  pause?(): unknown;
}

export interface RunOutput {
  write(text: string): unknown;
  columns?: number;
  rows?: number;
  on?(event: "resize", listener: () => void): unknown;
  removeListener?(event: "resize", listener: () => void): unknown;
}

export interface RunOptions {
  agent: string;
  port: number;
  cwd: string;
  stdin: RunInput;
  stdout: RunOutput;
  /** Delay before a prompt accepts an answer. Short in tests. */
  armMs?: number;
  /** Join this existing session (for example one started from the phone) instead of starting one. */
  attachTo?: string;
  /**
   * When starting, offer to join a running session of the same agent in the same folder, so the
   * terminal and the phone share one session. Only asked in an interactive terminal. Default true.
   */
  offerJoin?: boolean;
  /**
   * Resume one of the agent's earlier conversations (`airemo resume`). Without `id` the agent shows
   * its own picker. Always starts a new session: it never offers to join a running one.
   */
  resume?: { id?: string };
}

/**
 * Switch off what a full-screen agent may have turned on in this terminal: mouse capture (all
 * modes and encodings), focus reports, bracketed paste and the alternate screen; then show the
 * cursor and reset colours. Each is harmless if it was not on. `?1047l` leaves the alternate
 * screen WITHOUT restoring a saved cursor (`?1049l` would jump to the top when nothing was saved).
 */
export const TERMINAL_RESET =
  "\x1b[?1000l\x1b[?1001l\x1b[?1002l\x1b[?1003l\x1b[?1005l\x1b[?1006l\x1b[?1015l\x1b[?1016l" +
  "\x1b[?1004l\x1b[?2004l\x1b[?1047l\x1b[?25h\x1b[0m";

export function agentLabel(id: string): string {
  return id === "claude-code" ? "Claude Code" : id === "cursor" ? "Cursor" : id;
}

export interface SessionSummary {
  id: string;
  agent: string;
  cwd: string;
  status: string;
}

function canonicalPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** Running sessions of this agent in this folder, which a terminal could join instead of starting another. */
export function findJoinable(
  sessions: SessionSummary[],
  agent: string,
  cwd: string,
  canon: (p: string) => string = canonicalPath,
): SessionSummary[] {
  const here = canon(cwd);
  return sessions.filter(
    (s) => s.status !== "exited" && s.agent === agent && canon(s.cwd) === here,
  );
}

interface Pending {
  requestId: string;
  tool: string;
  command: string;
}

/**
 * Run an agent through the daemon in this terminal. When the agent wants approval for something,
 * a full-screen prompt asks the person here; nothing typed during it reaches the agent.
 * Resolves with the process exit code.
 */
export function runSession(o: RunOptions): Promise<number> {
  return new Promise((resolve) => {
    const { stdin, stdout } = o;
    const ws = new WebSocket(`ws://127.0.0.1:${o.port}/ws`);
    const screen = new ApprovalScreen(
      {
        write: (t) => stdout.write(t),
        size: () => ({ cols: stdout.columns || 80, rows: stdout.rows || 24 }),
      },
      { armMs: o.armMs ?? 600 },
    );
    const decoder = new StringDecoder("utf8");

    let sessionId: string | undefined;
    let waitingForListing = false;
    let finished = false;
    let started = false;
    let repaint = false;
    let current: Pending | null = null;
    const queue: Pending[] = [];

    const send = <T extends MessageType>(
      type: T,
      payload: Extract<Message, { type: T }>["payload"],
    ) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify(createMessage(type, payload as never, sessionId ? { sessionId } : {})),
        );
      }
    };

    const onData = (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : decoder.write(chunk);
      if (!text) return;
      if (screen.active) {
        const decision = screen.handleKey(text);
        if (decision) answer(decision);
        return;
      }
      send("terminal.input", { data: text });
    };
    const onResize = () => {
      send("terminal.resize", { cols: stdout.columns || 80, rows: stdout.rows || 24 });
      screen.redraw();
    };

    const finish = (code: number, message?: string) => {
      if (finished) return;
      finished = true;
      screen.dismiss();
      stdin.removeListener("data", onData);
      stdout.removeListener?.("resize", onResize);
      if (started && stdin.isTTY) stdin.setRawMode?.(false);
      stdin.pause?.();
      // The agent may still be running (detach, lost connection, daemon restart), so it never got
      // to switch off what it turned on. Do it here, or the terminal stays on the alternate screen
      // with mouse capture, and scrolling no longer works in it.
      if (started && stdin.isTTY) stdout.write(TERMINAL_RESET);
      if (message) stdout.write(`\r\n${message}\r\n`);
      try {
        ws.close();
      } catch {
        // already closed
      }
      resolve(code);
    };

    /** Move on to the next waiting approval, or give the screen back to the agent. */
    const next = () => {
      current = queue.shift() ?? null;
      if (current) {
        screen.show({
          agent: agentLabel(o.agent),
          tool: current.tool,
          command: current.command,
          queued: queue.length,
        });
      } else {
        screen.dismiss();
        // The prompt covered the agent's screen: ask the computer for a fresh copy of it.
        repaint = true;
        send("session.attach", {});
      }
    };

    const answer = (decision: Decision) => {
      if (!current) return;
      send("permission.decision", { requestId: current.requestId, decision });
      next();
    };

    /** Take over this terminal for the session: raw keys in, the agent's screen out. */
    const beginInteractive = () => {
      started = true;
      // Start from a normal terminal, in case an earlier session left modes on. The agent's
      // screen (snapshot and output, which arrive after this) turns on whatever it really uses.
      if (stdin.isTTY) stdout.write(TERMINAL_RESET);
      if (stdin.isTTY) stdin.setRawMode?.(true);
      stdin.on("data", onData);
      stdin.resume?.();
      stdout.on?.("resize", onResize);
    };

    const startNew = () => {
      if (finished) return;
      send("session.start", {
        agent: o.agent,
        cwd: o.cwd,
        cols: stdout.columns || 100,
        rows: stdout.rows || 30,
        ...(o.resume ? { resume: o.resume } : {}),
      });
    };

    /** Join a session that already exists. Its size is left alone: someone else may be using it. */
    const joinExisting = (id: string) => {
      if (finished) return;
      sessionId = id;
      repaint = true; // draw its current screen from scratch
      beginInteractive();
      send("session.attach", {});
    };

    const askYesNo = (question: string) =>
      new Promise<boolean>((resolveAnswer) => {
        stdout.write(question);
        const onLine = (chunk: Buffer | string) => {
          stdin.removeListener("data", onLine);
          const answer = (typeof chunk === "string" ? chunk : chunk.toString("utf8"))
            .trim()
            .toLowerCase();
          resolveAnswer(answer === "" || answer.startsWith("y"));
        };
        stdin.on("data", onLine);
        stdin.resume?.();
      });

    ws.onopen = () => {
      if (o.attachTo) return joinExisting(o.attachTo);
      if (!o.resume && (o.offerJoin ?? true) && stdin.isTTY) {
        // Is this agent already running in this folder (say, started from the phone)? Ask first.
        waitingForListing = true;
        send("session.list", {});
        setTimeout(() => {
          if (waitingForListing) {
            waitingForListing = false;
            startNew();
          }
        }, 3000);
        return;
      }
      startNew();
    };
    ws.onerror = () => {
      if (!started) finish(1, "Could not reach the daemon. Run `airemo start` first.");
    };
    ws.onclose = () => finish(1, started ? "Lost the connection to the daemon." : undefined);

    ws.onmessage = (ev) => {
      let m: Message;
      try {
        m = parseMessage(JSON.parse(String(ev.data)));
      } catch {
        return;
      }
      switch (m.type) {
        case "session.started":
          sessionId = m.sessionId;
          beginInteractive();
          break;
        case "session.listing": {
          // The daemon also pushes this whenever sessions change; only the first answer matters.
          if (!waitingForListing) break;
          waitingForListing = false;
          const existing = findJoinable(m.payload.sessions, o.agent, o.cwd)[0];
          if (!existing) {
            startNew();
            break;
          }
          void askYesNo(
            `A ${agentLabel(o.agent)} session is already running in this folder. Join it, so this terminal and your phone share one session? [Y/n] `,
          ).then((yes) => (yes ? joinExisting(existing.id) : startNew()));
          break;
        }
        case "terminal.snapshot":
          if (repaint) {
            repaint = false;
            stdout.write(`\x1b[2J\x1b[H${m.payload.data}`);
          } else stdout.write(m.payload.data);
          break;
        case "terminal.output":
          // While the prompt is up the agent's screen is hidden; it is repainted afterwards.
          if (!screen.active) stdout.write(m.payload.data);
          break;
        case "permission.request": {
          const req = {
            requestId: m.payload.requestId,
            tool: m.payload.tool,
            command: m.payload.command,
          };
          if (
            current?.requestId === req.requestId ||
            queue.some((q) => q.requestId === req.requestId)
          )
            break;
          if (!stdin.isTTY) {
            stdout.write(
              `\r\nApproval needed for ${req.tool}, but this is not an interactive terminal.\r\n`,
            );
            break;
          }
          if (!current) {
            queue.push(req);
            next();
          } else {
            queue.push(req);
            screen.setQueued(queue.length);
          }
          break;
        }
        case "permission.resolved": {
          // Answered somewhere else (for example on the phone), or timed out.
          const i = queue.findIndex((q) => q.requestId === m.payload.requestId);
          if (i >= 0) queue.splice(i, 1);
          if (current?.requestId === m.payload.requestId) next();
          else if (screen.active) screen.setQueued(queue.length);
          break;
        }
        case "session.exit":
          finish(m.payload.exitCode ?? 0);
          break;
        case "error":
          // A decision that arrives after the request ended is harmless.
          if (m.payload.code !== "no_request") finish(1, m.payload.message);
          break;
        default:
          break;
      }
    };
  });
}
