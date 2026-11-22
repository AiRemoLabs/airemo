import { fileURLToPath } from "node:url";
import { type AgentPlugin, detectCli, resumeArgs } from "@airemo/plugin-sdk";
import { describeToolInput } from "../hook/describe.mjs";

/** Absolute path of the PermissionRequest hook script shipped with this package. */
export const permissionHookPath = fileURLToPath(
  new URL("../hook/permission-hook.mjs", import.meta.url),
);

/** Settings passed with `--settings`; hooks merge with the user's own settings. */
export function airemoSettings(hookPath = permissionHookPath): Record<string, unknown> {
  return {
    hooks: {
      PermissionRequest: [
        {
          hooks: [
            {
              type: "command",
              command: process.execPath,
              args: [hookPath],
              // Claude Code waits this long (seconds); the daemon denies on its own sooner.
              timeout: 600,
            },
          ],
        },
      ],
    },
  };
}

export { describeToolInput };

// Permission requests arrive through the hook (daemon HTTP route), not by scraping the
// terminal, so parseOutput stays empty until structured output parsing lands.
export const claudeCodePlugin: AgentPlugin = {
  id: "claude-code",
  displayName: "Claude Code",
  capabilities: { structuredOutput: true, permissionHooks: true, pauseResume: false },
  detect: () => detectCli("claude"),
  launch: ({ cwd, env = {}, args = [], requireApproval = false, resume }) => ({
    command: "claude",
    args: [
      "--settings",
      JSON.stringify(airemoSettings()),
      // Without this, a user's auto mode would skip the permission prompt (and the hook).
      ...(requireApproval && !args.includes("--permission-mode")
        ? ["--permission-mode", "default"]
        : []),
      ...args,
      // `claude --resume [id]`: without an id Claude Code shows its own conversation picker.
      ...resumeArgs(resume),
    ],
    env: {
      ...(process.env as Record<string, string>),
      ...env,
      // Classic renderer, not fullscreen: the conversation stays in the terminal's normal
      // scrollback, so a phone scrolls its own copy. Fullscreen uses the alternate screen (no
      // scrollback) and could only be scrolled by sending the agent mouse-wheel events, which
      // scrolled the shared session on the computer too. Verified with the real CLI 2.1.325:
      // unset = alternate screen + mouse capture, "0" = neither.
      CLAUDE_CODE_NO_FLICKER: "0",
    },
    cwd,
  }),
  parseOutput: () => [],
  respondToPermission: () => null,
};
