#!/usr/bin/env node
// Cursor "preToolUse" hook. Cursor runs this before every tool call. Read-only tools inside the
// workspace pass straight through; anything else is sent to the Airemo daemon and waits for the
// user's decision (from any paired device).
//
// Safety: if the daemon cannot be reached or answers badly, the answer is DENY, and hooks.json
// sets failClosed as a second layer. Outside an Airemo session the hook has no opinion at all,
// so a leftover config never changes how Cursor normally behaves.
import { classify } from "./decide.mjs";
import { describeCursorTool } from "./describe.mjs";

const url = process.env.AIREMO_DAEMON_URL;
const sessionId = process.env.AIREMO_SESSION_ID;
const token = process.env.AIREMO_HOOK_TOKEN;

const out = (obj) => {
  process.stdout.write(JSON.stringify(obj));
  process.exit(0);
};

// Not started by Airemo: no opinion.
if (!url || !sessionId || !token) out({});

const deny = (why) =>
  out({
    permission: "deny",
    user_message: why,
    agent_message: `${why} Do not retry this action. Ask the user how to proceed.`,
  });

let raw = "";
for await (const chunk of process.stdin) raw += chunk;

try {
  const input = JSON.parse(raw);
  const tool = input.tool_name;
  if (typeof tool !== "string") deny("Airemo could not read the tool call.");

  if (classify(tool, input.tool_input, input.workspace_roots, input.cwd) === "allow") {
    out({ permission: "allow" });
  }

  const res = await fetch(`${url}/hooks/permission`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-airemo-token": token },
    body: JSON.stringify({
      sessionId,
      tool,
      command: describeCursorTool(tool, input.tool_input),
    }),
  });
  if (!res.ok) deny(`Airemo refused the request (${res.status}).`);
  const body = await res.json();
  if (body.decision === "allow") out({ permission: "allow" });
  deny(body.message || "Denied via Airemo.");
} catch (e) {
  deny(`Airemo could not obtain a decision: ${e instanceof Error ? e.message : e}`);
}
