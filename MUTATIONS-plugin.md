# Mutation proofs: the mission turn check (missions that stay true, board row 01a177c7)

Each entry broke ONE line of the shipped code, ran the named test file with `npx tsx --test`, recorded which tests went red, and restored the line (a copy beside the file, moved back in a finally). Every mutation turned at least one test red. Runner: a throwaway python script outside the repo.

### M1 the second stop of a turn is let through
- file: `lib/mission-turn.mjs`
- mutated line: `if (stopHookActive === true) return { block: false }` -> `if (false) return { block: false }`
- result: {'pass': '14', 'fail': '1'}
- red tests:
  - ALLOWS the second stop of the same turn (stop_hook_active): the agent already answered

### M2 nothing passing allows
- file: `lib/mission-turn.mjs`
- mutated line: `if (passing.length === 0) return { block: false }` -> `if (passing.length < 0) return { block: false }`
- result: {'pass': '12', 'fail': '3'}
- red tests:
  - ALLOWS on a missing or malformed state and answer
  - ALLOWS when nothing passes, and when the answer says the daemon could not ask
  - with no answer, falls back to the state file only while it is fresh

### M3 a passing goal the agent ticked no longer blocks
- file: `lib/mission-turn.mjs`
- mutated line: `return !goal || goal.done !== true` -> `return true`
- result: {'pass': '14', 'fail': '1'}
- red tests:
  - a mission frame refreshes the goals and drops a passing goal the agent has since ticked

### M4 a stale state file is no evidence
- file: `lib/mission-turn.mjs`
- mutated line: `now - entry.checkedAt <= MISSION_TURN_STATE_FRESH_MS` -> `true`
- result: {'pass': '14', 'fail': '1'}
- red tests:
  - with no answer, falls back to the state file only while it is fresh

### M5 only an OPEN goal's pass counts
- file: `lib/mission-turn.mjs`
- mutated line: `.filter((g) => g.done !== true && isObject(g.result) && g.result.outcome === 'pass')` -> `.filter((g) => isObject(g.result) && g.result.outcome === 'pass')`
- result: {'pass': '14', 'fail': '1'}
- red tests:
  - the daemon keeps only goals that passed and are still open

### M6 an ask is answered once
- file: `lib/mission-turn.mjs`
- mutated line: `if (ask.askId === lastAnswered) return lastAnswered` -> `if (false) return lastAnswered`
- result: {'pass': '14', 'fail': '1'}
- red tests:
  - answerMissionTurnAsk answers a new ask once, with what compute found

### M7 an error answer is empty, never a block
- file: `lib/mission-turn.mjs`
- mutated line: `answer = { askId: ask.askId, passing: [], error:` -> `answer = { askId: ask.askId, passing: [{ id: 1, name: 'x', evidence: 'e' }], error:`
- result: {'pass': '14', 'fail': '1'}
- red tests:
  - answerMissionTurnAsk answers an empty list when compute fails, so the hook allows at once

### M8 only an ACTIVE mission's checked goal makes the hook ask
- file: `lib/mission-turn.mjs`
- mutated line: `if (!isObject(entry) || entry.status !== 'active' || !Array.isArray(entry.goals)) return false` -> `if (!isObject(entry) || !Array.isArray(entry.goals)) return false`
- result: {'pass': '15', 'fail': '1'}
- red tests:
  - the Stop hook asks the daemon only when the turn chat has an open goal with a check

### H1 the hook lets the second stop of a turn through
- file: `bin/hoai-mission-turn-hook.mjs`
- mutated line: `if (event === 'Stop' && payload?.stop_hook_active === true) return ''` -> `if (false) return ''`
- result: {'pass': '8', 'fail': '1'}
- red tests:
  - Stop with stop_hook_active goes through at once: the agent already ticked or said why

### H2 the hook reads only the answer to ITS ask
- file: `bin/hoai-mission-turn-hook.mjs`
- mutated line: `if (answer && answer.askId === askId) return answer` -> `if (answer) return answer`
- result: {'pass': '8', 'fail': '1'}
- red tests:
  - Stop ALLOWS when the daemon answers nothing passing, and ignores an answer to another ask

### H3 the hook prints the block
- file: `bin/hoai-mission-turn-hook.mjs`
- mutated line: `return decision.block ? JSON.stringify({ decision: 'block', reason: decision.reason }) : ''` -> `return ''`
- result: {'pass': '7', 'fail': '2'}
- red tests:
  - Stop BLOCKS on the daemon answer naming an unticked goal whose check passes
  - Stop with no daemon answer falls back to a FRESH state passing list, and blocks

### H4 a turn with nothing to ask never waits
- file: `bin/hoai-mission-turn-hook.mjs`
- mutated line: `if (!missionTurnNeedsAsk(state)) return ''` -> `if (false) return ''`
- result: {'pass': '8', 'fail': '1'}
- red tests:
  - Stop with nothing to ask ends at once, writing no ask

### T1 a goal check rides the wire unchanged
- file: `lib/missions.ts`
- mutated line: `...(isPlainObject(check) ? { check } : {}),` -> `...({}),`
- result: {'pass': '4', 'fail': '1'}
- red tests:
  - create, fill and add pass a goal check through unchanged, every key kept

### T2 a check that is not an object is refused
- file: `lib/missions.ts`
- mutated line: `if (check !== undefined && check !== null && !isPlainObject(check)) {` -> `if (false) {`
- result: {'pass': '4', 'fail': '1'}
- red tests:
  - a check that is not an object is refused before the network, naming the goal


### C1 every host declares mission_server_checks
- file: `lib/declared-capabilities.ts`
- mutated line: `'mission_set_goals',
  'mission_server_checks',
  PERMISSION_CARD,` -> `'mission_set_goals',
  PERMISSION_CARD,`
- result: {'pass': '32', 'fail': '5'}
- red tests:
  - a host that cannot type declares the READ half only
  - boards_playbook is declared on every host, because the tool is typed and has no platform limit
  - mission_server_checks is declared on every host, beside and distinct from mission_goal_checks
  - permission_card is declared on every host, because the relay has no platform limit
  - the stop pause token rides with mission_pause and nothing else, the gate the stop pause runs behind


## Review fixes (independent review of the plugin range)

M4 above (the state file fallback while fresh) is SUPERSEDED: review fix 3 removed that fallback, so a missing or late answer always allows; R3 below proves the new rule.

### R1 only the tag that OPENS the prompt names the chat
- file: `lib/mission-turn.mjs`
- mutated line: `const match = /^\s*<channel\b[^>]*?\bchat_id="(\d+)"[^>]*>/.exec(prompt)
  return match ? match[1] : null` -> `let match = null
  for (const m of prompt.matchAll(/<channel\b[^>]*?\bchat_id="(\d+)"/g)) match = m
  return match ? match[1] : null`
- result: {'pass': '19', 'fail': '1'}
- red tests:
  - promptChatId reads ONLY the channel tag that opens the prompt (review fix 1)

### R3 a missing answer allows, the state on disk never blocks
- file: `bin/hoai-mission-turn-hook.mjs`
- mutated line: `const decision = missionTurnStopDecision({ stopHookActive: false, answer })` -> `const decision = missionTurnStopDecision({ stopHookActive: false, answer: answer ?? state?.chats?.[chatId] })`
- result: {'pass': '9', 'fail': '1'}
- red tests:
  - Stop with no daemon answer ALLOWS, even with a fresh passing list on disk (review fix 3)

### R4a the Stop reads only its OWN session's turn record
- file: `lib/mission-turn.mjs`
- mutated line: `if (!isObject(record) || !String(sessionId ?? '') || record.sessionId !== String(sessionId)) return null` -> `if (!isObject(record)) return null`
- result: {'pass': '9', 'fail': '1'}
- red tests:
  - Stop with nothing to ask ends at once, writing no ask

### R4b the daemon answers only for a chat it delivered to
- file: `server.ts`
- mutated line: `if (!chatId || !turnChat.deliveredRecently(chatId, Date.now())) return { passing: [] }` -> `if (!chatId) return { passing: [] }`
- result: {'pass': '5', 'fail': '1'}
- red tests:
  - the answer is for the ASK's chat, only one this daemon delivered to recently, from a fresh entry when it has one (review fixes 4 and 6)

### R4c deliveredRecently says no to a chat never delivered to
- file: `lib/turn-chat.ts`
- mutated line: `return ring.some((entry) => entry.record.chatId === id && fresh(entry.record, now) !== null)` -> `return true`
- result: {'pass': '14', 'fail': '1'}
- red tests:
  - deliveredRecently answers only for a chat this daemon delivered to, or whose turn it ran, recently (missions that stay true, review fix 4)

### R5a an ask older than the hook's wait is never answered
- file: `lib/mission-turn.mjs`
- mutated line: `if (!Number.isFinite(ask.at) || now() - ask.at > MISSION_TURN_ASK_MAX_AGE_MS) {` -> `if (false) {`
- result: {'pass': '19', 'fail': '1'}
- red tests:
  - answerMissionTurnAsk ignores an ask older than the hook can wait for, and removes it (review fix 5)

### R5b an answered ask is removed
- file: `lib/mission-turn.mjs`
- mutated line: `removeQuietly(askPath)
  return ask.askId` -> `return ask.askId`
- result: {'pass': '18', 'fail': '2'}
- red tests:
  - answerMissionTurnAsk answers a new ask once, with what compute found
  - answerMissionTurnAsk removes an ask once it is answered, and hands compute the ask

### R6 only an entry checked under 30 s ago answers from memory
- file: `lib/mission-turn.mjs`
- mutated line: `return now - entry.checkedAt < MISSION_TURN_REUSE_MS ? entry : null` -> `return entry`
- result: {'pass': '19', 'fail': '1'}
- red tests:
  - freshMissionTurnEntry answers from a chat entry checked under 30 s ago, and only then (review fix 6)


## Review confirmation pass

### A1 an answered ask is removed only while it is still that ask
- file: `lib/mission-turn.mjs`
- mutated line: `if (readMissionTurnJson(askPath)?.askId === ask.askId) removeQuietly(askPath)` -> `removeQuietly(askPath)`
- result: {'pass': '20', 'fail': '1'}
- red tests:
  - answerMissionTurnAsk never removes a NEWER ask written while it answered the old one (review confirmation A)

