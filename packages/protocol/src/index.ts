import { z } from "zod";

export const PROTOCOL_VERSION = 1;

/** Default local port for the Airemo daemon (bound to 127.0.0.1). */
export const DEFAULT_DAEMON_PORT = 47821;

/** Versioned envelope wrapping every message. */
export const envelopeBase = z.object({
  v: z.literal(PROTOCOL_VERSION),
  id: z.string().min(1),
  ts: z.number().int().nonnegative(),
  sessionId: z.string().optional(),
});

const msg = <T extends string, P extends z.ZodTypeAny>(type: T, payload: P) =>
  envelopeBase.extend({ type: z.literal(type), payload });

/** An agent's conversation ID to resume: letters, digits, `.`, `_`, `-`, never starting with `-`. */
export const resumeId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);

export const agentStatus = z.enum([
  "starting",
  "running",
  "awaiting_approval",
  "idle",
  "error",
  "exited",
]);
export type AgentStatus = z.infer<typeof agentStatus>;

export const messageSchema = z.discriminatedUnion("type", [
  // Session lifecycle
  msg(
    "session.start",
    z.object({
      agent: z.string(),
      cwd: z.string(),
      cols: z.number().int().positive().optional(),
      rows: z.number().int().positive().optional(),
      /**
       * Resume one of the agent's earlier conversations instead of starting fresh. Without an `id`
       * the agent shows its own picker. Typed on purpose (never raw launch flags): the plugin
       * decides which flag this becomes, and the id cannot start with `-`, so it cannot be a flag.
       */
      resume: z.object({ id: resumeId.optional() }).optional(),
    }),
  ),
  msg("session.started", z.object({ agent: z.string(), pid: z.number().int().optional() })),
  msg("session.list", z.object({})),
  msg(
    "session.listing",
    z.object({
      sessions: z.array(
        z.object({
          id: z.string(),
          agent: z.string(),
          cwd: z.string(),
          status: agentStatus,
        }),
      ),
    }),
  ),
  msg("session.attach", z.object({})),
  msg("session.stop", z.object({})),
  msg("session.exit", z.object({ exitCode: z.number().int().nullable() })),
  // Projects the computer allows remote devices to start agents in
  msg("project.list", z.object({})),
  msg(
    "project.listing",
    z.object({
      projects: z.array(
        z.object({
          path: z.string(),
          name: z.string(),
          /** Agents the phone may start here. Absent means every agent. */
          agents: z.array(z.string()).optional(),
        }),
      ),
    }),
  ),
  // Input
  msg("prompt.send", z.object({ text: z.string() })),
  msg("terminal.input", z.object({ data: z.string() })),
  msg(
    "terminal.resize",
    z.object({ cols: z.number().int().positive(), rows: z.number().int().positive() }),
  ),
  // Output
  msg("terminal.output", z.object({ data: z.string() })),
  msg(
    "terminal.snapshot",
    z.object({ data: z.string(), cols: z.number().int(), rows: z.number().int() }),
  ),
  // The agent's terminal changed size (someone resized it). Clients that draw it must follow.
  msg(
    "terminal.resized",
    z.object({ cols: z.number().int().positive(), rows: z.number().int().positive() }),
  ),
  msg("agent.status", z.object({ status: agentStatus })),
  // Permissions: request carries the exact command/action shown to the user.
  msg(
    "permission.request",
    z.object({ requestId: z.string(), tool: z.string(), command: z.string() }),
  ),
  msg(
    "permission.decision",
    z.object({
      requestId: z.string(),
      decision: z.enum(["allow", "deny"]),
      signature: z.string().optional(),
    }),
  ),
  msg(
    "permission.resolved",
    z.object({
      requestId: z.string(),
      decision: z.enum(["allow", "deny"]),
      reason: z.enum(["user", "timeout", "session_ended"]),
    }),
  ),
  // Pairing
  msg("pair.hello", z.object({ devicePublicKey: z.string(), token: z.string() })),
  msg(
    "pair.accept",
    z.object({ daemonPublicKey: z.string(), name: z.string().max(100).optional() }),
  ),
  msg("pair.revoke", z.object({ devicePublicKey: z.string() })),
  // Errors
  msg("error", z.object({ code: z.string(), message: z.string() })),
]);

export type Message = z.infer<typeof messageSchema>;
export type MessageType = Message["type"];

export function parseMessage(input: unknown): Message {
  return messageSchema.parse(input);
}

/** Platform-neutral ID (React Native may lack crypto.randomUUID). */
function newId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return c?.randomUUID
    ? c.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createMessage<T extends MessageType>(
  type: T,
  payload: Extract<Message, { type: T }>["payload"],
  opts: { id?: string; sessionId?: string } = {},
): Extract<Message, { type: T }> {
  return {
    v: PROTOCOL_VERSION,
    id: opts.id ?? newId(),
    ts: Date.now(),
    ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
    type,
    payload,
  } as Extract<Message, { type: T }>;
}
