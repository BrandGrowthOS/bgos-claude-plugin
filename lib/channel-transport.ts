/**
 * The channel's protocol era, pinned.
 *
 * Claude Code decides whether an MCP server may push an UNSOLICITED
 * notification at it from the protocol revision the two of them negotiated at
 * initialize. A revision it considers modern is refused with the reason
 * 'connection negotiated a modern protocol revision with no unsolicited
 * notification path', and a channel push IS an unsolicited notification, so
 * that refusal is every inbound BGOS message on this channel, dropped with
 * nothing on screen and nothing in any log.
 *
 * The SDK answers initialize with whatever revision the CLIENT asked for
 * whenever it supports it (server/index.js `_oninitialize`), so today the era
 * this channel lives in is decided by the CLI's own request and by the SDK
 * version a `bun install` happened to resolve. Both move without this repo.
 * That is fine until the day one of them crosses the line, and then the
 * daemon goes deaf with no error to read. This file takes the decision back:
 * the daemon answers the LEGACY revision, which the stage 6 gate probe drove
 * live against a real session (Claude Code 2.1.278 asked for 2025-11-25, was
 * answered 2025-06-18, and delivered the push).
 *
 * It is a wrapper and not a replacement, on purpose. The SDK's own handler
 * still runs and still does its bookkeeping (the client's capabilities and
 * version are recorded there); only the one field is overwritten on the way
 * out. And when a future SDK no longer registers an initialize handler at
 * all, this FAILS OPEN and changes nothing: a channel in the wrong era still
 * delivers outbound replies, while a handshake this file invented could
 * deliver nothing at all.
 *
 * test/channel-transport.test.ts drives both halves over a real in memory
 * transport, including the control that shows an unpinned server echoing.
 */

/** The revision this daemon answers initialize with, always. */
export const CHANNEL_PROTOCOL_REVISION = '2025-06-18'

type RequestHandler = (request: unknown, extra: unknown) => unknown

/**
 * Wrap an MCP server's initialize handler so its answer always carries
 * CHANNEL_PROTOCOL_REVISION. Returns true when the pin was installed, false
 * when there was nothing to wrap (and then the server keeps the SDK's own
 * answer). Never throws.
 *
 * The parameter is `unknown` because the handler map is the SDK's own
 * internal field: naming the type would not make reaching into it any more
 * supported, and the false return is what makes reaching into it safe.
 */
export function pinChannelProtocolRevision(server: unknown): boolean {
  try {
    const handlers = (server as { _requestHandlers?: unknown })?._requestHandlers
    if (!(handlers instanceof Map)) return false
    const sdkInitialize = handlers.get('initialize') as RequestHandler | undefined
    if (typeof sdkInitialize !== 'function') return false
    handlers.set('initialize', async (request: unknown, extra: unknown) => {
      const result = await sdkInitialize(request, extra)
      if (result === null || typeof result !== 'object') return result
      return {
        ...(result as Record<string, unknown>),
        protocolVersion: CHANNEL_PROTOCOL_REVISION,
      }
    })
    return true
  } catch {
    return false
  }
}
