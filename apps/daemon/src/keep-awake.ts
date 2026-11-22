import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";

/**
 * Keeps the computer from going to sleep on its own while the daemon runs, so a phone can still
 * reach the agents when the screen is locked. A locked screen does not stop programs; idle sleep
 * does. This only blocks idle sleep: closing a laptop's lid still sleeps it (macOS needs clamshell
 * mode or `pmset disablesleep` for that), and nothing can run while a computer is asleep.
 *
 * It holds the OS's own sleep lock through a helper process that watches the daemon's PID, so the
 * lock is released even if the daemon crashes. The display is still allowed to turn off.
 */
export type KeepAwakeState = "on" | "off" | "unsupported" | "failed";

type Spawn = (cmd: string, args: string[]) => ChildProcess;

export interface KeepAwakeOptions {
  platform?: NodeJS.Platform;
  pid?: number;
  spawn?: Spawn;
  log?: (msg: string) => void;
}

/** The command that holds the sleep lock on this platform, or null if there is none. */
export function keepAwakeCommand(
  platform: NodeJS.Platform,
  pid: number,
): { cmd: string; args: string[] } | null {
  if (platform === "darwin") {
    // -i: no idle sleep. -s: no system sleep while on AC power. -w: exit when the daemon exits.
    return { cmd: "caffeinate", args: ["-i", "-s", "-w", String(pid)] };
  }
  if (platform === "linux") {
    return {
      cmd: "systemd-inhibit",
      args: [
        "--what=idle:sleep",
        "--who=Airemo",
        "--why=Keep agents reachable from a paired phone",
        "--mode=block",
        "tail",
        `--pid=${pid}`,
        "-f",
        "/dev/null",
      ],
    };
  }
  return null;
}

export class KeepAwake {
  private child: ChildProcess | null = null;
  private stopping = false;
  state: KeepAwakeState = "off";

  constructor(private readonly o: KeepAwakeOptions = {}) {}

  start(): KeepAwakeState {
    if (this.child) return this.state;
    const command = keepAwakeCommand(
      this.o.platform ?? process.platform,
      this.o.pid ?? process.pid,
    );
    if (!command) {
      this.state = "unsupported";
      return this.state;
    }
    this.stopping = false;
    const spawn: Spawn =
      this.o.spawn ?? ((cmd, args) => nodeSpawn(cmd, args, { stdio: "ignore", detached: false }));
    let child: ChildProcess;
    try {
      child = spawn(command.cmd, command.args);
    } catch {
      this.state = "failed";
      return this.state;
    }
    this.child = child;
    this.state = "on";
    child.on("error", () => {
      if (this.child !== child) return;
      this.child = null;
      this.state = "failed";
      this.o.log?.(`keep-awake: could not run ${command.cmd}; the computer may sleep`);
    });
    child.on("exit", () => {
      if (this.child !== child) return;
      this.child = null;
      if (this.stopping) return;
      this.state = "failed";
      this.o.log?.(`keep-awake: ${command.cmd} exited; the computer may sleep`);
    });
    return this.state;
  }

  stop(): void {
    this.stopping = true;
    const child = this.child;
    this.child = null;
    if (this.state === "on") this.state = "off";
    child?.kill();
  }
}
