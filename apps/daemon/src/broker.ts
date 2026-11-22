import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

export type Decision = "allow" | "deny";
export type ResolveReason = "user" | "timeout" | "session_ended";

export interface PendingRequest {
  requestId: string;
  sessionId: string;
  tool: string;
  /** The exact command or action shown to the user. */
  command: string;
}

export interface Resolution {
  decision: Decision;
  reason: ResolveReason;
}

interface BrokerEvents {
  request: [req: PendingRequest];
  resolved: [req: PendingRequest, resolution: Resolution];
}

/**
 * Holds pending permission requests until a client decides.
 * Default-deny: a timeout, a session ending, or a daemon shutdown resolves to "deny".
 */
export class PermissionBroker extends EventEmitter<BrokerEvents> {
  private pending = new Map<
    string,
    { req: PendingRequest; resolve: (r: Resolution) => void; timer: NodeJS.Timeout }
  >();

  constructor(private timeoutMs = 120_000) {
    super();
  }

  request(sessionId: string, tool: string, command: string): Promise<Resolution> {
    const req: PendingRequest = { requestId: randomUUID(), sessionId, tool, command };
    return new Promise<Resolution>((resolve) => {
      const timer = setTimeout(() => this.settle(req.requestId, "deny", "timeout"), this.timeoutMs);
      this.pending.set(req.requestId, { req, resolve, timer });
      this.emit("request", req);
    });
  }

  /** Apply a user decision. Returns false for an unknown or already-settled request. */
  decide(requestId: string, decision: Decision): boolean {
    return this.settle(requestId, decision, "user");
  }

  pendingFor(sessionId: string): PendingRequest[] {
    return [...this.pending.values()]
      .filter((p) => p.req.sessionId === sessionId)
      .map((p) => p.req);
  }

  /** Deny everything still waiting for a session (e.g. the agent exited). */
  denyAll(sessionId: string, reason: ResolveReason = "session_ended"): void {
    for (const req of this.pendingFor(sessionId)) this.settle(req.requestId, "deny", reason);
  }

  private settle(requestId: string, decision: Decision, reason: ResolveReason): boolean {
    const p = this.pending.get(requestId);
    if (!p) return false;
    clearTimeout(p.timer);
    this.pending.delete(requestId);
    const resolution = { decision, reason };
    p.resolve(resolution);
    this.emit("resolved", p.req, resolution);
    return true;
  }
}
