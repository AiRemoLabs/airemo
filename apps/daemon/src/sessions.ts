import { randomUUID } from "node:crypto";
import type { Cleanup, PluginRegistry } from "@airemo/plugin-sdk";
import { Session } from "./session.js";

/** Where agent hooks call back to; set once the daemon is listening. */
export interface HookContext {
  daemonUrl: string;
  token: string;
}

export class SessionManager {
  private sessions = new Map<string, Session>();
  private cleanups = new Map<string, Cleanup>();
  hookContext: HookContext | null = null;
  /** Launch agents so that they ask before acting. On by default. */
  requireApproval = true;
  onCreate: ((s: Session) => void) | null = null;
  private changeListeners = new Set<() => void>();

  constructor(private registry: PluginRegistry) {}

  /**
   * `launchArgs` is for trusted in-process callers only. It is deliberately not reachable
   * from the protocol: a remote client must not be able to pass flags such as
   * `--dangerously-skip-permissions` and bypass approvals.
   */
  async start(
    agent: string,
    cwd: string,
    cols?: number,
    rows?: number,
    launchArgs: string[] = [],
    resume?: { id?: string },
  ): Promise<Session> {
    const plugin = this.registry.get(agent);
    if (!plugin) throw new Error(`Unknown agent: ${agent}`);
    const { installed } = await plugin.detect();
    if (!installed) throw new Error(`${plugin.displayName} CLI is not installed`);
    const id = randomUUID();
    const env: Record<string, string> = this.hookContext
      ? {
          AIREMO_SESSION_ID: id,
          AIREMO_DAEMON_URL: this.hookContext.daemonUrl,
          AIREMO_HOOK_TOKEN: this.hookContext.token,
        }
      : {};
    const launchOpts = {
      cwd,
      env,
      args: launchArgs,
      requireApproval: this.requireApproval,
      ...(resume ? { resume } : {}),
    };

    // Let the plugin set the agent up (for example install its approval hook). If that fails
    // the session does not start: an agent that cannot be gated must not run ungated.
    const cleanup = await plugin.prepare?.(launchOpts);
    let session: Session;
    try {
      session = new Session(id, agent, cwd, plugin.launch(launchOpts), cols, rows);
    } catch (e) {
      cleanup?.();
      throw e;
    }
    if (cleanup) {
      this.cleanups.set(id, cleanup);
      session.on("exit", () => this.runCleanup(id));
    }
    this.sessions.set(session.id, session);
    this.onCreate?.(session);
    this.track(session);
    return session;
  }

  private runCleanup(id: string): void {
    const cleanup = this.cleanups.get(id);
    if (!cleanup) return;
    this.cleanups.delete(id);
    try {
      cleanup();
    } catch {
      // A failed cleanup must not take the daemon down. The leftovers are inert.
    }
  }

  /** Run every pending cleanup now. Called on shutdown, before sessions have finished exiting. */
  dispose(): void {
    for (const id of [...this.cleanups.keys()]) this.runCleanup(id);
  }

  /** Start a session from an explicit spawn spec (used by tests and tooling). */
  startRaw(agent: string, cwd: string, spec: ConstructorParameters<typeof Session>[3]): Session {
    const session = new Session(randomUUID(), agent, cwd, spec);
    this.sessions.set(session.id, session);
    this.onCreate?.(session);
    this.track(session);
    return session;
  }

  /** Be told when a session is created, ends or changes state, so lists can be kept fresh. */
  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  private notify(): void {
    for (const l of this.changeListeners) l();
  }

  private track(session: Session): void {
    session.on("status", () => this.notify());
    session.on("exit", () => this.notify());
    this.notify();
  }

  /** What clients are shown for each session. */
  summaries(): Array<{ id: string; agent: string; cwd: string; status: Session["status"] }> {
    return this.list().map((s) => ({ id: s.id, agent: s.agent, cwd: s.cwd, status: s.status }));
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  list(): Session[] {
    return [...this.sessions.values()];
  }

  stop(id: string): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    s.stop();
    return true;
  }

  stopAll(): void {
    for (const s of this.sessions.values()) s.stop();
  }
}
