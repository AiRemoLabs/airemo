/** The exact action shown to the user before approval. */
export function describeToolInput(tool, input) {
  if (input && typeof input === "object") {
    if (tool === "Bash" && typeof input.command === "string") return input.command;
    if (typeof input.file_path === "string") return `${tool}: ${input.file_path}`;
  }
  return `${tool}: ${JSON.stringify(input)}`;
}
