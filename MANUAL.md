# Airemo manual

Airemo lets you start, watch and control AI coding agents (Claude Code and Cursor) that run on
your own computer, from the terminal or from your phone. Every command an agent wants to run is
shown to you first, exactly as written, and nothing runs until you say yes.

**Which part should I read?**

| I want to... | Read |
|---|---|
| Run Airemo from the source code, to develop or test it | [Part 1: Development manual](#part-1-development-manual) |
| Use Airemo as an installed product, after it is released | [Part 2: User manual](#part-2-user-manual-after-release) |

## How the pieces fit together

```
   Your phone (Airemo app)                        Your computer
 ┌─────────────────────────┐   encrypted    ┌─────────────────────────────────┐
 │ watch, prompt, approve  │ ◄───────────►  │ airemo daemon  ──►  Claude Code │
 └────────────┬────────────┘     relay      │  (airemo start)     or Cursor   │
              │             ┌──────────┐     │        ▲                        │
              └────────────►│  relay   │◄────┘        │ airemo launch (term.)  │
                            │ (server) │              └────────────────────────│
                            └──────────┘
```

- The **daemon** (`airemo start`) runs on your computer and starts the agents. Your code stays there.
- The **relay** is a small server that passes encrypted messages between your phone and your
  computer. It cannot read them.
- The **terminal** (`airemo launch` / `airemo resume`) and the **phone app** are two windows onto
  the same sessions.
- `airemo --help` (or `-h`) lists every command with a quick guide; `airemo --version` (or `-v`)
  prints the version.

---

# Part 1: Development manual

How to run everything from the source code. The computer-side steps (the daemon, the relay, the
terminal and the approvals) have been run on a Mac.

> **The phone app is not public yet.** It is coming soon. This repository holds everything that runs
> on your computer, plus the relay. Until the app is out you can use Airemo from the terminal, and
> set up the relay and pairing ahead of time (see [1.4](#14-set-up-remote-access-for-the-phone)).

## 1.1 What you need

| Need | Details |
|---|---|
| Node.js 22 or newer | `node -v`. The repo pins `22` in `.nvmrc`. |
| pnpm 11 | `corepack enable` is the easiest way. Use pnpm, not npm. |
| An agent CLI | Claude Code (`claude`) and/or Cursor (`cursor-agent`), installed and signed in. |
| macOS or Linux | Windows is untested. |

## 1.2 One-time setup

```sh
git clone https://github.com/AiRemoLabs/airemo.git
cd airemo
pnpm install
pnpm build
```

Check that Airemo can see your agents:

```sh
node apps/cli/dist/bin.js doctor
```

You should see `ok` next to each agent you have installed.

**Optional, but saves typing:** make a short alias. Put this in `~/.zshrc` (change the path):

```sh
alias airemo="node /path/to/airemo/apps/cli/dist/bin.js"
```

The rest of this manual writes `airemo ...`. If you did not make the alias, write
`node apps/cli/dist/bin.js ...` from the repo folder instead.

> After you change code, run `pnpm build` again before trying the CLI.

## 1.3 Run it from the terminal only (no phone)

You need two terminal windows.

**Window 1: start the daemon**

```sh
airemo start
```

Leave it running. It prints a `Daemon ID` and says remote access is off, which is fine for now.

**Window 2: start an agent in your project**

```sh
cd path/to/some/project
airemo launch claude-code     # Claude Code.  For Cursor: airemo launch agent
```

To pick up an earlier conversation instead, use `airemo resume claude-code` (or
`airemo resume agent` for Cursor). The agent opens its own list of past conversations; choose one
with the arrow keys and Enter. `airemo resume claude-code <id>` (or `--resume <id>`) opens one
directly.

The agent opens in your terminal like normal. When it wants to do something that needs approval,
Airemo takes over the screen:

```
 Airemo: approval needed
 Claude Code wants to use Bash:

   git commit -m "fix the login bug"

 [y] Allow    [n] Reject (Esc)
```

- Press **y** to allow, **n** (or Esc, or Ctrl+C) to reject. Long commands scroll with the arrow keys.
- Nothing you type reaches the agent while the question is showing.
- Keys are ignored for a moment after it appears, so a stray keypress cannot answer it.
- When you answer, the agent's screen comes back.

To stop: end the agent as you normally would, then press **Ctrl+C** in window 1.

## 1.4 Set up remote access (for the phone)

The phone app is not public yet. These steps run the relay and make the pairing code the app will
scan. You need three terminal windows. To try it on your own network, the phone and the computer
need the same Wi-Fi; a relay on a server with `wss://` works across any network.

**Step 1. Find your computer's address on the Wi-Fi**

```sh
ipconfig getifaddr en0        # macOS. On Linux: hostname -I
```

Write it down, for example `192.168.1.20`. Use it wherever you see `<IP>` below.

**Step 2. Window 1: the relay**

```sh
PORT=8080 HOST=0.0.0.0 node apps/relay/dist/main.js
```

macOS may ask whether `node` may accept incoming connections. Choose **Allow**.

**Step 3. Window 2: the daemon, pointed at the relay**

```sh
airemo start --relay ws://<IP>:8080
```

Use your real address, not `localhost`: the phone has to be able to reach it. You should see
`Remote access via ws://<IP>:8080`. Check it with `airemo status` (it should say `connected`).

**Step 4. Window 3: open a project to your phone, then show the pairing code**

```sh
cd path/to/some/project
airemo allow          # lets your phone use THIS folder (nothing is allowed by default)
airemo pair           # shows the pairing QR code. It works once and expires after 2 minutes.
```

`airemo allow` then lists the agents installed on your computer. Move with the arrow keys, tick
with **space** (at least one), and press **Enter**:

```
Which agents may your phone use in /Users/you/project?
❯ ◉ Claude Code 2.1.325
  ◯ Cursor 2026.11.13
↑/↓ move · space select · a all · Enter confirm · Esc cancel
```

See [Which agents can my phone use in a folder?](#which-agents-can-my-phone-use-in-a-folder) below.

**Step 5. Pair the app (once it is available)**

In the app, tap **Pair a computer** and scan the code. The app shows the computer's key and the
relay address to check before pairing. How to use the app after that is described in
[Part 2](#24-everyday-use).

### Which agents can my phone use in a folder?

You decide per folder, with `airemo allow`:

| Run this in the folder | Your phone can use there |
|---|---|
| `airemo allow` | The agents you tick in the list (at least one) |
| `airemo allow --agent claude-code` | **Claude Code only** (no list; for scripts) |
| `airemo allow --agent agent` | **Cursor only** |
| `airemo allow --agent claude-code --agent agent` | Both |

- Allowing a folder **again** shows the list with its current agents already ticked, and your new
  choice replaces them. `airemo allowed` shows what each folder allows.
- `airemo disallow` removes a folder (give its path, or pick it from the list).
- Starting an agent in your terminal (`airemo launch`) does **not** open the folder to your phone.
- This limits **your phone only**. At your own keyboard you can still launch any agent anywhere.
- The app only offers the agents a folder allows, and shows them under each folder.

### Sharing one session between your computer and your phone

A session lives inside the Airemo daemon, and your terminal and your phone are two windows onto it.
When you both look at the **same** session:

- what you type on the phone shows on the computer, and what you type on the computer shows on the phone;
- the agent's answer shows on both;
- you can answer an approval on either one, and the other closes by itself;
- if you resize the computer window, the phone follows.

The phone's **New session** button and `airemo launch` each start their **own** session unless you
join one that is already running, so these are the ways to land in the same one:

| It was started on... | To work on it from the other side |
|---|---|
| **The phone** (**New session**) | On the computer run `airemo attach`. With several sessions running it asks which one; `airemo sessions` lists them with short ids, and `airemo attach <id>` joins one directly. |
| **The computer** (`airemo launch claude-code`) | On the phone open your computer, then the folder, and tap the session under **Active sessions**. **New session** always starts a separate one. |
| **The computer**, and you run `airemo launch` again in that folder | It asks "A Claude Code session is already running in this folder. Join it...? [Y/n]". Enter or `y` joins it; `n` starts a separate one. |

`airemo resume` always starts a new session (it never offers to join one).

Closing the terminal window only disconnects it. The agent keeps running and your phone can still
use it. To end a session, use **Stop** on the phone or end the agent in a terminal that is showing it.

## 1.5 Everyday development commands

| What | Command |
|---|---|
| Check code style | `pnpm lint` (fix: `pnpm lint:fix`) |
| Type check | `pnpm typecheck` |
| Build everything | `pnpm build` |
| Run all tests | `pnpm test` |
| Run one package's tests | `pnpm --filter @airemo/daemon test` |
| Run one test by name | `pnpm --filter @airemo/daemon exec vitest run -t "part of the name"` |
| Run the daemon with auto-reload | `pnpm --filter @airemo/daemon dev` |
| Run the relay with auto-reload | `pnpm --filter @airemo/relay dev` |

Before you open a pull request, run `pnpm lint && pnpm build && pnpm typecheck && pnpm test`.
The branch and pull request rules are in [`CONTRIBUTING.md`](CONTRIBUTING.md).

`airemo pair` also prints the pairing code as a text line under the QR (it starts with
`airemo://pair?`), for a device whose camera cannot scan it.

## 1.6 Where things are stored, and how to start fresh

Airemo keeps its data in `~/.airemo` (readable only by you):

| File | What it is |
|---|---|
| `identity.json` | This computer's secret key. Never share or copy it. |
| `devices.json` | Phones that are paired. |
| `projects.json` | Folders your phone may start agents in. |

Useful settings:

| Setting | What it does |
|---|---|
| `AIREMO_HOME=/some/folder` | Use a different data folder. Handy for a throwaway test setup. |
| `AIREMO_RELAY_URL=ws://<IP>:8080` | Same as `--relay`, so you do not have to type it. |
| `airemo start --port 4000` | Use a different daemon port (then add `-p 4000` to other commands). |
| `airemo start --no-require-approval` | Do not force agents into ask-first mode. Do not use this normally. |
| `airemo start --no-keep-awake` | Let the computer sleep as usual. By default, with `--relay`, the daemon blocks idle sleep so the phone works with the screen locked. Closing a laptop's lid still sleeps it. |
| `airemo start --keep-awake` | Block idle sleep even without `--relay`. |

To start completely fresh, stop the daemon, then `rm -rf ~/.airemo`. You will have to pair your
phone again.

## 1.7 Troubleshooting (development)

| What you see | Why | Fix |
|---|---|---|
| `Could not reach the daemon. Run airemo start first.` | The daemon is not running, or you used a different port. | Run `airemo start` in another window. If you used `--port`, pass `-p` here too. |
| `Remote access is off. Restart the daemon with airemo start --relay <url>` | You started the daemon without a relay. | Stop it and start again with `--relay ws://<IP>:8080`. |
| `airemo status` says the relay is `disconnected` or `connecting` | The relay is not running, or the address is wrong. | Check window 1 is running and the address matches exactly. |
| App: `Could not reach the relay` | The phone cannot reach `<IP>:8080`. | Same Wi-Fi? Firewall allowing `node`? Open `http://<IP>:8080/health` in the phone's browser: it should show `{"ok":true,...}`. |
| App: `Your computer is not connected to the relay` | The daemon is not connected to the same relay. | Restart `airemo start --relay ...` with the same address, then run `airemo pair` again. |
| App: `Pairing was refused. The code may have expired or already been used` | Codes work once and last 2 minutes. | Run `airemo pair` again and scan the new code. |
| App: `Security check failed: that computer's key does not match` | The code was not made by the computer you are connecting to. | Stop. Run `airemo pair` yourself on your own computer and scan that. |
| App: `This phone is no longer paired with that computer` | The phone was removed with `airemo unpair`. | Pair again. |
| App or CLI: `Not an allowed project folder` | The folder is not on the allowed list. | In that folder run `airemo allow`. See `airemo allowed`. |
| App or CLI: `That agent is not allowed in this folder` | The folder is open to your phone for a different agent. | In that folder run `airemo allow` and tick that agent too. `airemo allowed` shows what is allowed. |
| `Claude Code CLI is not installed` (or Cursor) | The agent is not on your PATH. | Run `airemo doctor`. Install the agent and sign in. |
| `posix_spawnp failed` when an agent starts | A file permission was not restored after install. | Run `pnpm install` again. |
| `.cursor/hooks.json is not valid JSON ... cannot add its approval hook` | The project's own Cursor hooks file is broken. | Fix or remove that file, then start again. Airemo will not start an agent it cannot gate. |
| Commands run without asking | Your own agent settings allow them (for example allow rules in Claude settings). | Airemo only asks about what the agent would ask about. Tighten those rules. |
| Cursor shows a second "Run this command?" | Cursor asks its own question after you approve. | Airemo answers it for you only when it is clearly for the command you approved. If it stays, answer it yourself. |
| What I type on the phone does not show on my computer (or the other way round) | You are looking at two different sessions: the phone's **New session** and `airemo launch` each start their own. | Join the same one: on the computer `airemo attach` (`airemo sessions` lists them); on the phone open the folder and tap the session under **Active sessions**. |

## 1.8 Not tested yet

So you know what to expect:

- The phone app is not public yet and has not been run on a real phone. Expect rough edges when it
  arrives, and tell us what you find.
- Plain `ws://` addresses may be blocked by iOS in some cases. A real deployment uses `wss://`.
- Windows has not been tested.

---

# Part 2: User manual (after release)

> **Status: not released yet.** This part describes how Airemo will work for people who install
> it. The commands below already exist, but there is no public install, no app-store app and no
> hosted relay yet. Until then, use [Part 1](#part-1-development-manual). Places that depend on
> the release are marked **(at release)**.

## 2.1 What you need

| Need | Details |
|---|---|
| A computer | macOS or Linux, with Node.js 22 or newer. |
| An agent | Claude Code and/or Cursor's CLI (`cursor-agent`), installed and signed in. |
| A phone (optional) | iPhone or Android with the Airemo app **(at release)**. |
| A relay address | Needed only for the phone. Given to you by whoever runs your relay, or your own. Looks like `wss://relay.example.com`. |

You do not need the phone to use Airemo from the terminal.

## 2.2 Install

```sh
npm install -g airemo        # (at release)
airemo doctor                # shows which agents Airemo found
```

`doctor` should show `ok` next to the agents you use. If not, install and sign in to the agent first.

## 2.3 First-time setup (about 5 minutes)

**On your computer**

1. **Start Airemo.** Keep this terminal window open.
   ```sh
   airemo start --relay wss://<relay-address>
   ```
   To avoid typing the address every time, put this in your shell profile and run just
   `airemo start`:
   ```sh
   export AIREMO_RELAY_URL=wss://<relay-address>
   ```
2. **Choose which project your phone may use, and with which agents.** Open a second terminal, go
   to your project and run:
   ```sh
   cd path/to/your/project
   airemo allow
   ```
   It lists the agents installed on your computer. Tick the ones your phone may start here with
   **space** (at least one) and press **Enter**. Your phone can only start agents in folders you have
   allowed this way, and only the agents you ticked. Repeat for other projects. Running
   `airemo allow` again in a folder lets you change the agents. This limits your phone only: at your
   own keyboard you can launch any agent anywhere.
3. **Show the pairing code.**
   ```sh
   airemo pair
   ```
   A QR code appears. It works **once** and expires after **2 minutes**.

**On your phone**

4. Open the Airemo app and tap **Pair a computer**. Allow the camera and scan the QR code.
5. The app shows the **computer key** and the **relay address**. Check they look right, then tap **Pair**.

Done. You will not need to pair again unless you remove the phone.

## 2.4 Everyday use

### From your phone

1. Make sure `airemo start` is running on your computer.
2. Open the app. The home page lists your paired computers (the sun / moon button at the top
   switches between dark and light). Tap your computer.
3. You see the folders you allowed, with their agents and how many sessions run in each. Tap one.
4. The folder shows its active sessions: tap one to open it, or tap **New session** and pick an agent
   to start a new one there.
5. Type a message under the terminal and tap the send button. Watch the agent work. Just above the
   message box there is a key bar (Esc, Tab, arrows, Enter, Ctrl+C) for agents that ask for those keys.
6. To end a session, tap **Stop** at the top.

Sessions you start on your computer also appear in the app, under their folder (or under **Other
sessions** on the computer's page, if they run outside every allowed folder), so you can pick them
up from your phone.

> The phone never resizes the session, so your computer's terminal keeps its size. The app rewraps
> the agent's output to fit the phone's width, so you never scroll sideways. Drag up and down on the
> terminal to read earlier output. Scrolling only moves the phone's own view: the session on your
> computer does not scroll. (For this, Airemo starts Claude Code with its classic renderer instead
> of fullscreen, so its conversation stays in the terminal's normal scrollback on both screens.)
>
> The app lists only **running** sessions; a session that has ended disappears from the list.
> The keys and the message box float at the bottom of the screen, just above the phone's buttons, and sit directly above the keyboard when it opens.

### From the terminal

```sh
cd path/to/your/project
airemo launch claude-code       # a new Claude Code session
airemo launch agent             # a new Cursor session

airemo resume claude-code       # pick an earlier Claude Code conversation
airemo resume agent             # pick an earlier Cursor conversation
airemo resume claude-code <id>  # or open one directly (same as --resume <id>)
```

The agent runs in your terminal. When it needs approval, a prompt appears (see below).

### Sharing one session between your computer and your phone

A session lives inside the Airemo daemon, and your terminal and your phone are two windows onto it.
When you both look at the **same** session:

- what you type on the phone shows on the computer, and what you type on the computer shows on the phone;
- the agent's answer shows on both;
- you can answer an approval on either one, and the other closes by itself;
- if you resize the computer window, the phone follows.

The phone's **New session** button and `airemo launch` each start their **own** session unless you
join one that is already running, so these are the ways to land in the same one:

| It was started on... | To work on it from the other side |
|---|---|
| **The phone** (**New session**) | On the computer run `airemo attach`. With several sessions running it asks which one; `airemo sessions` lists them with short ids, and `airemo attach <id>` joins one directly. |
| **The computer** (`airemo launch claude-code`) | On the phone open your computer, then the folder, and tap the session under **Active sessions**. **New session** always starts a separate one. |
| **The computer**, and you run `airemo launch` again in that folder | It asks "A Claude Code session is already running in this folder. Join it...? [Y/n]". Enter or `y` joins it; `n` starts a separate one. |

Closing the terminal window only disconnects it. The agent keeps running and your phone can still
use it. To end a session, use **Stop** on the phone or end the agent in a terminal that is showing it.

## 2.5 Approvals

Whenever an agent wants to run a command, change a file or do something else that needs your
permission, you are asked first. The question shows the **full, exact action**, and nothing runs
until you answer.

| Where | What you see | How to answer |
|---|---|---|
| Phone | An **Approval needed** sheet with the full command and a countdown | **Allow** or **Deny** |
| Terminal (`airemo launch` / `resume` / `attach`) | A full-screen prompt with the full command | **y** to allow. **n**, Esc or Ctrl+C to reject. Arrow keys scroll long commands. |

Good to know:

- If you do not answer in time, the request is **rejected**. Nothing runs by default.
- If you answer on your phone, the prompt in your terminal closes, and the other way round.
- Look at the **whole** command before you approve. Hidden or odd characters are shown visibly.
- Reading files inside your project does not ask. Reading files outside it does (Cursor).
- Airemo asks about what the agent would ask about. If your own agent settings already allow
  something without asking, Airemo will not ask about it either.

## 2.6 Managing projects and phones

| I want to... | Command |
|---|---|
| See all commands and a quick guide | `airemo --help` (or `-h`) |
| See the version | `airemo --version` (or `-v`) |
| See which folders my phone can use, and which agents | `airemo allowed` |
| Open another folder to my phone | `cd` into it, then `airemo allow` and tick the agents |
| Change which agents a folder allows | `airemo allow` again in the folder: its current agents are ticked, your new choice replaces them |
| Stop allowing a folder | `airemo disallow` (pick from the list) or `airemo disallow path/to/folder` |
| See my paired phones, and which are connected now | `airemo devices` |
| Remove a phone | `airemo unpair` (pick from the list), or `airemo unpair <name or id>` |
| Check that everything is connected | `airemo status` |

**Lost or sold a phone?** Run `airemo unpair` and pick that phone. It is cut off immediately, even
if the app is open on it.

Removing a computer in the app only forgets it on the phone. To block the phone from the
computer's side, use `airemo unpair`.

## 2.7 If something goes wrong

| What you see | What to do |
|---|---|
| App says your computer is **offline** | `airemo start` is not running, or it is using a different relay address. Start it and check `airemo status`. |
| Pairing code is refused | Codes work once and expire after 2 minutes. Run `airemo pair` again. |
| `Not an allowed project folder` | Go to that folder on your computer and run `airemo allow`. |
| `That agent is not allowed in this folder` | The folder is open to your phone for a different agent. In that folder run `airemo allow` and tick that agent too. |
| `Could not reach the daemon` | Run `airemo start` first. |
| The app says it is no longer paired | The phone was removed. Pair it again with `airemo pair`. |
| `Security check failed` in the app | Do not continue. Make a new code with `airemo pair` on your own computer. |
| An agent is not found | Run `airemo doctor`, then install and sign in to that agent. |
| It asked nothing, but I expected a question | Your agent's own settings allow that action. Airemo only adds a question where the agent would ask. |

## 2.8 Privacy and security

- **Your code stays on your computer.** Agents run there. Nothing is uploaded to Airemo servers.
- **The relay cannot read anything.** Everything between your phone and your computer is
  end-to-end encrypted. The relay only sees that two devices are talking, and when.
- **Pairing is protected.** The code works once, expires after 2 minutes, and the phone checks
  the computer's key before it shares anything. A fake computer is detected.
- **Nothing runs without your approval,** and a missing answer means "no".
- **Your phone only reaches folders you allowed,** and you can cut a phone off at any time.
- **Keys stay with you.** The computer's key is in `~/.airemo` (readable only by you). The phone's
  key is in the phone's secure storage and is never sent anywhere.
- **Cursor:** while a Cursor session runs, Airemo adds a hook to that project's `.cursor/hooks.json`
  to ask you first. It keeps any hooks you already have, tells git to ignore the file, and removes
  its entry when the session ends. Your global Cursor settings are never touched.

## 2.9 Uninstall

1. Stop Airemo (Ctrl+C in the window running `airemo start`).
2. `npm uninstall -g airemo`
3. Optionally delete your data: `rm -rf ~/.airemo` (this removes the computer's key and all pairings).
4. Delete the app from your phone.

## 2.10 Known limits

- Airemo runs in a terminal window: keep `airemo start` open. A background service that starts
  with your computer is not built yet.
- Your phone reaches your computer through a relay. A direct connection on the same network is not
  built yet.
- The computer's key is stored in a file (permissions: only you), not in the system keychain.
- Windows has not been tested.
