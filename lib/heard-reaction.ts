type ReactionCard = {
  content: string;
  meta: {
    chat_id: string;
    message_id: string;
    event_type: "reaction";
    emoji: string;
  };
};

function id(value: unknown): string | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  const s = String(value);
  return /^[1-9]\d*$/.test(s) && Number.isSafeInteger(Number(s)) ? s : null;
}

function oneLine(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/gu, " ").trim() : "";
}

export function reactionCard(
  raw: unknown,
  self: string | number,
): ReactionCard | null {
  if (!raw || typeof raw !== "object") return null;
  const frame = raw as Record<string, unknown>;
  if (id(frame.assistantId) !== String(self)) return null;
  const chat = id(frame.chatId);
  const message = id(frame.messageId);
  const emoji = oneLine(frame.emoji);
  if (!chat || !message || !emoji || !id(frame.reactionId)) return null;
  const name = oneLine(frame.name) || "Someone";
  const preview = Array.from(oneLine(frame.preview)).slice(0, 80).join("");
  const quote = preview ? ': "' + preview + '"' : "";
  return {
    content: name + " reacted " + emoji + " to your message" + quote,
    meta: { chat_id: chat, message_id: message, event_type: "reaction", emoji },
  };
}

export const REACTION_GUIDANCE =
  "Treat a person's reaction to your message as a short answer. Reply only when it asks for action.";
