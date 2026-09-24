/**
 * A stand-in for the BGOS backend's side of the browser host lane, built from
 * the shipped code and nothing else:
 *
 *   - the gateway's `browser_host` branch (websocket.gateway.ts
 *     `connectBrowserHost`): the pairing token is read from the handshake
 *     QUERY, `role` and `agents` from the handshake AUTH; the listed agents
 *     are narrowed to the ones bound to this pairing (`admissible` here, the
 *     BROWSER_HOST_ADMISSIBLE_AGENTS_SQL read there) and a socket left with
 *     none, or with a bad token, is disconnected server side;
 *   - the relay's frame (agent-browser-relay.service.ts `relay`): event
 *     `browser_rpc`, fields event_type, rpcId, clientId, assistantId,
 *     assistantName, message, deadlineAt, plus `principal` when given;
 *   - the result route (agent-browser-host.controller.ts and `handleResult`):
 *     POST /api/v1/browser/rpc/:rpcId/result, accepted (200 `{ ok: true }`)
 *     only for a pending rpcId, from the pairing the frame's host connected
 *     with (X-BGOS-Pairing), naming the socket the frame went to; anything
 *     else is 404 "Unknown browser call".
 *
 * Everything it sees is recorded so a test can assert the wire, not just the
 * outcome.
 */

import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Server, type Socket } from 'socket.io'

export interface HostHandshake {
  socketId: string
  query: Record<string, unknown>
  auth: Record<string, unknown>
  admitted: number[]
  refused: boolean
}

export interface ResultPost {
  rpcId: string
  headers: Record<string, string | string[] | undefined>
  body: any
  status: number
}

export interface FakeRelayOptions {
  /** The one pairing token this backend knows. */
  token: string
  /** The agents bound to that pairing; the rest of a handshake's list is dropped. */
  admissible: number[]
}

export interface RpcRequest {
  assistantId: number
  clientId: string
  message: Record<string, unknown>
  principal?: unknown
  assistantName?: string
}

export async function startFakeRelay(opts: FakeRelayOptions) {
  const handshakes: HostHandshake[] = []
  const posts: ResultPost[] = []
  const pending = new Map<string, { socketId: string; resolve: (p: ResultPost) => void }>()
  const hosts: Socket[] = []
  const hostWaiters: Array<(s: Socket) => void> = []

  /**
   * The permission gate's two routes, because a real host always has them.
   *
   * Without these the end to end case could not reach the owner at all, and
   * every browser_ call in it came back policy_denied with
   * "could not be asked", which is the host failing closed correctly and
   * proving nothing about browsing. They are modelled on the real ones:
   * `X-BGOS-Pairing` must match, the card is stored open, and the READ is
   * scoped by assistantId so a host asking about another agent's gate gets
   * `unknown` here exactly as it would in production.
   *
   * `answerGate` is the owner tapping a button.
   */
  let autoAnswerWith: string | null = null
  const gateCards: Array<Record<string, any>> = []
  const gateState = new Map<string, { assistantId: number; state: string; choice: string | null }>()
  const gateKey = (gateId: string, assistantId: number) => `${assistantId}:${gateId}`

  const http = createServer((req: IncomingMessage, res: ServerResponse) => {
    const json = (status: number, body: unknown) => {
      res.statusCode = status
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify(body))
    }
    const authed = req.headers['x-bgos-pairing'] === opts.token
    const url = req.url ?? ''

    if (req.method === 'POST' && url === '/api/v1/browser/gate/card') {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        let body: any = null
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        } catch {}
        if (!authed || !body?.socketId) {
          json(403, { message: 'not a host of this account' })
          return
        }
        // VALIDATE WHAT THE REAL DTO VALIDATES. A fake that accepts anything
        // is worse than no fake: the host shipped a card with no `choices`
        // for a round, this route took it happily, and only an assertion on
        // the stored card caught what production would have answered 400 to.
        // PostBrowserGateCardDto, field for field.
        const bad =
          !/^g_[A-Za-z0-9_-]{4,64}$/.test(String(body.gateId)) ||
          !Number.isInteger(body.assistantId) ||
          body.assistantId <= 0 ||
          !['navigate', 'write', 'sensitive', 'credential', 'download', 'upload', 'evaluate'].includes(body.kind) ||
          typeof body.summary !== 'string' ||
          body.summary.length < 1 ||
          body.summary.length > 500 ||
          !Number.isInteger(body.waitSeconds) ||
          body.waitSeconds < 1 ||
          body.waitSeconds > 1800 ||
          !Array.isArray(body.choices) ||
          body.choices.length < 1 ||
          body.choices.some((c: unknown) => !['allow_once', 'allow_session', 'always_allow', 'trust_site', 'deny'].includes(String(c)))
        if (bad) {
          json(400, { message: 'Bad Request', body })
          return
        }
        gateCards.push(body)
        gateState.set(gateKey(body.gateId, body.assistantId), {
          assistantId: body.assistantId,
          state: autoAnswerWith ? 'answered' : 'open',
          choice: autoAnswerWith,
        })
        json(200, { ok: true })
      })
      return
    }

    const readMatch = /^\/api\/v1\/browser\/gate\/([^/?]+)\?(.*)$/.exec(url)
    if (req.method === 'GET' && readMatch) {
      const gateId = decodeURIComponent(readMatch[1]!)
      const q = new URLSearchParams(readMatch[2]!)
      const assistantId = Number(q.get('assistantId'))
      if (!authed || !q.get('socketId') || !Number.isFinite(assistantId)) {
        json(403, { message: 'not a host of this account' })
        return
      }
      const found = gateState.get(gateKey(gateId, assistantId))
      json(200, found ? { gateId, state: found.state, choice: found.choice } : { gateId, state: 'unknown', choice: null })
      return
    }

    const m = /^\/api\/v1\/browser\/rpc\/([^/]+)\/result$/.exec(url)
    if (req.method !== 'POST' || !m) {
      res.statusCode = 404
      res.end()
      return
    }
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const rpcId = decodeURIComponent(m[1])
      let body: any = null
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {}
      const entry = pending.get(rpcId)
      const accepted =
        !!entry && req.headers['x-bgos-pairing'] === opts.token && !!body && body.socketId === entry.socketId && typeof body.ok === 'boolean'
      const post: ResultPost = { rpcId, headers: req.headers, body, status: accepted ? 200 : 404 }
      posts.push(post)
      res.statusCode = post.status
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify(accepted ? { ok: true } : { statusCode: 404, message: 'Unknown browser call' }))
      if (accepted) {
        pending.delete(rpcId)
        entry!.resolve(post)
      }
    })
  })
  const io = new Server(http)
  io.on('connection', (socket) => {
    const query = { ...(socket.handshake.query as Record<string, unknown>) }
    const auth = { ...(socket.handshake.auth as Record<string, unknown>) }
    const listed = Array.isArray(auth.agents) ? (auth.agents as unknown[]).map(Number) : []
    const admitted = auth.role === 'browser_host' && query.pairingToken === opts.token ? listed.filter((id) => opts.admissible.includes(id)) : []
    const refused = admitted.length === 0
    handshakes.push({ socketId: socket.id, query, auth, admitted, refused })
    if (refused) {
      socket.disconnect(true)
      return
    }
    ;(socket.data as { admitted: number[] }).admitted = admitted
    hosts.push(socket)
    socket.on('disconnect', () => {
      const i = hosts.indexOf(socket)
      if (i >= 0) hosts.splice(i, 1)
    })
    const waiter = hostWaiters.shift()
    if (waiter) waiter(socket)
  })
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', () => resolve()))
  const port = (http.address() as AddressInfo).port
  const url = `http://127.0.0.1:${port}`

  return {
    url,
    /** What a daemon's credentials file carries: the base with /api/v1. */
    backendUrl: `${url}/api/v1`,
    handshakes,
    posts,

    /** Every permission card the host has posted, newest last. */
    gateCards,

    /**
     * The owner tapping a button on a card, or the card expiring. The host's
     * next poll reads it, exactly as it reads a real answer.
     *
     * With no gateId it answers the MOST RECENT card, which is what a test
     * driving one action at a time wants; the host mints the id, so a test
     * cannot know it in advance without reaching into gateCards first.
     */
    answerGate(choice: string | null, { gateId, state = 'answered' }: { gateId?: string; state?: string } = {}) {
      const card = gateId ? gateCards.find((c) => c.gateId === gateId) : gateCards.at(-1)
      if (!card) throw new Error('no permission card has been posted, so there is nothing to answer')
      gateState.set(gateKey(String(card.gateId), Number(card.assistantId)), {
        assistantId: Number(card.assistantId),
        state,
        choice,
      })
      return String(card.gateId)
    },

    /**
     * Answer every card the host posts from now on, the moment it posts one.
     * For a case that is about BROWSING and simply needs the owner out of the
     * way, rather than about the gate itself.
     */
    autoAnswer(choice = 'allow_session') {
      autoAnswerWith = choice
    },

    /** The next admitted host socket (or one already connected). */
    waitForHost(timeoutMs = 20_000): Promise<Socket> {
      const live = hosts.find((s) => s.connected)
      if (live) return Promise.resolve(live)
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no browser host connected')), timeoutMs)
        hostWaiters.push((s) => {
          clearTimeout(timer)
          resolve(s)
        })
      })
    },

    /**
     * Emits one browser_rpc frame at a host socket, shaped as the relay
     * shapes it, and resolves with the accepted result post, or null when
     * none arrives within `waitMs` (the right outcome for a notification).
     */
    async rpc(socket: Socket, req: RpcRequest, waitMs = 60_000): Promise<{ frame: Record<string, unknown>; post: ResultPost | null }> {
      const rpcId = randomUUID()
      const frame: Record<string, unknown> = {
        event_type: 'browser_rpc',
        rpcId,
        clientId: req.clientId,
        assistantId: req.assistantId,
        assistantName: req.assistantName ?? 'Data',
        message: req.message,
        deadlineAt: new Date(Date.now() + 130_000).toISOString(),
      }
      if ('principal' in req) frame.principal = req.principal
      const answered = new Promise<ResultPost>((resolve) => pending.set(rpcId, { socketId: socket.id, resolve }))
      socket.emit('browser_rpc', frame)
      let timer: ReturnType<typeof setTimeout> | undefined
      const post = await Promise.race([
        answered,
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), waitMs)
        }),
      ])
      clearTimeout(timer)
      if (!post) pending.delete(rpcId)
      return { frame, post }
    },

    /** Every post for an rpcId, accepted or not. */
    postsFor(rpcId: string): ResultPost[] {
      return posts.filter((p) => p.rpcId === rpcId)
    },

    async close() {
      io.disconnectSockets(true)
      // io.close() closes the http server too. Under bun that close waits on
      // kept-alive POST connections, so they are cut first; a server that is
      // already closed never calls back there, hence no second http.close().
      http.closeAllConnections?.()
      await new Promise<void>((resolve) => io.close(() => resolve()))
    },
  }
}

export type FakeRelay = Awaited<ReturnType<typeof startFakeRelay>>
