# Quickstart

Run Airemo from source and drive an agent from your terminal, with every command shown to you for
approval first. For the full guide see [`MANUAL.md`](MANUAL.md).

> **The phone app is not public yet.** It is coming soon. Until then you can use Airemo from the
> terminal, and run your own relay and pairing code ready for the app.

## You need

- Node.js 22 or newer, and [pnpm](https://pnpm.io) 11 (`corepack enable`)
- Claude Code (`claude`) and/or Cursor (`cursor-agent`), installed and signed in
- macOS or Linux (Windows is untested)

## Steps

| # | Terminal | Directory | Command |
|---|---|---|---|
| 1 | T1 | anywhere | `git clone https://github.com/AiRemoLabs/airemo.git && cd airemo` |
| 2 | T1 | `airemo` | `pnpm install && pnpm build` |
| 3 | T1 | `airemo` | `node apps/cli/dist/bin.js doctor` (shows `ok` for each installed agent) |
| 4 | T1 (leave running) | `airemo` | `node apps/cli/dist/bin.js start` |
| 5 | T2 | `/path/to/your/project` | `node /path/to/airemo/apps/cli/dist/bin.js launch claude-code` (or `launch agent` for Cursor) |

When the agent wants to run something, a full-screen prompt shows the exact command. Press `y` to
allow, `n` or Esc to reject.

Tip: `alias airemo="node /path/to/airemo/apps/cli/dist/bin.js"` in `~/.zshrc` lets you type
`airemo ...` everywhere.

## Remote access (for the phone app)

The relay is a small server you run yourself. It forwards encrypted bytes and cannot read them.

| # | Terminal | Directory | Command |
|---|---|---|---|
| 1 | T1 (leave running) | `airemo` | `PORT=8080 HOST=0.0.0.0 node apps/relay/dist/main.js` |
| 2 | T2 (leave running) | `airemo` | `node apps/cli/dist/bin.js start --relay ws://<your-ip>:8080` |
| 3 | T3 | `airemo` | `node apps/cli/dist/bin.js status` (expect the relay to be `connected`) |
| 4 | T3 | `/path/to/your/project` | `airemo allow`, then tick agents with **space** (at least one) and press **Enter**. A phone can start nothing until a folder is allowed |
| 5 | T3 | anywhere | `airemo pair` (a QR code for the app; it works once and expires after 2 minutes) |

For a relay reachable from the internet, put it behind TLS and use `wss://`. The relay ships with a
`Dockerfile` (`apps/relay/Dockerfile`) and answers `/health`.

## Commands

`airemo --help` (or `-h`) shows these with a quick guide, `airemo --version` (or `-v`) the version.

| Command | What it does |
|---|---|
| `airemo start [--relay wss://...]` | Start the daemon (leave it running). With a relay it keeps the computer awake so a phone works with the screen locked; keep the lid open |
| `airemo status` | Daemon ID, relay connection, counts |
| `airemo doctor` | Which agents are installed |
| `airemo launch claude-code` / `launch agent` | New Claude Code / Cursor session in this folder |
| `airemo resume claude-code` / `resume agent` | Resume an earlier conversation: the agent shows its own list. Add an id (or `--resume <id>`) to open one directly |
| `airemo sessions` / `airemo attach [id]` | List running sessions / join one in this terminal |
| `airemo pair` | QR code to pair a phone (once, 2 minutes) |
| `airemo allow [path]` | Let a phone use a folder; pick the agents (at least one). `--agent claude-code --agent agent` skips the list |
| `airemo allowed` | List allowed folders and their agents |
| `airemo disallow [path]` | Remove an allowed folder (no path: pick from the list) |
| `airemo devices` | List paired devices and whether each is connected now |
| `airemo unpair [device]` | Remove a device by name or id (none: pick from the list); it is cut off at once |

## Notes

- To avoid passing `--relay` every time: `export AIREMO_RELAY_URL=wss://<your-relay>`, then
  `airemo start`.
- **After updating Airemo (`pnpm build`), restart `airemo start`.** A daemon started before the
  update keeps running the old code. It silently ignores what it does not know, so `resume` would
  just start a fresh session; `airemo resume` therefore checks first and tells you to restart.
