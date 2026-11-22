import { fileURLToPath } from "node:url";
import { type AgentPlugin, detectCli, resumeArgs } from "@airemo/plugin-sdk";
import { describeCursorTool } from "../hook/describe.mjs";
import { installApprovalHook } from "./hooks-config.js";
import { hasShellPromptFor } from "./prompt.js";

export { classify, READ_ONLY_TOOLS } from "../hook/decide.mjs";
export { HOOK_MARKER, installApprovalHook } from "./hooks-config.js";
export { hasShellPromptFor } from "./prompt.js";
export { describeCursorTool };

/** Absolute path of the approval hook script shipped with this package. */
export const approvalHookPath = fileURLToPath(
  new URL("../hook/airemo-approval-hook.mjs", import.meta.url),
);

/**
 * Cursor Agent. Approvals work through a `preToolUse` hook that Airemo adds to the project's
 * `.cursor/hooks.json` for the length of the session (verified against the real CLI: project
 * hooks run, a held decision makes the agent wait, and a deny blocks the action). Plugin
 * delivered hooks (`--plugin-dir`) were tried and do not run in the CLI.
 *
 * Output is not parsed: the terminal stream is passed through as is.
 */
export const cursorPlugin: AgentPlugin = {
  id: "cursor",
  displayName: "Cursor",
  capabilities: { structuredOutput: false, permissionHooks: true, pauseResume: false },
  detect: () => detectCli("cursor-agent"),
  prepare: ({ cwd, requireApproval = false }) =>
    // Without the hook Cursor uses its own prompts in the terminal.
    requireApproval ? installApprovalHook(cwd, { hookPath: approvalHookPath }) : undefined,
  // In the interactive UI Cursor asks its own "Run this command?" after our hook allowed a shell
  // command. Confirm it, but only once that exact prompt is visible. If it never appears (the
  // command was already trusted) or looks different, do nothing and leave it to the user.
  afterAllow: async ({ tool, command, screen, write }) => {
    if (tool !== "Shell") return; // file edits are not asked about a second time
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (hasShellPromptFor(screen(), command)) {
        write("y");
        return;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  },
  // --trust: the folder was chosen by the user (allowlisted or launched locally), and an
  // untrusted workspace would not run project hooks or show a usable prompt remotely.
  // `cursor-agent --resume [chatId]`: without an id Cursor shows its own session picker.
  launch: ({ cwd, env = {}, args = [], resume }) => ({
    command: "cursor-agent",
    args: ["--trust", ...args, ...resumeArgs(resume)],
    env: { ...(process.env as Record<string, string>), ...env },
    cwd,
  }),
  parseOutput: () => [],
  respondToPermission: () => null,
};
