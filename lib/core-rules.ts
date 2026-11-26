/**
 * The guide's few core rules, bundled so they reach EVERY session without a
 * tool call (kit check 2026-11-25, finding 1).
 *
 * A fresh session may never call `bgos_capabilities`, and the served guide is
 * about 208,000 characters, so the rules it carries reached no model: rule 1
 * (acknowledge with a reaction, not a filler reply) was never read and
 * "thanks" got a bubble. Claude Code shows a stdio MCP server's instructions
 * only up to their first 4,096 characters (2.1.332: a longer string is
 * reported as `instructionsTruncated` and cut), so this block sits at the top
 * of the instructions in server.ts, and test/core-rules.test.ts holds it
 * inside that window. The `bgos_capabilities` answer without a topic opens
 * with the same block (lib/capability-guide.ts).
 *
 * The three rule texts are copied BYTE FOR BYTE out of the served canon
 * (backend/src/integrations/capability-canon.ts in the BGOS repo):
 * OWNER_CHAT_ACK_RULE, CLAUDE_YES_NO_RULE and SAVE_SKILLS_PARAGRAPH. The two
 * repositories cannot import from one another, so the literals are the copy,
 * test/core-rules.test.ts pins them here, and the BGOS spec
 * capability-canon.plugin-core-rules.spec.ts pins the same words there, so a
 * change on either side fails a test until both say the same thing. The
 * sentences after each rule are this plugin's own: the served canon names a
 * REST route for a reaction and "your channel section" for skills, and here
 * they are the react tool and the agent's own .claude/skills folder.
 *
 * Rule 1 is told unconditionally. The canon tells it only to a paired
 * caller, because an unpaired one has no agent to react as; here the react
 * tool refuses an account key install with one sentence, and the rule itself
 * says what to do when a reaction fails: send one short line. No em or en
 * dashes: this is a prompt.
 */

/** Served canon OWNER_CHAT_ACK_RULE, byte for byte (the self improving kit's rule 1). */
export const OWNER_CHAT_ACK_RULE =
  'ACKNOWLEDGE WITH A REACTION, NOT A REPLY. In your chat with your owner, when their message needs no words back (thanks, ok, a fact to keep, a done confirmation), react 👍, ❤️ or 🙏 and send nothing else. When you start work longer than a minute, react 👀 at once, then reply with the result. Never react instead of answering a question or reporting a result. If the reaction fails, send one short line instead.'

/** How rule 1 is done on this channel: the plugin's own sentence. */
export const REACT_TOOL_RULE_SENTENCE =
  'React with the react tool and the message_id of their message. In a group, a meeting or a channel this rule does not apply.'

/** Served canon CLAUDE_YES_NO_RULE, byte for byte (rule 2, the Claude Code variant). */
export const CLAUDE_YES_NO_RULE =
  'In your own chat with your owner, a question your owner answers yes or no, except a dangerous command, which stays on the approval, always goes through ask_user_input as one question with two options, Yes and No (or two short words of your own), with the values yes and no, never as a question in plain text: the app draws it as two buttons to tap. In a group or a channel, ask with reply buttons instead.'

/** Served canon SAVE_SKILLS_PARAGRAPH, byte for byte (rule 3). */
export const SAVE_SKILLS_PARAGRAPH =
  "SAVE WHAT YOU REPEAT AS A SKILL, without drafting or asking first (a request to teach yourself a skill still drafts first). When you do a task for your owner the second time, or work out a many step procedure, save it as a short skill where your channel section says your skills go: when to use it, the steps, the pitfalls. Put origin: made in its front matter. Never put a secret or your owner's private data in one. When a skill you used was wrong or missing a step, fix it before you finish. Do not announce it. Without a place for skills, skip this."

/** Where a Claude Code agent's skills go, in the words of the served Claude teaching line. */
export const CLAUDE_SKILLS_PLACE_SENTENCE =
  'Your skills go in .claude/skills/<name>/SKILL.md inside your working folder, never ~/.claude/skills.'

export const CORE_RULES_HEADING = '## Core rules (they apply in every session)'

/** The block, line by line, exactly as the MCP instructions carry it. */
export const CORE_RULES_LINES: readonly string[] = [
  CORE_RULES_HEADING,
  `1. ${OWNER_CHAT_ACK_RULE} ${REACT_TOOL_RULE_SENTENCE}`,
  `2. ${CLAUDE_YES_NO_RULE}`,
  `3. ${SAVE_SKILLS_PARAGRAPH} ${CLAUDE_SKILLS_PLACE_SENTENCE}`,
]

export const CORE_RULES_TEXT = CORE_RULES_LINES.join('\n')
