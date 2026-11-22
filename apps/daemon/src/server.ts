import { randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import type { Identity } from "@airemo/crypto";
import { claudeCodePlugin } from "@airemo/plugin-claude-code";
import { cursorPlugin } from "@airemo/plugin-cursor";
import { PluginRegistry } from "@airemo/plugin-sdk";
import { DEFAULT_DAEMON_PORT, type Message } from "@airemo/protocol";
import fastifyWebsocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import { PermissionBroker } from "./broker.js";
import { createConnection } from "./connection.js";
import { KeepAwake } from "./keep-awake.js";
import { RemoteHub } from "./remote.js";
import { SessionManager } from "./sessions.js";
import {
  DeviceRegistry,
  defaultDataDir,
  loadOrCreateIdentity,
  ProjectAllowlist,
} from "./stores.js";

export interface DaemonOptions {
  port?: number;
  /** Defaults to localhost only. */
  host?: string;
  registry?: PluginRegistry;
  logger?: boolean;
  /** Pending permission requests are denied after this long. Default 120s. */
  permissionTimeoutMs?: number;
  /** Where keys and paired devices are stored. Default ~/.airemo (or $AIREMO_HOME). */
  dataDir?: string;
  /** Relay to use for remote access, e.g. wss://relay.example.com. Remote access is off without it. */
  relayUrl?: string;
  /** Launch agents so they ask before acting. Default true. */
  requireApproval?: boolean;
  /** Browser origins allowed to open the local WebSocket. Default none: only non-browser clients. */
  allowedOrigins?: string[];
  /** Block idle sleep while the daemon runs, so a phone can reach it on a locked screen. Default false. */
  keepAwake?: boolean;
  /** Push notification delivery. Only used for phones that opted in. Tests inject `fetch`. */
}

export interface Daemon {
  app: FastifyInstance;
  sessions: SessionManager;
  broker: PermissionBroker;
  identity: Identity;
  devices: DeviceRegistry;
  projects: ProjectAllowlist;
  /** Null when no relay is configured. */
  remote: RemoteHub | null;
  /** Secret the agent hooks present to /hooks/permission. */
  hookToken: string;
  registry: PluginRegistry;
  port: number;
  keepAwake: KeepAwake | null;
  close(): Promise<void>;
}

/** Reported by `GET /status`. Add a name here when a client needs to know a daemon supports something. */
export const DAEMON_FEATURES = ["resume", "device-presence", "keep-awake"] as const;

export function defaultRegistry(): PluginRegistry {
  return new PluginRegistry().register(claudeCodePlugin).register(cursorPlugin);
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export async function startDaemon(opts: DaemonOptions = {}): Promise<Daemon> {
  const registry = opts.registry ?? defaultRegistry();
  const sessions = new SessionManager(registry);
  sessions.requireApproval = opts.requireApproval ?? true;
  const broker = new PermissionBroker(opts.permissionTimeoutMs);
  const hookToken = randomBytes(32).toString("hex");

  const dataDir = opts.dataDir ?? defaultDataDir();
  const identity = loadOrCreateIdentity(dataDir);
  const devices = new DeviceRegistry(join(dataDir, "devices.json"));
  const projects = new ProjectAllowlist(join(dataDir, "projects.json"));

  sessions.onCreate = (s) =>
    s.on("exit", () => {
      // An agent that exits can no longer act on a pending approval: deny it.
      broker.denyAll(s.id);
    });

  // Keep the session status in step with pending approvals.
  broker.on("request", (req) => {
    const s = sessions.get(req.sessionId);
    s?.setStatus("awaiting_approval");
  });
  broker.on("resolved", (req, res) => {
    const s = sessions.get(req.sessionId);
    // Let the agent's plugin confirm the agent's own follow-up prompt, if it has one.
    if (s && res.decision === "allow" && res.reason === "user") {
      void registry
        .get(s.agent)
        ?.afterAllow?.({
          sessionId: s.id,
          tool: req.tool,
          command: req.command,
          screen: () => s.screenText(),
          write: (data) => {
            if (s.status !== "exited") s.write(data);
          },
        })
        .catch(() => {});
    }
    if (s && s.status === "awaiting_approval" && broker.pendingFor(s.id).length === 0) {
      s.setStatus("running");
    }
  });

  const app = Fastify({ logger: opts.logger ?? false });
  await app.register(fastifyWebsocket);

  // The daemon controls agents that can run commands, so only local, non-browser callers may
  // reach it. A Host check blocks DNS rebinding; an Origin check blocks any web page (cross-site
  // WebSocket hijacking), since browsers can open WebSockets to localhost.
  const allowedOrigins = new Set(opts.allowedOrigins ?? []);
  app.addHook("onRequest", async (req, reply) => {
    const host = String(req.headers.host ?? "").replace(/:\d+$/, "");
    if (!LOOPBACK_HOSTS.has(host)) return reply.code(403).send({ error: "forbidden_host" });
    const origin = req.headers.origin;
    if (origin && !allowedOrigins.has(origin)) {
      return reply.code(403).send({ error: "forbidden_origin" });
    }
  });

  const deps = { sessions, broker };
  const remote = opts.relayUrl
    ? new RemoteHub({
        identity,
        relayUrl: opts.relayUrl,
        registry: devices,
        projects,
        deps,
        log: (m) => app.log.info(m),
      })
    : null;

  const keepAwake = opts.keepAwake ? new KeepAwake({ log: (m) => app.log.warn(m) }) : null;

  app.get("/health", async () => ({ ok: true }));

  app.get("/status", async () => ({
    daemonId: identity.publicKey,
    relay: remote ? { url: remote.relayUrl, status: remote.status } : null,
    devices: devices.list().length,
    projects: projects.list().length,
    // What this daemon understands. An older daemon silently drops message fields it does not
    // know (for example `resume`), so the CLI checks this before relying on one.
    features: DAEMON_FEATURES,
    keepAwake: keepAwake?.state ?? "off",
  }));

  // Called by an agent's permission hook. Blocks until a client decides (or timeout -> deny).
  app.post<{ Body: { sessionId?: string; tool?: string; command?: string } }>(
    "/hooks/permission",
    async (req, reply) => {
      const given = Buffer.from(String(req.headers["x-airemo-token"] ?? ""));
      const want = Buffer.from(hookToken);
      if (given.length !== want.length || !timingSafeEqual(given, want)) {
        return reply.code(401).send({ error: "unauthorized" });
      }
      const { sessionId, tool, command } = req.body ?? {};
      if (!sessionId?.length || !tool || !command || !sessions.get(sessionId)) {
        return reply.code(400).send({ error: "bad_request" });
      }
      const r = await broker.request(sessionId, tool, command);
      return {
        decision: r.decision,
        message:
          r.decision === "allow"
            ? undefined
            : r.reason === "timeout"
              ? "No decision was made in time, so the request was denied"
              : r.reason === "session_ended"
                ? "The session ended before a decision was made"
                : "Denied by the user via Airemo",
      };
    },
  );

  // Pairing and device management: local only (loopback + no browser origin, see the hook above).
  app.post("/pairing", async (_req, reply) => {
    if (!remote) return reply.code(409).send({ error: "relay_not_configured" });
    return { ...remote.createPairing(), daemonId: identity.publicKey };
  });

  // Local only (the Host/Origin guard above). Used by `airemo sessions` and `airemo attach`.
  app.get("/sessions", async () => sessions.summaries());

  // Each paired device, with whether it is connected through the relay at this moment.
  app.get("/devices", async () => {
    const online = remote?.connectedDevices() ?? new Set<string>();
    return devices.list().map((d) => ({ ...d, connected: online.has(d.id) }));
  });

  app.delete<{ Params: { id: string } }>("/devices/:id", async (req, reply) => {
    return devices.remove(req.params.id)
      ? reply.code(204).send()
      : reply.code(404).send({ error: "not_found" });
  });

  app.get("/projects", async () => projects.list());

  // Body: { path, agents? }. `agents` omitted or null means every agent; a list restricts the phone
  // to those agents in that folder. Allowing a folder again replaces its agents.
  app.post<{ Body: { path?: string; agents?: string[] | null } }>(
    "/projects",
    async (req, reply) => {
      const agents = req.body?.agents ?? null;
      if (agents !== null) {
        if (!Array.isArray(agents) || agents.some((a) => typeof a !== "string")) {
          return reply.code(400).send({ error: "agents must be a list of agent names" });
        }
        const unknown = agents.find((a) => !registry.get(a));
        if (unknown !== undefined)
          return reply.code(400).send({ error: `Unknown agent: ${unknown}` });
      }
      try {
        return projects.add(String(req.body?.path ?? ""), agents);
      } catch (e) {
        return reply.code(400).send({ error: e instanceof Error ? e.message : "bad_request" });
      }
    },
  );

  app.delete<{ Querystring: { path?: string } }>("/projects", async (req, reply) => {
    return projects.remove(String(req.query.path ?? ""))
      ? reply.code(204).send()
      : reply.code(404).send({ error: "not_found" });
  });

  app.get("/ws", { websocket: true }, (socket) => {
    // The local user is at the keyboard, so the project allowlist is not enforced here.
    const conn = createConnection(deps, (m: Message) => socket.send(JSON.stringify(m)), {
      projects,
    });
    socket.on("message", (raw: Buffer) => {
      void conn.handle(raw.toString());
    });
    socket.on("close", () => conn.close());
  });

  const port = opts.port ?? DEFAULT_DAEMON_PORT;
  await app.listen({ port, host: opts.host ?? "127.0.0.1" });
  const address = app.server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  sessions.hookContext = { daemonUrl: `http://127.0.0.1:${actualPort}`, token: hookToken };
  remote?.start();
  keepAwake?.start();

  return {
    app,
    sessions,
    broker,
    identity,
    devices,
    projects,
    remote,
    hookToken,
    registry,
    port: actualPort,
    keepAwake,
    close: async () => {
      keepAwake?.stop();
      remote?.stop();
      for (const sess of sessions.list()) broker.denyAll(sess.id);
      sessions.stopAll();
      sessions.dispose();
      await app.close();
    },
  };
}
