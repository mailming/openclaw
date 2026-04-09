import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import { recoverSilentResponseHistory } from "./history-recovery.js";

describe("recoverSilentResponseHistory", () => {
  it("keeps a short meaningful user and assistant tail", () => {
    const messages = [
      { role: "user", content: "first" },
      { role: "assistant", content: "reply one" },
      { role: "user", content: "" },
      { role: "assistant", content: [] },
      { role: "tool", content: "ignored" },
      { role: "user", content: "latest question" },
      { role: "assistant", content: [{ type: "text", text: "latest answer" }] },
    ] as AgentMessage[];

    expect(recoverSilentResponseHistory(messages, 4)).toEqual([
      { role: "user", content: "first" },
      { role: "assistant", content: "reply one" },
      { role: "user", content: "latest question" },
      { role: "assistant", content: [{ type: "text", text: "latest answer" }] },
    ]);
  });

  it("collapses consecutive same-role messages after empty turns are removed", () => {
    const messages = [
      { role: "assistant", content: "older answer" },
      { role: "assistant", content: "" },
      { role: "assistant", content: "newest answer" },
      { role: "user", content: "" },
      { role: "user", content: [{ type: "image" }] },
      { role: "user", content: "latest prompt" },
    ] as AgentMessage[];

    expect(recoverSilentResponseHistory(messages, 6)).toEqual([
      { role: "assistant", content: "newest answer" },
      { role: "user", content: "latest prompt" },
    ]);
  });
});
