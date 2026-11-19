/**
 * A stand in for the Anthropic Messages API, for tests that run the REAL
 * Claude Code CLI with ANTHROPIC_BASE_URL pointed here and a made up key: no
 * real account, no real key, no network past 127.0.0.1.
 *
 * Every POST /v1/messages is answered with one text block (streamed as server
 * sent events when the request asks for a stream), so a `claude -p` turn ends
 * with that text as its result. An answer may instead be one tool call, which
 * the CLI runs before it asks again. Anything else gets an empty JSON object.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface FakeAnthropicApi {
  url: string
  /** The requests to /v1/messages, newest last (the parsed bodies). */
  requests: Array<Record<string, unknown>>
  close(): Promise<void>
}

/** What the stand in says: a text, or one call of a tool the request offers. */
export type FakeAnswer = string | { toolUse: { name: string; input: Record<string, unknown> } }

export async function startFakeAnthropicApi(answer: (body: Record<string, unknown>, n: number) => FakeAnswer): Promise<FakeAnthropicApi> {
  const requests: Array<Record<string, unknown>> = []
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const path = new URL(req.url ?? '/', 'http://api').pathname
      if (req.method !== 'POST' || !path.endsWith('/v1/messages')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end('{}')
        return
      }
      let body: Record<string, unknown> = {}
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
      } catch {}
      requests.push(body)
      const said = answer(body, requests.length)
      const id = `msg_fake_${requests.length}`
      const tool = typeof said === 'string' ? null : { type: 'tool_use', id: `toolu_${id}`, name: said.toolUse.name, input: said.toolUse.input }
      const text = typeof said === 'string' ? said : ''
      const stop = tool ? 'tool_use' : 'end_turn'
      const model = typeof body.model === 'string' ? body.model : 'claude-test'
      const usage = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
      if (body.stream !== true) {
        res.writeHead(200, { 'Content-Type': 'application/json', 'request-id': `req_${id}` })
        res.end(
          JSON.stringify({
            id,
            type: 'message',
            role: 'assistant',
            model,
            content: [tool ?? { type: 'text', text }],
            stop_reason: stop,
            stop_sequence: null,
            usage,
          }),
        )
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'request-id': `req_${id}` })
      const send = (event: string, data: Record<string, unknown>) => res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`)
      send('message_start', {
        message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage },
      })
      send('content_block_start', { index: 0, content_block: tool ? { ...tool, input: {} } : { type: 'text', text: '' } })
      send('content_block_delta', { index: 0, delta: tool ? { type: 'input_json_delta', partial_json: JSON.stringify(tool.input) } : { type: 'text_delta', text } })
      send('content_block_stop', { index: 0 })
      send('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } })
      send('message_stop', {})
      res.end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    url,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.()
        server.close(() => resolve())
      }),
  }
}
