// Placeholder for the Phase 4 project memory and task store (SQLite + Drizzle).
// Deferred until the connection, streaming and approval flow is reliable.

export const TASK_STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "blocked",
  "in_review",
  "completed",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];
export type TaskSource = "ai" | "user";
