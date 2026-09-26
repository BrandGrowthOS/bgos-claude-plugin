/**
 * The Claude Code capability tokens the BGOS capability canon gates on.
 *
 * A Claude Code daemon DECLARES a token (on its version heartbeat and on the
 * capabilities fetch at connect), and the BGOS backend tells that daemon's
 * agent the matching canon sentence only when the token is declared, whatever
 * the daemon's version. So the spelling of each token is a contract between
 * two repos, and a drift on either side is silent: the agent is never told
 * about a card its daemon can post, or is told about one it cannot.
 *
 * THIS FILE IS COPIED BYTE FOR BYTE between
 *   github.com/BrandGrowthOS/BGOS
 *     backend/src/integrations/claude-capability-tokens.ts
 *   github.com/BrandGrowthOS/bgos-claude-plugin
 *     lib/claude-capability-tokens.ts
 * and each repo pins the sha256 of its own copy, as a literal, in a test
 * (BGOS: backend/src/integrations/claude-capability-tokens.pin.spec.ts;
 * plugin: test/claude-capability-tokens.pin.test.ts). The two literals are
 * the same digest. Changing this file means changing BOTH copies and BOTH
 * pinned digests in one pair of PRs; a change that lands in one repo only
 * turns that repo's pin red, and that is the point.
 *
 * No imports, LF line endings, and the BGOS backend's prettier style, so both
 * toolchains read the same bytes unchanged.
 *
 * permission_card: the daemon raises Claude Code's tool permission prompt as
 *   the BGOS request card (an approval_request, Allow once and Deny) and
 *   honours the owner's ea: answer to it.
 * plan_card: the daemon has the propose_plan tool and the /plan builtin,
 *   which post the plan card.
 * hard_floor: the daemon installs the blocking floor hook and, for an action
 *   on the owner's Always ask list, holds it for the owner before any auto
 *   approve (after asking the server's floor-check route).
 *
 * Not every token the canon gates on lives here: boards_playbook is older and
 * is declared and gated from its own files.
 */
export const PERMISSION_CARD = 'permission_card';
export const PLAN_CARD = 'plan_card';
export const HARD_FLOOR_TOKEN = 'hard_floor';

/** Every token this file names, in the order above. */
export const CLAUDE_CAPABILITY_TOKENS: readonly string[] = Object.freeze([
  PERMISSION_CARD,
  PLAN_CARD,
  HARD_FLOOR_TOKEN,
]);
