const MAX_SHOWN = 8000;

const clip = (text) =>
  text.length > MAX_SHOWN
    ? `${text.slice(0, MAX_SHOWN)}\n[... ${text.length - MAX_SHOWN} more characters not shown]`
    : text;

/** The exact action shown to the user before they approve. */
export function describeCursorTool(tool, input) {
  const i = input && typeof input === "object" ? input : {};
  // A shell command is shown in full, never clipped: it is what the user is approving.
  if (tool === "Shell" && typeof i.command === "string") return i.command;
  if (tool === "Write" && typeof i.file_path === "string") {
    const content = typeof i.content === "string" ? i.content : "";
    return `Write ${i.file_path} (${content.length} characters)\n\n${clip(content)}`;
  }
  if (tool === "Delete" && typeof i.file_path === "string") return `Delete ${i.file_path}`;
  if (typeof i.file_path === "string" && Object.keys(i).length === 1) {
    return `${tool} ${i.file_path}`;
  }
  return clip(`${tool}: ${JSON.stringify(input)}`);
}
