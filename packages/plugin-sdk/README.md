# @airemo/plugin-sdk

The interface every agent plugin implements. The daemon talks to agents **only** through
`AgentPlugin`; it never imports a specific agent. Adding an agent (Codex, Gemini CLI, Aider, Goose,
...) means writing a plugin, not changing the core.

Two working plugins to copy from:

- [`packages/plugin-claude-code`](../plugin-claude-code): approvals through Claude Code's
  `PermissionRequest` hook, passed in with `--settings`.
- [`packages/plugin-cursor`](../plugin-cursor): approvals through a project-level
  `.cursor/hooks.json` written in `prepare()` and removed on exit, plus `afterAllow()` to answer
  Cursor's own prompt.

## The interface

```ts
interface AgentPlugin {
  id: string;                    // stable id, e.g. "claude-code"
  displayName: string;           // shown to people, e.g. "Claude Code"
  capabilities: { structuredOutput: boolean; permissionHooks: boolean; pauseResume: boolean };
  detect(): Promise<DetectResult>;          // is the CLI installed? (detectCli helps)
  launch(opts: LaunchOptions): SpawnSpec;   // command, args, env and cwd to run in a PTY
  prepare?(opts): Cleanup | undefined;      // optional set-up before start; throw to refuse
  afterAllow?(ctx): Promise<void>;          // optional, after the user allowed an action
  parseOutput(chunk: string): AgentEvent[]; // may return [] (both current plugins do)
  respondToPermission(requestId, decision): string | null; // may return null if hooks answer
}
```

Helpers: `detectCli(command)` runs `<command> --version`; `resumeArgs(opts.resume)` builds
`--resume [id]` (put it **last** in the args); `replayFixture(plugin, chunks)` runs recorded output
through `parseOutput` in tests.

## How approvals work

This is the part that matters most. The agent must ask Airemo before it acts, and the answer
must default to **deny**.

1. The daemon starts the session with three environment variables: `AIREMO_DAEMON_URL`,
   `AIREMO_SESSION_ID` and `AIREMO_HOOK_TOKEN`. Pass `opts.env` through in `launch()`.
2. Configure the agent's own hook mechanism (a settings flag, a config file written in `prepare()`)
   to run a small script whenever the agent wants to use a tool.
3. The script POSTs `{ sessionId, tool, command }` to `${AIREMO_DAEMON_URL}/hooks/permission` with
   the header `x-airemo-token: ${AIREMO_HOOK_TOKEN}`, and waits. The response is
   `{ decision: "allow" | "deny", message? }`. `command` must be the **exact** action (the full
   shell command, the file and content being written), because that is what the user approves.
4. The script answers the agent in its own format. If the variables are missing (not an Airemo
   session) it must do nothing. If the daemon cannot be reached or answers badly, it must **deny**.

See `packages/plugin-claude-code/hook/permission-hook.mjs` for a complete example (about 50 lines).

## Rules a plugin must follow

- **Never start ungated.** If `prepare()` cannot install the hook (for example a config file it
  cannot parse), throw. A session that cannot be gated must not start.
- **Honour `requireApproval`.** When it is true, launch the agent in its ask-first mode, so a
  user's auto-approve setting cannot skip Airemo.
- **Never accept launch flags from a remote client.** `opts.args` comes from the local computer
  only. Resume is the typed `opts.resume`, never raw args.
- **Leave the user's files as they were.** Anything `prepare()` writes is removed or restored byte
  for byte by the returned cleanup, and the user's global agent config is never touched.
- **`afterAllow` must be fail-safe.** Only answer an agent's own prompt when you recognise that
  exact prompt for that exact command; otherwise do nothing and leave it for the user.

## Registering a new plugin

1. Create `packages/plugin-<name>` (copy `plugin-claude-code`'s `package.json` and `tsconfig.json`).
2. Register it in `apps/daemon/src/server.ts` (`new PluginRegistry().register(...)`) and add the
   package to `apps/daemon/package.json`.
3. Add the names people type to `apps/cli/src/agents.ts` (`ALIASES`, `commandName`,
   `AGENT_NAMES_HELP`) and its label to `agentLabel` in `apps/cli/src/run.ts`.
4. Add tests: `launch()` args (including `requireApproval` and `resume`), the hook's allow, deny and
   daemon-unreachable cases, and `prepare()` cleanup.
5. Document it in `README.md` and `MANUAL.md`.

Open an issue first (there is a "New agent plugin" template), so we can agree on how approvals
will be wired for that agent.
