/**
 * The plugin NAMES the human it acts for: X-BGOS-Acting-User on the boards
 * wire (lib/acting-user.ts, wired in server.ts).
 *
 * What this pins:
 *  - the owner's own turn sends NO header, so that wire is byte-identical to
 *    before shares could act at all;
 *  - a shared recipient's turn sends THEIR id;
 *  - a proactive call with no inbound seen falls back to the owner (no header);
 *  - a peer (agent) or system inbound never moves the pointer;
 *  - server.ts composes the header into the boards transports and notes the
 *    acting user at every site that records the inbound sender.
 *
 * Mutations that make this file fail (run by hand when the module changes):
 *  M1 actingUserHeaders drops the owner short-circuit (always sends the id):
 *     "owner turn sends no header" and both proactive cases fail.
 *  M2 isUserTurn drops the agentOrigin check: "a peer carried under a user
 *     label never moves it" fails.
 *  M3 isUserTurn drops the senderType check: "a system inbound never moves it"
 *     and "a peer agent inbound never moves it" fail.
 *  M4 server.ts line 840 reverts to headers: () => authHeaders(AUTH):
 *     "the boards transports compose the acting user header" fails.
 *  M5 one of the three noteInbound sites in server.ts is removed: "every
 *     inbound sender write also notes the acting user" fails.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  ACTING_USER_HEADER,
  actingUserHeaders,
  createActingUserTracker,
  isUserTurn,
} from '../lib/acting-user.js'
import { createBoardsTransports } from '../lib/boards-tools.js'

const OWNER = 'user_2owner000000000000000000000'
const RECIPIENT = 'user_2recipient0000000000000000'

function userTurn(chatId: string, userId: string) {
  return { chatId, userId, senderType: 'user', agentOrigin: null }
}

describe('acting user: who the daemon names', () => {
  test('before any inbound (a proactive call) it is the owner and no header is sent', () => {
    const t = createActingUserTracker({ ownerUserId: OWNER })
    expect(t.current()).toBe(OWNER)
    expect(t.currentChatId()).toBeNull()
    expect(t.headers()).toEqual({})
  })

  test('the owner turn sends no header', () => {
    const t = createActingUserTracker({ ownerUserId: OWNER })
    t.noteInbound(userTurn('chat-1', OWNER))
    expect(t.current()).toBe(OWNER)
    expect(t.currentChatId()).toBe('chat-1')
    expect(t.headers()).toEqual({})
  })

  test('a shared recipient turn names the recipient', () => {
    const t = createActingUserTracker({ ownerUserId: OWNER })
    t.noteInbound(userTurn('chat-2', RECIPIENT))
    expect(t.current()).toBe(RECIPIENT)
    expect(t.currentChatId()).toBe('chat-2')
    expect(t.headers()).toEqual({ [ACTING_USER_HEADER]: RECIPIENT })
  })

  test('the pointer follows the most recent user turn in either direction', () => {
    const t = createActingUserTracker({ ownerUserId: OWNER })
    t.noteInbound(userTurn('chat-2', RECIPIENT))
    t.noteInbound(userTurn('chat-1', OWNER))
    expect(t.headers()).toEqual({})
    t.noteInbound(userTurn('chat-2', RECIPIENT))
    expect(t.headers()).toEqual({ [ACTING_USER_HEADER]: RECIPIENT })
  })

  test('a peer agent inbound never moves it', () => {
    const t = createActingUserTracker({ ownerUserId: OWNER })
    t.noteInbound(userTurn('chat-2', RECIPIENT))
    t.noteInbound({ chatId: 'chat-9', userId: 'user_peer_owner', senderType: 'agent', agentOrigin: null })
    expect(t.current()).toBe(RECIPIENT)
    expect(t.currentChatId()).toBe('chat-2')
  })

  test('a peer carried under a user label never moves it', () => {
    const t = createActingUserTracker({ ownerUserId: OWNER })
    t.noteInbound(userTurn('chat-2', RECIPIENT))
    t.noteInbound({
      chatId: 'chat-9',
      userId: 'user_peer_owner',
      senderType: 'user',
      agentOrigin: { sourceAssistantId: 77 },
    })
    expect(t.current()).toBe(RECIPIENT)
  })

  test('a system inbound never moves it', () => {
    const t = createActingUserTracker({ ownerUserId: OWNER })
    t.noteInbound(userTurn('chat-2', RECIPIENT))
    t.noteInbound({ chatId: 'chat-2', userId: OWNER, senderType: 'system', agentOrigin: null })
    expect(t.current()).toBe(RECIPIENT)
  })

  test('an inbound without a chat id or a sender id never moves it', () => {
    const t = createActingUserTracker({ ownerUserId: OWNER })
    t.noteInbound(userTurn('chat-2', RECIPIENT))
    t.noteInbound(userTurn('', OWNER))
    t.noteInbound(userTurn('chat-3', '  '))
    expect(t.current()).toBe(RECIPIENT)
    expect(t.currentChatId()).toBe('chat-2')
  })

  test('onChange fires only when the acting user actually changes', () => {
    const seen: Array<[string, string]> = []
    const t = createActingUserTracker({
      ownerUserId: OWNER,
      onChange: (next, prev) => seen.push([next.userId, prev]),
    })
    t.noteInbound(userTurn('chat-1', OWNER))
    t.noteInbound(userTurn('chat-2', RECIPIENT))
    t.noteInbound(userTurn('chat-2', RECIPIENT))
    t.noteInbound(userTurn('chat-1', OWNER))
    expect(seen).toEqual([
      [RECIPIENT, OWNER],
      [OWNER, RECIPIENT],
    ])
  })

  test('the header name is the one the backend reads (lowercased on arrival)', () => {
    expect(ACTING_USER_HEADER.toLowerCase()).toBe('x-bgos-acting-user')
  })

  test('actingUserHeaders trims, and drops a blank or owner id', () => {
    expect(actingUserHeaders('', OWNER)).toEqual({})
    expect(actingUserHeaders('   ', OWNER)).toEqual({})
    expect(actingUserHeaders(OWNER, OWNER)).toEqual({})
    expect(actingUserHeaders(`  ${RECIPIENT}  `, OWNER)).toEqual({ [ACTING_USER_HEADER]: RECIPIENT })
  })

  test('isUserTurn is the exact gate', () => {
    expect(isUserTurn({ senderType: 'user', agentOrigin: null })).toBe(true)
    expect(isUserTurn({ senderType: 'user', agentOrigin: undefined })).toBe(true)
    expect(isUserTurn({ senderType: 'user', agentOrigin: {} })).toBe(false)
    expect(isUserTurn({ senderType: 'agent', agentOrigin: null })).toBe(false)
    expect(isUserTurn({ senderType: 'system', agentOrigin: null })).toBe(false)
    expect(isUserTurn({ senderType: 'assistant', agentOrigin: null })).toBe(false)
    expect(isUserTurn({ senderType: 'unknown', agentOrigin: null })).toBe(false)
    expect(isUserTurn({ senderType: null, agentOrigin: null })).toBe(false)
  })
})

describe('acting user on the boards wire', () => {
  type Init = { method: string; headers: Record<string, string>; body?: string }

  function wire(tracker: ReturnType<typeof createActingUserTracker>) {
    const seen: Array<{ url: string; init: Init }> = []
    const fetchImpl = async (url: string, init: Init) => {
      seen.push({ url, init })
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => '{"markdown":"ok"}',
      }
    }
    const t = createBoardsTransports({
      apiBase: 'https://api.example/api/v1',
      headers: () => ({ 'X-BGOS-Pairing': 'tok', ...tracker.headers() }),
      fetchImpl: fetchImpl as never,
    })
    return { seen, ...t }
  }

  test('owner turn: only the auth header, byte-identical to before', async () => {
    const tracker = createActingUserTracker({ ownerUserId: OWNER })
    tracker.noteInbound(userTurn('chat-1', OWNER))
    const w = wire(tracker)
    await w.bgosPost('integrations/assistants/42/boards', { name: 'Ops' })
    expect(w.seen[0]!.init.headers).toEqual({
      'X-BGOS-Pairing': 'tok',
      'Content-Type': 'application/json',
    })
  })

  test('recipient turn: the auth header plus X-BGOS-Acting-User naming them', async () => {
    const tracker = createActingUserTracker({ ownerUserId: OWNER })
    tracker.noteInbound(userTurn('chat-2', RECIPIENT))
    const w = wire(tracker)
    await w.bgosPost('integrations/assistants/42/boards', { name: 'Ops' })
    expect(w.seen[0]!.init.headers).toEqual({
      'X-BGOS-Pairing': 'tok',
      'X-BGOS-Acting-User': RECIPIENT,
      'Content-Type': 'application/json',
    })
  })

  test('proactive call: no inbound seen, no header', async () => {
    const w = wire(createActingUserTracker({ ownerUserId: OWNER }))
    await w.bgosGet('integrations/assistants/42/boards')
    expect(w.seen[0]!.init.headers).toEqual({ 'X-BGOS-Pairing': 'tok' })
  })

  test('the header is read fresh on every call, not captured when the transports are built', async () => {
    const tracker = createActingUserTracker({ ownerUserId: OWNER })
    const w = wire(tracker)
    tracker.noteInbound(userTurn('chat-2', RECIPIENT))
    await w.bgosGet('integrations/assistants/42/boards')
    tracker.noteInbound(userTurn('chat-1', OWNER))
    await w.bgosGet('integrations/assistants/42/boards')
    expect(w.seen[0]!.init.headers['X-BGOS-Acting-User']).toBe(RECIPIENT)
    expect(w.seen[1]!.init.headers['X-BGOS-Acting-User']).toBeUndefined()
  })
})

describe('server.ts wiring', () => {
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'server.ts'),
    'utf8',
  )

  test('the boards transports compose the acting user header', () => {
    expect(src).toContain(
      'headers: () => ({ ...authHeaders(AUTH), ...actingUser.headers() })',
    )
  })

  test('the tracker falls back to the configured owner', () => {
    expect(src).toContain('createActingUserTracker({')
    expect(src).toContain('ownerUserId: USER_ID,')
  })

  test('every inbound sender write also notes the acting user', () => {
    const writes = (src.match(/lastInboundUserByChat\.set\(/g) ?? []).length
    const notes = (src.match(/actingUser\.noteInbound\(/g) ?? []).length
    expect(writes).toBe(3)
    expect(notes).toBe(writes)
  })
})
