import type { AgentMessage } from "@mariozechner/pi-agent-core";

const DEFAULT_RECOVERED_HISTORY_MESSAGES = 12;

function isTextBlock(block: unknown): block is { text: string } {
  return (
    !!block &&
    typeof block === "object" &&
    "text" in block &&
    typeof (block as { text?: unknown }).text === "string"
  );
}

function isImageBlock(block: unknown): block is { type: "image" } {
  return (
    !!block &&
    typeof block === "object" &&
    "type" in block &&
    (block as { type?: unknown }).type === "image"
  );
}

function hasMeaningfulContent(message: AgentMessage): boolean {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") {
    return content.trim().length > 0;
  }
  if (!Array.isArray(content)) {
    return false;
  }
  for (const block of content) {
    if (isImageBlock(block)) {
      return true;
    }
    if (isTextBlock(block) && block.text.trim().length > 0) {
      return true;
    }
  }
  return false;
}

function isRecoverableRole(role: string | undefined): role is "assistant" | "user" {
  return role === "assistant" || role === "user";
}

export function recoverSilentResponseHistory(
  messages: AgentMessage[],
  maxMessages = DEFAULT_RECOVERED_HISTORY_MESSAGES,
): AgentMessage[] {
  const meaningful = messages.filter(
    (message) =>
      isRecoverableRole((message as { role?: string }).role) && hasMeaningfulContent(message),
  );
  if (meaningful.length <= 1) {
    return messages;
  }

  const tail = meaningful.slice(-Math.max(1, maxMessages));
  const collapsed: AgentMessage[] = [];
  for (const message of tail) {
    const previous = collapsed.at(-1);
    if (previous?.role === message.role) {
      // Dropping empty/tool-only turns can leave duplicate roles in sequence.
      // Keep the newest turn so the retry reflects the latest user intent.
      collapsed[collapsed.length - 1] = message;
      continue;
    }
    collapsed.push(message);
  }

  return collapsed.length > 0 ? collapsed : tail;
}
