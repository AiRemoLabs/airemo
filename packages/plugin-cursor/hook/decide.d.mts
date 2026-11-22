export const READ_ONLY_TOOLS: Set<string>;
export function classify(
  toolName: string,
  toolInput: unknown,
  workspaceRoots: unknown,
  cwd?: unknown,
): "allow" | "ask";
