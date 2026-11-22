import { describe, expect, it } from "vitest";
import { createMessage, parseMessage } from "./index.js";

describe("protocol", () => {
  it("round-trips a message", () => {
    const m = createMessage("prompt.send", { text: "hi" }, { sessionId: "s1" });
    expect(parseMessage(JSON.parse(JSON.stringify(m)))).toEqual(m);
  });

  it("rejects unknown versions and types", () => {
    const m = createMessage("session.list", {});
    expect(() => parseMessage({ ...m, v: 99 })).toThrow();
    expect(() => parseMessage({ ...m, type: "nope" })).toThrow();
  });

  it("session.start accepts a resume id that cannot be read as a flag", () => {
    const start = (resume: unknown) => ({
      ...createMessage("session.start", { agent: "claude-code", cwd: "/p" }),
      payload: { agent: "claude-code", cwd: "/p", resume },
    });
    expect(parseMessage(start({})).payload).toMatchObject({ resume: {} });
    expect(parseMessage(start({ id: "4f2c-9a_b.1" })).payload).toMatchObject({
      resume: { id: "4f2c-9a_b.1" },
    });
    for (const id of ["--dangerously-skip-permissions", "-r", "a b", "x;rm", "", "a".repeat(129)]) {
      expect(() => parseMessage(start({ id }))).toThrow();
    }
  });

  it("permission.request requires the exact command", () => {
    expect(() =>
      parseMessage({
        ...createMessage("session.list", {}),
        type: "permission.request",
        payload: { requestId: "r", tool: "bash" },
      }),
    ).toThrow();
  });
});
