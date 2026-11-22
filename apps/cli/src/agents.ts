import { agentLabel } from "./run.js";

/**
 * The names people type for each agent. The first name of each is the one shown in help:
 *   claude-code  Claude Code (`claude`)
 *   agent        Cursor (its CLI is `cursor-agent`, also installed as `agent`)
 */
const ALIASES: Record<string, string> = {
  "claude-code": "claude-code",
  claude: "claude-code",
  cc: "claude-code",
  agent: "cursor",
  cursor: "cursor",
  "cursor-agent": "cursor",
};

/** The plugin id for a name the person typed, or null if it is not a known agent. */
export function resolveAgent(name: string): string | null {
  return ALIASES[name.trim().toLowerCase()] ?? null;
}

/** The name to type for an agent in `airemo launch` / `airemo resume`. */
export function commandName(id: string): string {
  return id === "cursor" ? "agent" : id;
}

export const AGENT_NAMES_HELP = "claude-code (Claude Code) or agent (Cursor)";

export function unknownAgentMessage(name: string): string {
  return `Unknown agent "${name}". Use ${AGENT_NAMES_HELP}.`;
}

/** How a folder's agents read in a listing. `null` (old entries) means every agent. */
export function describeAgents(agents: string[] | null): string {
  return agents === null ? "all agents" : `${agents.map(agentLabel).join(", ")} only`;
}
