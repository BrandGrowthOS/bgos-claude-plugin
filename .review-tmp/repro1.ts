import { applyHookEventToTurn, emptyTurn, parseHookEvent } from '../lib/hook-events.ts'

const SESSION = 's1'
const P1 = 'prompt-one'

let state = emptyTurn()
const feed = (payload: Record<string, unknown>, at: number) => {
  const event = parseHookEvent({ session_id: SESSION, cwd: '/work', ...payload })
  if (event === null) throw new Error('unparsed ' + JSON.stringify(payload))
  const { next, effects } = applyHookEventToTurn(state, event, at)
  state = next
  return effects
}

feed({ hook_event_name: 'SessionStart', source: 'startup' }, 1000)
feed({ hook_event_name: 'UserPromptSubmit', prompt_id: P1, prompt: 'go' }, 2000)
feed({
  hook_event_name: 'PreToolUse',
  prompt_id: P1,
  tool_name: 'Agent',
  tool_use_id: 'toolu_1',
  tool_input: { description: 'Run the sign up tests', subagent_type: 'general-purpose' },
}, 3000)
feed({
  hook_event_name: 'PostToolUse',
  prompt_id: P1,
  tool_name: 'Agent',
  tool_use_id: 'toolu_1',
  tool_input: { description: 'Run the sign up tests', subagent_type: 'general-purpose' },
  tool_response: { isAsync: true, status: 'async_launched', agentId: 'A1' },
  duration_ms: 5,
}, 3005)
const stopEffects = feed({ hook_event_name: 'Stop', prompt_id: P1, last_assistant_message: 'waiting' }, 4000)
console.log('--- Stop effects ---')
for (const e of stopEffects) console.log(JSON.stringify(e))
console.log('carried cardKey =', state.carried?.cardKey)

// The child now runs its own tool. Its payload carries the PARENT turn's prompt_id.
const childEffects = feed({
  hook_event_name: 'PreToolUse',
  prompt_id: P1,
  agent_id: 'A1',
  agent_type: 'general-purpose',
  tool_name: 'Bash',
  tool_use_id: 'toolu_child_1',
  tool_input: { command: 'wc -l hay.txt', description: 'count' },
}, 5000)
console.log('--- child PreToolUse effects ---')
for (const e of childEffects) {
  if (e.kind === 'tool_card') {
    console.log('tool_card cardKey=', e.cardKey, 'state=', e.state, 'rows=', JSON.stringify(e.tools))
  } else console.log(JSON.stringify(e))
}
