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

  const http = createServer((req: IncomingMessage, res: ServerResponse) => {
    const m = /^\/api\/v1\/browser\/rpc\/([^/]+)\/result$/.exec(req.url ?? '')
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
