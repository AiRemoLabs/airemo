import { EventEmitter } from "node:events";
import type { SpawnSpec } from "@airemo/plugin-sdk";
import type { AgentStatus } from "@airemo/protocol";
import serializePkg from "@xterm/addon-serialize";
import type { Terminal as TerminalType } from "@xterm/headless";
import headlessPkg from "@xterm/headless";
import * as pty from "node-pty";

export interface SessionEvents {
  output: [data: string];
  status: [status: AgentStatus];
  exit: [exitCode: number | null];
  /** The terminal changed size. Anyone drawing it has to follow. */
  resize: [cols: number, rows: number];
}

// The xterm packages are CommonJS: named ESM imports fail at runtime under Node.
const { Terminal } = headlessPkg;
const { SerializeAddon } = serializePkg;

/** One agent process, one PTY, one headless terminal that holds the current screen. */
export class Session extends EventEmitter<SessionEvents> {
  status: AgentStatus = "starting";
  /** True once someone asked this session to stop, so an intentional stop is not reported as an error. */
  stopRequested = false;
  readonly pid: number;
  private proc: pty.IPty;
  private term: TerminalType;
  private serializer = new SerializeAddon();

  constructor(
    readonly id: string,
    readonly agent: string,
    readonly cwd: string,
    spec: SpawnSpec,
    cols = 100,
    rows = 30,
  ) {
    super();
    this.term = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 2000 });
    this.term.loadAddon(this.serializer);
    this.proc = pty.spawn(spec.command, spec.args, {
      name: "xterm-256color",
      cols,
      rows,
      cwd: spec.cwd,
      env: spec.env,
    });
    this.pid = this.proc.pid;
    this.setStatus("running");

    this.proc.onData((data) => {
      this.term.write(data);
      this.emit("output", data);
    });
    this.proc.onExit(({ exitCode }) => {
      this.setStatus("exited");
      this.emit("exit", exitCode);
    });
  }

  /**
   * Type a prompt and submit it. Interactive agent TUIs treat text and Enter that arrive
   * in one burst as a paste, so Enter is sent separately after a short delay.
   */
  sendPrompt(text: string, submitDelayMs = 150): void {
    this.proc.write(text);
    setTimeout(() => {
      if (this.status !== "exited") this.proc.write("\r");
    }, submitDelayMs);
  }

  write(data: string): void {
    this.proc.write(data);
  }

  resize(cols: number, rows: number): void {
    const changed = cols !== this.term.cols || rows !== this.term.rows;
    this.proc.resize(cols, rows);
    this.term.resize(cols, rows);
    if (changed) this.emit("resize", cols, rows);
  }

  /** Serialized screen state so a reconnecting client can resync. */
  snapshot(): { data: string; cols: number; rows: number } {
    return { data: this.serializer.serialize(), cols: this.term.cols, rows: this.term.rows };
  }

  /** The visible screen as plain text (no escape codes), one string per row. */
  screenText(): string {
    const buffer = this.term.buffer.active;
    const rows: string[] = [];
    for (let i = 0; i < this.term.rows; i++) {
      rows.push(buffer.getLine(buffer.viewportY + i)?.translateToString(true) ?? "");
    }
    return rows.join("\n");
  }

  stop(): void {
    this.stopRequested = true;
    if (this.status !== "exited") this.proc.kill();
  }

  setStatus(status: AgentStatus): void {
    this.status = status;
    this.emit("status", status);
  }
}
