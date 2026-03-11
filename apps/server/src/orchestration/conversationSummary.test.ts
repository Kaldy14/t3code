import { MessageId, TurnId, type OrchestrationMessage } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { buildConversationSummary } from "./conversationSummary.ts";

const now = new Date().toISOString();

function makeMessage(
  overrides: Partial<OrchestrationMessage> & { id?: string; role?: OrchestrationMessage["role"]; text?: string },
): OrchestrationMessage {
  return {
    id: MessageId.makeUnsafe(overrides.id ?? "msg-1"),
    role: overrides.role ?? "user",
    text: overrides.text ?? "hello",
    turnId: overrides.turnId ?? TurnId.makeUnsafe("turn-1"),
    streaming: overrides.streaming ?? false,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
    ...overrides,
    // Ensure id is always a MessageId brand
    ...(overrides.id ? { id: MessageId.makeUnsafe(overrides.id) } : {}),
  };
}

describe("buildConversationSummary", () => {
  it("returns undefined for empty array", () => {
    expect(buildConversationSummary([])).toBeUndefined();
  });

  it("returns summary with single user message", () => {
    const result = buildConversationSummary([makeMessage({ id: "m1", role: "user", text: "Hello world" })]);
    expect(result).toBeDefined();
    expect(result).toContain("Turn 1 (user): Hello world");
  });

  it("returns summary with user + assistant messages", () => {
    const result = buildConversationSummary([
      makeMessage({ id: "m1", role: "user", text: "What is 2+2?" }),
      makeMessage({ id: "m2", role: "assistant", text: "The answer is 4." }),
    ]);
    expect(result).toContain("Turn 1 (user): What is 2+2?");
    expect(result).toContain("Turn 1 (assistant): The answer is 4.");
  });

  it("truncates user messages longer than 200 chars", () => {
    const longText = "a".repeat(250);
    const result = buildConversationSummary([makeMessage({ id: "m1", role: "user", text: longText })]);
    expect(result).toBeDefined();
    expect(result).toContain("a".repeat(200) + "...");
    expect(result).not.toContain("a".repeat(201));
  });

  it("truncates assistant messages longer than 500 chars", () => {
    const longText = "b".repeat(600);
    const result = buildConversationSummary([makeMessage({ id: "m1", role: "assistant", text: longText })]);
    expect(result).toBeDefined();
    expect(result).toContain("b".repeat(500) + "...");
    expect(result).not.toContain("b".repeat(501));
  });

  it("skips messages with empty text", () => {
    const result = buildConversationSummary([
      makeMessage({ id: "m1", role: "user", text: "" }),
      makeMessage({ id: "m2", role: "assistant", text: "   " }),
      makeMessage({ id: "m3", role: "user", text: "actual message" }),
    ]);
    expect(result).toBeDefined();
    expect(result).not.toContain("Turn 1 (user): \n");
    expect(result).not.toContain("Turn 1 (assistant):");
    expect(result).toContain("Turn 1 (user): actual message");
  });

  it("caps total at 4000 chars", () => {
    const messages: OrchestrationMessage[] = [];
    for (let i = 0; i < 100; i++) {
      messages.push(
        makeMessage({
          id: `m${i}`,
          role: i % 2 === 0 ? "user" : "assistant",
          text: "x".repeat(150),
        }),
      );
    }
    const result = buildConversationSummary(messages);
    expect(result).toBeDefined();
    // The result should be within reasonable bounds of the 4000 char cap
    // (the footer line is appended after the cap check, so the total can slightly exceed 4000)
    const headerAndBody = result!.split("\n").slice(0, -1).join("\n");
    expect(headerAndBody.length).toBeLessThanOrEqual(4000);
  });

  it("includes header and footer lines", () => {
    const result = buildConversationSummary([makeMessage({ id: "m1", role: "user", text: "hi" })]);
    expect(result).toBeDefined();
    const lines = result!.split("\n");
    expect(lines[0]).toBe("[Prior conversation context - session was interrupted]");
    expect(lines[lines.length - 1]).toBe("[End of prior context. The user's new message follows.]");
  });
});
