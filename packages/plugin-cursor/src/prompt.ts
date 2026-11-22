const squash = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * Is Cursor's own "Run this command?" prompt on screen, for exactly this command?
 *
 * Cursor asks that question on top of Airemo's approval for shell commands it does not already
 * trust. Airemo confirms it only after the user approved this command, and only when the prompt
 * is clearly the active one at the bottom of the screen and shows the same command. Anything
 * else is left for the user.
 */
export function hasShellPromptFor(screen: string, command: string): boolean {
  const lines = screen
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() !== "");
  const tail = lines.slice(-20); // the live prompt sits at the bottom, below the transcript
  const question = tail.findLastIndex((l) => /Run this command\?/.test(l));
  if (question < 0) return false;
  if (!tail.slice(question).some((l) => /Run \(once\) \(y\)/.test(l))) return false;

  // The command shown just above the question must be the one the user approved.
  const full = squash(command);
  const wanted = full.slice(0, 40);
  if (wanted.length === 0) return false;
  const shown = squash(tail.slice(Math.max(0, question - 8), question).join(" "));

  for (let at = shown.indexOf(wanted); at >= 0; at = shown.indexOf(wanted, at + 1)) {
    if (full.length > wanted.length) return true; // long command: the screen cuts it short
    // A command shown in full must end where the prompt's own text continues (" in <folder>"),
    // so approving `echo hi` never confirms a prompt for `echo hi > file`.
    const after = shown.slice(at + wanted.length);
    if (after === "" || /^ in( |$)/.test(after)) return true;
  }
  return false;
}
