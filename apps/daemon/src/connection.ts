import { createMessage, type Message, parseMessage } from "@airemo/protocol";
import type { PendingRequest, PermissionBroker, Resolution } from "./broker.js";
import type { Session } from "./session.js";
import type { SessionManager } from "./sessions.js";
import type { ProjectAllowlist } from "./stores.js";

export interface ConnectionDeps {
  sessions: SessionManager;
  broker: PermissionBroker;
}

export interface ConnectionOptions {
  projects?: ProjectAllowlist;
  /**
   * Only allow starting sessions inside allowlisted projects. On for remote devices; off for
   * the local user, who is already at the keyboard.
   */
  enforceProjects?: boolean;
}

export interface Connection {
  /** Handle one raw JSON message from the client. */
  handle(raw: string): Promise<void>;
  /** Stop forwarding events (the client went away or was revoked). */
  close(): void;
}

/**
 * Per-client message handling, shared by local WebSocket clients and encrypted remote
 * devices. `send` is how a reply reaches the client (plain on localhost, sealed for remote).
 */
export function createConnection(
  deps: ConnectionDeps,
  send: (m: Message) => void,
  options: ConnectionOptions = {},
): Connection {
  const { sessions, broker } = deps;
  const detach = new Map<string, () => void>();
  const error = (code: string, message: string, sessionId?: string) =>
    send(createMessage("error", { code, message }, sessionId ? { sessionId } : {}));

  const sendListing = () =>
    send(createMessage("session.listing", { sessions: sessions.summaries() }));
  // Keep every client's session list fresh: a session started, ended or changed elsewhere (for
  // example from the other device) shows up straight away instead of when next asked for.
  const stopWatching = sessions.onChange(sendListing);

  const sendRequest = (r: PendingRequest) =>
    send(
      createMessage(
        "permission.request",
        { requestId: r.requestId, tool: r.tool, command: r.command },
        { sessionId: r.sessionId },
      ),
    );

  const attach = (s: Session) => {
    if (!detach.has(s.id)) {
      const onOutput = (data: string) =>
        send(createMessage("terminal.output", { data }, { sessionId: s.id }));
      const onStatus = (status: Session["status"]) =>
        send(createMessage("agent.status", { status }, { sessionId: s.id }));
      const onExit = (exitCode: number | null) =>
        send(createMessage("session.exit", { exitCode }, { sessionId: s.id }));
      const onRequest = (r: PendingRequest) => {
        if (r.sessionId === s.id) sendRequest(r);
      };
      const onResolved = (r: PendingRequest, res: Resolution) => {
        if (r.sessionId !== s.id) return;
        send(
          createMessage(
            "permission.resolved",
            { requestId: r.requestId, decision: res.decision, reason: res.reason },
            { sessionId: s.id },
          ),
        );
      };
      const onResize = (cols: number, rows: number) =>
        send(createMessage("terminal.resized", { cols, rows }, { sessionId: s.id }));
      s.on("output", onOutput).on("status", onStatus).on("exit", onExit).on("resize", onResize);
      broker.on("request", onRequest).on("resolved", onResolved);
      detach.set(s.id, () => {
        s.off("output", onOutput)
          .off("status", onStatus)
          .off("exit", onExit)
          .off("resize", onResize);
        broker.off("request", onRequest).off("resolved", onResolved);
      });
    }
    // Always send the current screen, even on a repeat attach: a client that reopens a
    // session view needs it. It also gets any approvals that are still waiting.
    send(createMessage("terminal.snapshot", s.snapshot(), { sessionId: s.id }));
    for (const r of broker.pendingFor(s.id)) sendRequest(r);
  };

  return {
    async handle(raw) {
      let msg: Message;
      try {
        msg = parseMessage(JSON.parse(raw));
      } catch {
        return error("bad_message", "Invalid or unsupported message");
      }
      const sid = msg.sessionId;
      const session = sid ? sessions.get(sid) : undefined;

      try {
        switch (msg.type) {
          case "session.start": {
            let cwd = msg.payload.cwd;
            if (options.enforceProjects) {
              const check = options.projects?.check(cwd, msg.payload.agent) ?? {
                ok: false as const,
                reason: "folder" as const,
              };
              // For an unknown folder, one generic message: do not reveal what exists on the disk.
              // The phone already knows an allowed folder (it listed it), so saying the agent is
              // not allowed there reveals nothing.
              if (!check.ok) {
                return error(
                  "forbidden_path",
                  check.reason === "agent"
                    ? "That agent is not allowed in this folder"
                    : "Not an allowed project folder",
                );
              }
              cwd = check.path;
            }
            const s = await sessions.start(
              msg.payload.agent,
              cwd,
              msg.payload.cols,
              msg.payload.rows,
              [],
              msg.payload.resume,
            );
            send(
              createMessage("session.started", { agent: s.agent, pid: s.pid }, { sessionId: s.id }),
            );
            attach(s);
            break;
          }
          case "project.list":
            send(
              createMessage("project.listing", {
                projects: (options.projects?.list() ?? []).map((p) => ({
                  path: p.path,
                  name: p.name,
                  ...(p.agents ? { agents: p.agents } : {}),
                })),
              }),
            );
            break;
          case "session.list":
            sendListing();
            break;
          case "session.attach":
            if (!session) return error("no_session", "Unknown session", sid);
            attach(session);
            break;
          case "session.stop":
            if (!session) return error("no_session", "Unknown session", sid);
            session.stop();
            break;
          case "prompt.send":
            if (!session) return error("no_session", "Unknown session", sid);
            session.sendPrompt(msg.payload.text);
            break;
          case "terminal.input":
            if (!session) return error("no_session", "Unknown session", sid);
            session.write(msg.payload.data);
            break;
          case "permission.decision":
            if (!broker.decide(msg.payload.requestId, msg.payload.decision)) {
              return error("no_request", "Unknown or already resolved request", sid);
            }
            break;
          case "terminal.resize":
            if (!session) return error("no_session", "Unknown session", sid);
            // The phone sizes the shared session to its screen. Everyone attached is told.
            session.resize(msg.payload.cols, msg.payload.rows);
            break;
          default:
            error("unsupported", `Unsupported message type: ${msg.type}`, sid);
        }
      } catch (e) {
        error("failed", e instanceof Error ? e.message : String(e), sid);
      }
    },
    close() {
      stopWatching();
      for (const d of detach.values()) d();
      detach.clear();
    },
  };
}
