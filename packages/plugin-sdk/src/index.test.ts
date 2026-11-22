import { describe, expect, it } from "vitest";
import { type AgentPlugin, PluginRegistry, replayFixture } from "./index.js";

const fake: AgentPlugin = {
  id: "fake",
  displayName: "Fake",
  capabilities: { structuredOutput: false, permissionHooks: false, pauseResume: false },
  detect: async () => ({ installed: true }),
  launch: (o) => ({ command: "fake", args: [], env: {}, cwd: o.cwd }),
  parseOutput: (c) => (c.includes("?") ? [{ kind: "status", status: "awaiting_approval" }] : []),
  respondToPermission: (_id, d) => (d === "allow" ? "y\n" : "n\n"),
};

describe("plugin-sdk", () => {
  it("registers plugins and rejects duplicates", () => {
    const r = new PluginRegistry().register(fake);
    expect(r.get("fake")).toBe(fake);
    expect(() => r.register(fake)).toThrow();
  });

  it("replays fixtures", () => {
    expect(replayFixture(fake, ["hello", "ok?"])).toEqual([
      { kind: "status", status: "awaiting_approval" },
    ]);
  });
});
