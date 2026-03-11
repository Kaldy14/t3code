import type { OrchestrationMessage } from "@t3tools/contracts";

const MAX_SUMMARY_CHARS = 4000;
const MAX_USER_CHARS = 200;
const MAX_ASSISTANT_CHARS = 500;

/**
 * Build a conversation summary from orchestration messages for context injection
 * when a session must be restarted without a resume cursor.
 *
 * Returns undefined if there are no messages to summarize.
 */
export function buildConversationSummary(
  messages: ReadonlyArray<OrchestrationMessage>,
): string | undefined {
  if (messages.length === 0) return undefined;

  const lines: string[] = [
    "[Prior conversation context - session was interrupted]",
  ];

  let charCount = lines[0]!.length;
  let turnIndex = 0;

  for (const msg of messages) {
    // Skip messages with empty text (e.g., tool-use-only assistant turns)
    if (!msg.text || msg.text.trim().length === 0) continue;

    const role = msg.role;
    const maxChars = role === "user" ? MAX_USER_CHARS : MAX_ASSISTANT_CHARS;
    const truncated = msg.text.length > maxChars
      ? msg.text.slice(0, maxChars) + "..."
      : msg.text;
    const line = `Turn ${Math.floor(turnIndex / 2) + 1} (${role}): ${truncated}`;

    if (charCount + line.length + 1 > MAX_SUMMARY_CHARS) break;

    lines.push(line);
    charCount += line.length + 1;
    turnIndex++;
  }

  lines.push("[End of prior context. The user's new message follows.]");
  return lines.join("\n");
}
