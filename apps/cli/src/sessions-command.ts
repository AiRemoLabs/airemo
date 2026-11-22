import { agentLabel, type SessionSummary } from "./run.js";

export type { SessionSummary };

/** The short form people type: the first 8 characters of the session id. */
export const shortId = (id: string) => id.slice(0, 8);

const folderName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

export function formatSession(s: SessionSummary): string {
  return `${shortId(s.id)}  ${agentLabel(s.agent).padEnd(11)}  ${folderName(s.cwd).padEnd(20)}  ${s.status}`;
}

/** Ask the daemon for its sessions. Null means the daemon could not be reached. */
export async function fetchSessions(
  port: number,
  call: typeof fetch = fetch,
): Promise<SessionSummary[] | null> {
  try {
    const res = await call(`http://127.0.0.1:${port}/sessions`);
    return (await res.json()) as SessionSummary[];
  } catch {
    return null;
  }
}

export type SessionChoice = { ok: true; session: SessionSummary } | { ok: false; message: string };

export interface ChooseIo {
  interactive: boolean;
  ask(question: string): Promise<string>;
}

/**
 * Which running session should `airemo attach` join?
 *   an id (or the start of one)  that session
 *   nothing                      the only running one, or a choice if there are several
 */
export async function chooseSession(
  arg: string | undefined,
  sessions: SessionSummary[],
  io: ChooseIo,
): Promise<SessionChoice> {
  const running = sessions.filter((s) => s.status !== "exited");

  if (arg) {
    const matches = running.filter((s) => s.id.startsWith(arg));
    if (matches.length === 1) return { ok: true, session: matches[0] as SessionSummary };
    if (matches.length > 1) {
      return {
        ok: false,
        message: `"${arg}" matches more than one session. Use more of the id (see \`airemo sessions\`).`,
      };
    }
    return { ok: false, message: `No running session matches "${arg}". See \`airemo sessions\`.` };
  }

  if (running.length === 0) {
    return {
      ok: false,
      message:
        "No running sessions. Start one with `airemo launch claude-code` or from your phone.",
    };
  }
  if (running.length === 1) return { ok: true, session: running[0] as SessionSummary };

  if (!io.interactive) {
    return {
      ok: false,
      message: `Several sessions are running. Say which one: airemo attach <id>\n${running.map(formatSession).join("\n")}`,
    };
  }
  const lines = running.map((s, i) => `  ${i + 1}) ${formatSession(s)}`).join("\n");
  for (let attempt = 0; attempt < 3; attempt++) {
    const answer = (
      await io.ask(
        `Which session should this terminal join?\n${lines}\nChoose 1-${running.length}: `,
      )
    ).trim();
    const chosen = running[Number(answer) - 1];
    if (/^\d+$/.test(answer) && chosen) return { ok: true, session: chosen };
  }
  return { ok: false, message: "No session chosen." };
}
