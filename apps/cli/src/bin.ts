#!/usr/bin/env node
import { createRequire } from "node:module";
import { createInterface } from "node:readline/promises";
import { defaultRegistry, startDaemon } from "@airemo/daemon";
import { DEFAULT_DAEMON_PORT, resumeId } from "@airemo/protocol";
import { Command } from "commander";
import QRCode from "qrcode";
import { AGENT_NAMES_HELP, commandName, resolveAgent, unknownAgentMessage } from "./agents.js";
import {
  type AllowedFolder,
  allowFolder,
  daemonSupports,
  disallowFolder,
  formatDevice,
  formatFolder,
  type ManageIo,
  type Outcome,
  type PairedDevice,
  RESTART_DAEMON,
  unpairDevice,
} from "./manage-commands.js";
import { pick } from "./picker.js";
import { agentLabel, runSession } from "./run.js";
import { chooseSession, fetchSessions, formatSession } from "./sessions-command.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

const QUICK_GUIDE = `
Quick guide:
  1. airemo start --relay wss://<your-relay>   start the daemon (leave it running)
  2. airemo pair                               scan the QR code with the Airemo app
  3. airemo allow                              in a project folder: pick the agents
                                               your phone may start there
  4. airemo launch claude-code                 start Claude Code here
     airemo launch agent                       start Cursor here
     airemo resume claude-code                 pick an earlier Claude Code conversation
     airemo resume agent                       pick an earlier Cursor conversation
     (or start a session from the app)

  Manage:
     airemo allowed      list allowed folders    airemo disallow   remove one
     airemo devices      list paired devices     airemo unpair     remove one
     airemo sessions     running sessions        airemo attach     join one here

Run \`airemo <command> --help\` for a command's options.`;

const program = new Command()
  .name("airemo")
  .description("Airemo: run AI coding agents on this computer and control them from your phone")
  .version(version, "-v, --version", "show the Airemo version")
  .helpOption("-h, --help", "show the commands and a quick guide")
  .addHelpText("after", QUICK_GUIDE);

const portOption = ["-p, --port <port>", "daemon port", String(DEFAULT_DAEMON_PORT)] as const;
const base = (port: string) => `http://127.0.0.1:${port}`;
const isInteractive = () => Boolean(process.stdin.isTTY && process.stdout.isTTY);

/** Call the local daemon's HTTP API and fail with a helpful message if it is not running. */
async function daemonFetch(port: string, path: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(`${base(port)}${path}`, init);
  } catch {
    console.error("Could not reach the daemon. Run `airemo start` first.");
    process.exit(1);
  }
}

function manageIo(port: string): ManageIo {
  return {
    port: Number(port),
    interactive: isInteractive(),
    pick: (title, items, opts) =>
      pick({ stdin: process.stdin, stdout: process.stdout }, title, items, opts),
    installed: async () => {
      const found: Array<{ id: string; displayName: string; version?: string }> = [];
      for (const p of defaultRegistry().list()) {
        const r = await p.detect();
        if (r.installed) {
          found.push({
            id: p.id,
            displayName: p.displayName,
            ...(r.version ? { version: r.version } : {}),
          });
        }
      }
      return found;
    },
  };
}

function finish(outcome: Outcome): never {
  if (outcome.ok) {
    console.log(outcome.message);
    process.exit(0);
  }
  console.error(outcome.message);
  process.exit(outcome.code);
}

/** The plugin id for the agent named on the command line, or exit with a helpful message. */
function agentOrExit(name: string): string {
  const id = resolveAgent(name);
  if (id) return id;
  console.error(unknownAgentMessage(name));
  process.exit(1);
}

async function runInThisTerminal(
  agent: string,
  port: string,
  extra: { resume?: { id?: string } } = {},
): Promise<never> {
  const code = await runSession({
    agent,
    port: Number(port),
    cwd: process.cwd(),
    stdin: process.stdin,
    stdout: process.stdout,
    ...extra,
  });
  process.exit(code);
}

// ---------------------------------------------------------------- daemon

function keepAwakeLine(state: string): string {
  switch (state) {
    case "on":
      return "Keep awake: on (works with the screen locked; closing the lid still sleeps a laptop)";
    case "unsupported":
      return "Keep awake: not supported on this system; the computer may sleep";
    case "failed":
      return "Keep awake: failed; the computer may sleep";
    default:
      return "Keep awake: off (the computer may sleep; start with --keep-awake)";
  }
}

program
  .command("start")
  .description("Start the Airemo daemon on this computer")
  .option("-p, --port <port>", "port", String(DEFAULT_DAEMON_PORT))
  .option("--relay <url>", "relay for remote access (or set AIREMO_RELAY_URL)")
  .option("--no-require-approval", "do not force agents into ask-first mode")
  .option("--keep-awake", "keep the computer from idle sleep (default when --relay is set)")
  .option("--no-keep-awake", "let the computer sleep as usual")
  .action(
    async (o: { port: string; relay?: string; requireApproval: boolean; keepAwake?: boolean }) => {
      const relayUrl = o.relay ?? process.env.AIREMO_RELAY_URL;
      // A phone can only reach a computer that is awake, so remote access keeps it awake by default.
      const keepAwake = o.keepAwake ?? Boolean(relayUrl);
      const daemon = await startDaemon({
        port: Number(o.port),
        logger: true,
        requireApproval: o.requireApproval,
        keepAwake,
        ...(relayUrl ? { relayUrl } : {}),
      });
      console.log(`Daemon ID: ${daemon.identity.publicKey}`);
      console.log(
        relayUrl
          ? `Remote access via ${relayUrl}. Run \`airemo pair\` to connect a phone.`
          : "Remote access is off. Restart with --relay <url> to enable it.",
      );
      console.log(keepAwakeLine(daemon.keepAwake?.state ?? "off"));
      const stop = () => daemon.close().then(() => process.exit(0));
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
    },
  );

program
  .command("status")
  .description("Show daemon and relay status")
  .option(...portOption)
  .action(async (o: { port: string }) => {
    const s = (await (await daemonFetch(o.port, "/status")).json()) as {
      daemonId: string;
      relay: { url: string; status: string } | null;
      devices: number;
      projects: number;
      keepAwake?: string;
    };
    console.log(`Daemon ID: ${s.daemonId}`);
    console.log(s.relay ? `Relay: ${s.relay.url} (${s.relay.status})` : "Relay: not configured");
    console.log(`Paired devices: ${s.devices}`);
    console.log(`Allowed folders: ${s.projects}`);
    console.log(
      s.keepAwake ? keepAwakeLine(s.keepAwake) : "Keep awake: unknown (restart the daemon)",
    );
  });

program
  .command("doctor")
  .description("Check which supported agents are installed")
  .action(async () => {
    for (const p of defaultRegistry().list()) {
      const r = await p.detect();
      console.log(
        `${r.installed ? "ok " : "-- "} ${p.displayName}${r.version ? ` (${r.version})` : ""}  [airemo launch ${commandName(p.id)}]`,
      );
    }
  });

// ---------------------------------------------------------------- sessions

program
  .command("launch <agent>")
  .description(`Start a new agent session in this folder and terminal: ${AGENT_NAMES_HELP}`)
  .option(...portOption)
  .addHelpText(
    "after",
    "\nExamples:\n  airemo launch claude-code   Claude Code\n  airemo launch agent         Cursor\n\n" +
      "If the same agent is already running in this folder (for example started from your phone),\n" +
      "you are asked whether to join it instead.",
  )
  .action(async (name: string, o: { port: string }) => {
    await runInThisTerminal(agentOrExit(name), o.port);
  });

program
  .command("resume <agent> [id]")
  .description(
    `Resume an earlier conversation of an agent in this folder: ${AGENT_NAMES_HELP}. Without an id the agent shows its own list to pick from`,
  )
  .option("-r, --resume [id]", "same as giving the id (the agent's conversation id)")
  .option(...portOption)
  .addHelpText(
    "after",
    "\nExamples:\n  airemo resume claude-code            pick a Claude Code conversation\n" +
      "  airemo resume claude-code --resume   same\n" +
      "  airemo resume claude-code <id>       that conversation\n" +
      "  airemo resume agent                  pick a Cursor conversation",
  )
  .action(
    async (
      name: string,
      idArg: string | undefined,
      o: { port: string; resume?: string | boolean },
    ) => {
      const agent = agentOrExit(name);
      const flagId = typeof o.resume === "string" ? o.resume : undefined;
      if (idArg && flagId && idArg !== flagId) {
        console.error("Give the conversation id once.");
        process.exit(1);
      }
      const id = idArg ?? flagId;
      if (id !== undefined && !resumeId.safeParse(id).success) {
        console.error(`"${id}" is not a valid conversation id.`);
        process.exit(1);
      }
      const support = await daemonSupports(Number(o.port), "resume");
      if (support !== "yes") {
        console.error(
          support === "unreachable"
            ? "Could not reach the daemon. Run `airemo start` first."
            : `${RESTART_DAEMON}\n(It would ignore the resume request and start a fresh session.)`,
        );
        process.exit(1);
      }
      await runInThisTerminal(agent, o.port, { resume: id ? { id } : {} });
    },
  );

program
  .command("sessions")
  .description(
    "List the agent sessions running on this computer (including ones started from your phone)",
  )
  .option(...portOption)
  .action(async (o: { port: string }) => {
    const list = await fetchSessions(Number(o.port));
    if (list === null) {
      console.error("Could not reach the daemon. Run `airemo start` first.");
      process.exit(1);
    }
    const running = list.filter((s) => s.status !== "exited");
    if (running.length === 0) return console.log("No running sessions.");
    for (const s of running) console.log(formatSession(s));
  });

program
  .command("attach [id]")
  .description(
    "Join a running session in this terminal, for example one started from your phone. Both screens then show and control the same session",
  )
  .option(...portOption)
  .action(async (id: string | undefined, o: { port: string }) => {
    const sessions = await fetchSessions(Number(o.port));
    if (sessions === null) {
      console.error("Could not reach the daemon. Run `airemo start` first.");
      process.exit(1);
    }
    const choice = await chooseSession(id, sessions, {
      interactive: isInteractive(),
      ask: async (question) => {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        try {
          return await rl.question(question);
        } finally {
          rl.close();
        }
      },
    });
    if (!choice.ok) {
      console.error(choice.message);
      process.exit(1);
    }
    const code = await runSession({
      agent: choice.session.agent,
      port: Number(o.port),
      cwd: choice.session.cwd,
      stdin: process.stdin,
      stdout: process.stdout,
      attachTo: choice.session.id,
    });
    process.exit(code);
  });

// `airemo run` was replaced by `allow` + `launch`. Kept hidden so old habits get a pointer.
program
  .command("run [agent]", { hidden: true })
  .allowUnknownOption()
  .action((name: string | undefined) => {
    const id = name ? resolveAgent(name) : null;
    const launch = `airemo launch ${id ? commandName(id) : "claude-code"}`;
    console.error(
      "`airemo run` was replaced:\n" +
        `  ${launch.padEnd(28)}start ${id ? agentLabel(id) : "an agent"} in this terminal\n` +
        `  ${"airemo allow".padEnd(28)}let your phone use this folder (you pick the agents)`,
    );
    process.exit(1);
  });

// ---------------------------------------------------------------- folders

program
  .command("allow [path]")
  .description(
    "Let your phone start agents in a folder (default: this folder). You then pick which agents, at least one",
  )
  .option(...portOption)
  .option(
    "-a, --agent <name>",
    `skip the list and allow this agent: ${AGENT_NAMES_HELP} (repeat for more)`,
    (value: string, previous: string[]) => [...previous, value],
    [] as string[],
  )
  .action(async (path: string | undefined, o: { port: string; agent: string[] }) => {
    finish(await allowFolder(path, o.agent, manageIo(o.port)));
  });

program
  .command("allowed")
  .alias("projects")
  .description("List the folders your phone may use, and which agents")
  .option(...portOption)
  .action(async (o: { port: string }) => {
    const list = (await (await daemonFetch(o.port, "/projects")).json()) as AllowedFolder[];
    if (list.length === 0) {
      return console.log("No folders allowed. Run `airemo allow` in a project folder.");
    }
    for (const p of list) console.log(formatFolder(p));
  });

program
  .command("disallow [path]")
  .description("Stop your phone from using a folder. Without a path, pick one from the list")
  .option(...portOption)
  .action(async (path: string | undefined, o: { port: string }) => {
    finish(await disallowFolder(path, manageIo(o.port)));
  });

// ---------------------------------------------------------------- devices

program
  .command("pair")
  .description("Show a QR code to pair a phone with this computer")
  .option(...portOption)
  .action(async (o: { port: string }) => {
    const res = await daemonFetch(o.port, "/pairing", { method: "POST" });
    if (res.status === 409) {
      console.error("Remote access is off. Restart the daemon with `airemo start --relay <url>`.");
      process.exit(1);
    }
    if (!res.ok) {
      console.error(`Pairing failed (${res.status}).`);
      process.exit(1);
    }
    const { uri, expiresAt } = (await res.json()) as { uri: string; expiresAt: number };
    console.log(await QRCode.toString(uri, { type: "terminal", small: true }));
    console.log(
      "Scan this with the Airemo app. It works once and expires in " +
        `${Math.round((expiresAt - Date.now()) / 1000)} seconds.`,
    );
    console.log(`\n${uri}`);
    const projects = (await (await daemonFetch(o.port, "/projects")).json()) as unknown[];
    if (projects.length === 0) {
      console.log(
        "\nNote: no folders are allowed yet, so a phone cannot start agents.\n" +
          "Run `airemo allow` inside a project folder to allow it.",
      );
    }
  });

program
  .command("devices")
  .description("List paired devices and whether each is connected now")
  .option(...portOption)
  .action(async (o: { port: string }) => {
    const list = (await (await daemonFetch(o.port, "/devices")).json()) as PairedDevice[];
    if (list.length === 0) return console.log("No paired devices. Run `airemo pair`.");
    for (const d of list) console.log(formatDevice(d));
    if (list.some((d) => d.connected === undefined)) {
      console.log(`\nConnection status is not shown. ${RESTART_DAEMON}`);
    }
  });

program
  .command("unpair [device]")
  .description(
    "Remove a paired device (its id, the start of its id, or its name). Without one, pick from the list",
  )
  .option(...portOption)
  .action(async (device: string | undefined, o: { port: string }) => {
    finish(await unpairDevice(device, manageIo(o.port)));
  });

await program.parseAsync();
