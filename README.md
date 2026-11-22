# Airemo

**One operating layer for your AI coding agents.**

> Airemo lets you launch, watch and approve the work of AI CLI agents such as
> Claude Code and Cursor from a single interface, including from your phone.
> The agents run on your own computer. Your code stays there.

> **Status: early development.** The core works and is tested: launching
> Claude Code through a daemon, streaming its terminal, approving or rejecting
> its commands, and controlling all of that remotely through an end-to-end
> encrypted relay after a QR pairing. The mobile app is not public yet (coming
> soon), and the project dashboard is not built. See
> [What works today](#what-works-today).

## Abstract

AI coding agents are powerful, but each one has its own interface, its own
sessions and its own permission prompts. Approving a command means sitting at
the computer. Plans and progress end up scattered across terminal windows.

Airemo is a local daemon plus a set of clients. The daemon starts agents in
real terminals, streams what they do, and holds every permission request until
you decide. The decision can come from any connected client. Over time the
clients grow into a mobile app and a web dashboard, and the daemon grows a
shared project plan that survives switching from one agent to another.

Three rules shape the design:

- **Local-first.** Agents and project files stay on your machine. A relay, when
  used for remote access, only forwards encrypted bytes it cannot read.
- **You approve.** An agent's command is shown to you exactly as written before
  it runs. If nobody decides, the answer is no.
- **You own the plan.** An agent saying "done" moves a task to review, never
  straight to complete.

## Why this exists

Developers now switch between Claude Code, Codex, Gemini CLI, Cursor, Goose and
Aider. That creates friction:

- Every tool has a different workflow, so sessions are hard to manage together.
- You can't check on an agent, or approve its commands, away from your desk.
- Switching agents loses the plan, the context and the progress.
- Expensive models get used for trivial tasks.

Airemo's goal is a single layer that sits above the agents and keeps the
control, the visibility and the plan on your side. Adding a new agent means
writing a plugin, not changing the core.

## What works today

| Area | State |
|---|---|
| Launch Claude Code through the daemon in a real terminal (PTY) | Working |
| Live terminal streaming over WebSocket, with screen snapshot on reconnect | Working |
| Permission approvals for Claude Code, showing the exact command | Working, verified against the real CLI |
| Default-deny on timeout, agent exit or an unreachable daemon | Working |
| Agents launched in ask-first mode, so your auto-approve settings cannot skip approvals | Working |
| QR pairing with a single-use token, key pinned from the QR | Working, verified with the real CLI |
| End-to-end encryption (Noise XX) with replay protection | Working, cross-checked against an independent Noise library |
| Self-hosted relay with device authentication, size and rate limits | Working |
| Paired device list and instant revocation | Working |
| Project allowlist: a phone can only start agents in folders you allowed | Working |
| Local daemon protected against web pages and DNS rebinding | Working |
| Cursor agent: launch, approvals showing the exact command (shell commands, file writes, deletes), reads outside the project need approval, default-deny | Working, verified against the real `cursor-agent` TUI (allow and deny) |
| Direct LAN connection (no relay) | Not built |
| Mobile app: pair by QR or link, computers and sessions, live terminal, prompts and key bar, approval sheet showing the exact command | Coming soon. Not public and not in this repository |
| Web dashboard, project plan, orchestrator | Not built (later phases) |

## Repository layout

```
airemo/
├── apps/
│   ├── cli/          # `airemo` command: start, launch, resume, attach, pair, allow, ...
│   ├── daemon/       # Core + agent runtime: sessions, PTY, permission broker
│   └── relay/        # Self-hosted relay that forwards encrypted frames
├── packages/
│   ├── protocol/     # Message schemas (Zod), shared by every client
│   ├── crypto/       # Identity, Noise handshake, encrypted channel, pairing
│   ├── plugin-sdk/   # The interface every agent plugin implements
│   ├── plugin-claude-code/   # Claude Code plugin and permission hook
│   ├── plugin-cursor/        # Cursor plugin and approval hook
│   ├── client/       # Reconnecting WebSocket client for mobile and web
│   ├── store/        # Task and project memory store (placeholder)
│   └── config/       # Shared TypeScript config
└── scripts/          # Install helpers
```

## Getting started

A step-by-step guide for running Airemo from source (terminal and phone) and a user manual for
after release are in [`MANUAL.md`](MANUAL.md), and [`QUICKSTART.md`](QUICKSTART.md) has the
shortest path. The short version follows.

```sh
git clone https://github.com/AiRemoLabs/airemo.git
cd airemo
```

**You need**

- Node.js 22 or newer
- [pnpm](https://pnpm.io) 11 (`corepack enable` is the easiest way)
- At least one supported agent CLI installed and signed in. Claude Code is the
  one that is fully wired up today.
- macOS or Linux. Windows is untested.

**Install and check**

```sh
pnpm install
pnpm build
pnpm typecheck
pnpm lint
pnpm test
```

`pnpm install` also runs a small script that fixes a file permission pnpm gets
wrong for `node-pty`. Without it, every terminal launch fails with
`posix_spawnp failed`.

## Using Airemo

The CLI is not published or linked globally yet, so run it from the repo after
`pnpm build`.

**See which agents are installed**

```sh
node apps/cli/dist/bin.js doctor
```

**Start the daemon** (listens on `127.0.0.1:47821`, this computer only)

```sh
node apps/cli/dist/bin.js start
```

**Launch an agent session** from another terminal, in the project you want the
agent to work on

```sh
cd path/to/your/project
node /path/to/airemo/apps/cli/dist/bin.js launch claude-code   # or: launch agent (Cursor)
node /path/to/airemo/apps/cli/dist/bin.js resume claude-code   # pick an earlier conversation
```

`airemo --help` (or `-h`) lists every command with a quick guide; `airemo --version` (or `-v`)
prints the version.

**Connect a phone through a relay**

The relay is a small server you run yourself. It forwards encrypted bytes and
cannot read them.

```sh
# 1. Run a relay (on a server for real use, or locally to try it)
PORT=8080 node apps/relay/dist/main.js

# 2. Start the daemon pointed at it
node apps/cli/dist/bin.js start --relay ws://127.0.0.1:8080

# 3. Open a project folder to your phone (nothing is open by default). `allow` lists the agents
#    installed on this computer; tick at least one with space, then press Enter
cd path/to/your/project && node /path/to/airemo/apps/cli/dist/bin.js allow

# 4. Show a pairing QR code for the Airemo app (the app is coming soon)
node /path/to/airemo/apps/cli/dist/bin.js pair
```

The code works once and expires after two minutes. Afterwards:

```sh
node apps/cli/dist/bin.js allowed            # folders a phone may use, and which agents
node apps/cli/dist/bin.js disallow [path]    # remove one (no path: pick from the list)
node apps/cli/dist/bin.js devices            # paired devices, and whether each is connected now
node apps/cli/dist/bin.js unpair [device]    # remove one (id, start of id or name; none: pick)
node apps/cli/dist/bin.js status             # daemon ID, relay connection, counts
```

`airemo allow --agent claude-code --agent agent` skips the list (needed in scripts, where there
is no terminal to pick in). Allowing a folder again starts with its current agents ticked and
replaces them. The limit applies to the phone only: the terminal can launch any agent anywhere.
The allowlist controls where a phone can *start* an agent. What the agent does once running is
still decided by the approvals you give. A device counts as connected while its encrypted channel
is open and it was heard from in the last 20 seconds (the app checks in every 5 seconds).

Use `wss://` with a real certificate when the relay is reachable from the
internet. Keys are stored in `~/.airemo` (readable only by you).

**Agents.** Claude Code and Cursor are both supported. Their names on the command line are
`claude-code` and `agent` (Cursor's CLI is `cursor-agent`; `cursor` also works): `airemo launch agent`.
`airemo resume claude-code` and `airemo resume agent` start the agent with `--resume`, so it shows
its own list of earlier conversations; `airemo resume claude-code <id>` (or `--resume <id>`) opens
one directly. Resume always starts a new session and is gated by approvals like any other. For
Cursor, Airemo adds a hook to the project's `.cursor/hooks.json` for the
length of the session (your existing hooks are kept, git is told to ignore the file, and it is
removed when the session ends). Your global Cursor config is never touched.

**The mobile app** is coming soon and is not part of this repository. In the
app you tap **Pair a computer** and scan the QR from `airemo pair`. The app
keeps its identity key in the phone's secure storage (Keychain or Keystore).

**How approvals work.** When Claude Code wants to run something it would
normally ask about, the daemon receives the exact command and holds it. A
client answers with a `permission.decision` message (`allow` or `deny`),
either on the daemon's local WebSocket at `ws://127.0.0.1:47821/ws` or from a
paired device through the relay. The mobile app does this for you, and so does
`airemo launch` (below).

**Sharing a session.** A session lives in the daemon, so your terminal and your phone can both
work on the same one: what you type on either shows on both, and the agent's answer shows on both.
`airemo sessions` lists running sessions, `airemo attach [id]` joins one in this terminal (for example
one you started from the phone), and `airemo launch claude-code` in a folder where it is already
running offers to join it instead of starting a second copy. On the phone, a folder lists its
running sessions (tap one to share it) and **New session** starts a separate one.
The phone never resizes a session: your computer's terminal keeps its size, and
the phone rewraps the output to fit its screen.

**Approvals in the terminal.** When an agent started with `airemo launch` or `airemo resume` wants
approval, a full-screen prompt takes over your terminal. It shows the agent and
the **full, exact command** (long ones scroll with the arrow keys). Press `y` to
allow, or `n`, Esc or Ctrl+C to reject. Nothing you type reaches the agent while
the prompt is up, and the prompt ignores keys for the first moment, so a `y` you
typed into the agent just before it appeared cannot answer a command you have not
seen. Pasted text never answers. Control characters and invisible or
direction-changing characters in a command are shown visibly, so a command cannot
disguise itself. When you answer, the agent's own screen comes back. If the same
approval is answered on your phone first, the prompt closes by itself. In a
terminal that is not interactive there is no prompt, and the request is rejected
after 120 seconds.

Good to know:

- Airemo starts Claude Code in ask-first mode, so auto mode is overridden for
  sessions it launches. Explicit allow rules in your Claude settings can still
  let some commands through without asking. Use `--no-require-approval` on
  `airemo start` to turn the ask-first mode off.
- The daemon only listens on localhost, and it refuses requests that come from
  web pages. Nothing is exposed to your network. Remote access goes out through
  the relay.
- With `--relay`, the daemon keeps the computer from idle sleep while it runs
  (`caffeinate` on macOS, `systemd-inhibit` on Linux), so your phone can still
  reach it with the screen locked. Closing a laptop's lid still puts it to
  sleep, and nothing runs while a computer sleeps. Use `--no-keep-awake` to let
  it sleep as usual; `airemo status` shows the current state. After the
  computer wakes, or if the relay link silently dies, the daemon notices within
  seconds and reconnects.

**Run the other apps in development**

```sh
pnpm --filter @airemo/daemon dev   # daemon with auto-reload
pnpm --filter @airemo/relay dev    # relay on port 8080
```

**Run a single test**

```sh
pnpm --filter @airemo/daemon exec vitest run -t "applies a deny decision"
```

## Contributing

Contributions are welcome. The project is young, so it helps to open an issue
or start a discussion before a large change.

1. Read [`CONTRIBUTING.md`](CONTRIBUTING.md).
2. Use pnpm, not npm or yarn.
3. Before you open a pull request, make sure these pass:
   `pnpm build && pnpm typecheck && pnpm lint && pnpm test`.
4. Add or update tests with the change. Fix formatting with `pnpm lint:fix`.
5. Keep the core agent-agnostic. The daemon must only talk to agents through
   the interface in `@airemo/plugin-sdk`. New agents are plugins.

**Adding an agent.** Implement `AgentPlugin` from `@airemo/plugin-sdk` (detect
the CLI, launch it, and route its permission requests to the daemon), then
register it. The guide is [`packages/plugin-sdk/README.md`](packages/plugin-sdk/README.md),
and `packages/plugin-claude-code` and `packages/plugin-cursor` are two working examples. Prefer an agent's own hooks or structured output over
scraping the terminal.

**Security.** Changes that touch pairing, encryption, the relay or the
permission flow need extra care. Never let an approval be bypassed, never let
the relay read content, and never make launch flags reachable from a remote
client. Please report vulnerabilities privately as described in
[`SECURITY.md`](SECURITY.md), not in a public issue.

## License

Airemo is licensed in two parts, so the code you run and trust stays open while
the hosted service can be a business.

| Part | License |
|---|---|
| Everything in this repository except the relay: the CLI, daemon, crypto, protocol, client library, plugin SDK and plugins | [Apache License 2.0](LICENSE) |
| The relay server in [`apps/relay`](apps/relay/LICENSE) | [Functional Source License 1.1, Apache 2.0 future license](apps/relay/LICENSE) (FSL-1.1-ALv2) |
| The Airemo mobile app and web dashboard | Not open source, and not in this repository |

In practice:

- You can use, modify and self-host everything, including the relay, for your
  own use, for education and for research.
- The relay's license does not allow offering it (or something substantially
  similar) to others as a competing commercial product or service. Two years
  after each release it becomes Apache 2.0 automatically.

## Trademark

"Airemo" and the Airemo logo are trademarks of Devakrishnan Gopal. The licenses above cover the
code, not the name or logo. You are welcome to fork, but a modified version must use a different
name and logo. You may say it works with, or is based on, Airemo. See [`TRADEMARKS.md`](TRADEMARKS.md).

Copyright 2026 Devakrishnan Gopal.
