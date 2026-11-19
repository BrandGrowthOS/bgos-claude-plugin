import { randomInt } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { reactionCard } from "../lib/heard-reaction.ts";

const self = randomInt(1, 1000000);
const frame = {
  assistantId: self,
  chatId: randomInt(1000000, 2000000),
  messageId: randomInt(1, 1000000),
  reactionId: String(randomInt(1, 1000000)),
  name: "Reader",
  emoji: "👍",
  preview: "Do you agree?",
};

test("a reaction is one plain channel line with the original message address", () => {
  assert.deepEqual(reactionCard(frame, self), {
    content: 'Reader reacted 👍 to your message: "Do you agree?"',
    meta: {
      event_type: "reaction",
      emoji: "👍",
      message_id: String(frame.messageId),
      chat_id: String(frame.chatId),
    },
  });
});

test("only the addressed agent can hear the reaction", () => {
  assert.equal(reactionCard(frame, self + 1), null);
});

test("arbitrary line breaks stay inside a single line and a quote has at most 80 characters", () => {
  const card = reactionCard(
    { ...frame, name: "A\nreader", preview: "😀".repeat(81) },
    self,
  );
  assert.equal(
    card?.content,
    `A reader reacted 👍 to your message: "${"😀".repeat(80)}"`,
  );
});

test("incomplete frames do not wake the agent", () => {
  assert.equal(reactionCard({ ...frame, emoji: "" }, self), null);
});
