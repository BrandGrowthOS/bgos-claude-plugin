import type { Manager } from 'socket.io-client'

export const SOCKET_LIVENESS_GRACE_MS = 5_000

/**
 * Observe Engine.IO packets, including pings on an otherwise idle connection.
 * Closing the transport keeps the Manager's jittered backoff and the Socket's
 * normal connect/catch-up handlers. A Socket.disconnect() would disable that
 * recovery; Engine.close() can wait forever for a stalled write buffer to drain.
 */
export function watchSocketLiveness(manager: Manager, log: (line: string) => void): () => void {
  let detachEngine = () => {}

  const onOpen = () => {
    detachEngine()
    const engine = manager.engine
    // Engine.IO emits handshake before Manager.open, and retains its negotiated
    // interval in this field. Keep the version-sensitive read here, covered by
    // a real Socket.IO handshake test. Never guess a shorter interval if absent.
    const interval = (engine as unknown as { _pingInterval?: number })._pingInterval
    if (engine.readyState !== 'open' || typeof interval !== 'number' || !Number.isFinite(interval) || interval <= 0) return
    const deadlineMs = interval + SOCKET_LIVENESS_GRACE_MS
    let timer: ReturnType<typeof setTimeout> | undefined
    let stopped = false

    const stop = () => {
      stopped = true
      clearTimeout(timer)
      engine.off('packet', onPacket)
      engine.off('close', stop)
    }
    const onPacket = () => {
      if (stopped) return
      clearTimeout(timer)
      timer = setTimeout(() => {
        // Detach before closing, so queued callbacks or old engines cannot
        // log twice or schedule a second reconnect during the Manager backoff.
        stop()
        if (manager.engine !== engine || engine.readyState !== 'open') return
        log(`WS dead link: no incoming packet for ${deadlineMs}ms; reconnecting`)
        engine.transport.close()
      }, deadlineMs)
      timer.unref?.()
    }

    detachEngine = stop
    engine.on('packet', onPacket)
    engine.on('close', stop)
    onPacket()
  }

  manager.on('open', onOpen)
  if (manager.engine?.readyState === 'open') onOpen()
  return () => {
    manager.off('open', onOpen)
    detachEngine()
  }
}
