#!/usr/bin/env node
// Claude Code "PermissionRequest" hook. Claude Code runs this when it would show a
// permission dialog. We forward the exact tool call to the Airemo daemon, wait for the
// user's decision (from any paired client), and print it back in Claude Code's format.
//
// Safety: if the daemon cannot be reached or answers badly, we DENY. Nothing runs
// without an explicit decision. Outside an Airemo session the hook is a no-op.

import { describeToolInput } from "./describe.mjs";

const url = process.env.AIREMO_DAEMON_URL;
const sessionId = process.env.AIREMO_SESSION_ID;
const token = process.env.AIREMO_HOOK_TOKEN;

if (!url || !sessionId || !token) process.exit(0); // not launched by Airemo: leave flow unchanged

function out(behavior, message) {
  const decision = behavior === "allow" ? { behavior } : { behavior, message };
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision } }),
  );
  process.exit(0);
}

let raw = "";
for await (const chunk of process.stdin) raw += chunk;

try {
  const input = JSON.parse(raw);
  const res = await fetch(`${url}/hooks/permission`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-airemo-token": token },
    body: JSON.stringify({
      sessionId,
      tool: input.tool_name,
      command: describeToolInput(input.tool_name, input.tool_input),
    }),
  });
  if (!res.ok) out("deny", `Airemo daemon refused the request (${res.status})`);
  const body = await res.json();
  if (body.decision === "allow") out("allow");
  out("deny", body.message || "Denied via Airemo");
} catch (e) {
  out("deny", `Airemo could not obtain a decision: ${e instanceof Error ? e.message : e}`);
}
