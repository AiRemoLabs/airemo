import type { AgentStatus } from "@airemo/protocol";

export interface LaunchOptions {
  cwd: string;
  env?: Record<string, string>;
  args?: string[];
  /**
   * Launch the agent so that it asks before acting (not in an auto-approve mode), so every
   * action can go through Airemo's approval flow.
   */
  requireApproval?: boolean;
  /**
   * Resume an earlier conversation instead of starting fresh. Without `id` the agent shows its own
   * picker. The plugin maps this to the agent's flag; the id is already validated by the protocol.
   */
  resume?: { id?: string };
}

export interface SpawnSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
}

export type AgentEvent =
  | { kind: "status"; status: AgentStatus }
  | { kind: "tool_use"; tool: string; summary?: string }
  | { kind: "permission_request"; requestId: string; tool: string; command: string }
  | { kind: "error"; message: string };

export interface PluginCapabilities {
  structuredOutput: boolean;
  permissionHooks: boolean;
  pauseResume: boolean;
}

export interface DetectResult {
  installed: boolean;
  version?: string;
}

/** Undo what `prepare` set up. Synchronous, so it can also run while the daemon shuts down. */
export type Cleanup = () => void;

/** What a plugin gets after the user allows an action. */
export interface AfterAllowContext {
  sessionId: string;
  tool: string;
  /** The exact action the user approved. */
  command: string;
  /** The visible terminal screen as plain text, for recognising the agent's own prompt. */
  screen(): string;
  /** Type into the agent's terminal. */
  write(data: string): void;
}

/** The only surface Core uses to talk to an agent. Core never imports a specific plugin. */
export interface AgentPlugin {
  id: string;
  displayName: string;
  capabilities: PluginCapabilities;
  detect(): Promise<DetectResult>;
  /**
   * Optional. Set the agent up before it starts, for example write its hook configuration into
   * the project. Return a cleanup that runs when the session ends. Throw to refuse to start
   * (a session that cannot be gated must not start ungated).
   */
  prepare?(opts: LaunchOptions): Promise<Cleanup | undefined> | Cleanup | undefined;
  /**
   * Optional. Called after the user allowed an action through Airemo. Some agents ask their own
   * question on top (for example "Run this command?"). The plugin may confirm it, but only when
   * it recognises that exact prompt, so an unrecognised prompt stays visible for the user.
   */
  afterAllow?(ctx: AfterAllowContext): Promise<void>;
  launch(opts: LaunchOptions): SpawnSpec;
  parseOutput(chunk: string): AgentEvent[];
  respondToPermission(requestId: string, decision: "allow" | "deny"): string | null;
}

export class PluginRegistry {
  private plugins = new Map<string, AgentPlugin>();

  register(plugin: AgentPlugin): this {
    if (this.plugins.has(plugin.id)) throw new Error(`Plugin already registered: ${plugin.id}`);
    this.plugins.set(plugin.id, plugin);
    return this;
  }

  get(id: string): AgentPlugin | undefined {
    return this.plugins.get(id);
  }

  list(): AgentPlugin[] {
    return [...this.plugins.values()];
  }
}

/**
 * `--resume` or `--resume <id>`, for agents that take an optional value. Put it last, so an
 * id-less `--resume` cannot swallow the next argument as its value.
 */
export function resumeArgs(resume: LaunchOptions["resume"], flag = "--resume"): string[] {
  if (!resume) return [];
  return resume.id ? [flag, resume.id] : [flag];
}

/** Replay a recorded session (array of output chunks) through a plugin and collect events. */
export function replayFixture(plugin: AgentPlugin, chunks: string[]): AgentEvent[] {
  return chunks.flatMap((c) => plugin.parseOutput(c));
}

/** Run `<command> --version` and report whether the CLI is installed. */
export async function detectCli(
  command: string,
  versionArgs: string[] = ["--version"],
): Promise<DetectResult> {
  const { execFile } = await import("node:child_process");
  return new Promise((resolve) => {
    execFile(command, versionArgs, { timeout: 5000 }, (err, stdout) => {
      if (err) return resolve({ installed: false });
      const version = stdout.toString().trim().split("\n")[0];
      resolve(version ? { installed: true, version } : { installed: true });
    });
  });
}
