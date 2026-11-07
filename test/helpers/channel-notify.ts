// The production channelNotify for a harness that runs server.ts code over its own mcp double (0.86.20): the card is a
// builder, sent through the REAL scheduled run hold (lib/schedule-grant-run.mjs). The double is read at send time, so
// a test that swaps it later is followed. Every harness shares one run store: none is open unless a test opens one
// (scheduleGrantRunsForTest), so a card is built when it goes out and reaches the double exactly as before. A test
// that opens a run drives the REAL lanes under it (round 4, F4).
import { createScheduleGrantRuns, holdChannelCardsDuringGrantedRun } from '../../lib/schedule-grant-run.mjs'

type McpLike = { notification: (notification: any) => unknown }

let shared = createScheduleGrantRuns()

/** A fresh shared run store for the harnesses' channelNotify, with these options (a clock, onEnded). */
export function scheduleGrantRunsForTest(options: Parameters<typeof createScheduleGrantRuns>[0] = {}) {
  shared = createScheduleGrantRuns(options)
  return shared
}

export function channelNotifyFor(getMcp: () => McpLike) {
  return (build: () => unknown, options: Record<string, unknown> = {}) => {
    const hold = holdChannelCardsDuringGrantedRun(shared, (notification: unknown) => getMcp().notification(notification) as Promise<unknown>)
    return Promise.resolve(hold({ method: 'notifications/claude/channel', params: build, ...options }))
  }
}
