// The production channelNotify for a harness that runs server.ts code over its own mcp double (0.86.20): the card is a
// builder, sent through the REAL scheduled run hold (lib/schedule-grant-run.mjs) with no run open, so it is built when
// it goes out and reaches the double exactly as before. The double is read at send time, so a test that swaps it later
// is followed.
import { createScheduleGrantRuns, holdChannelCardsDuringGrantedRun } from '../../lib/schedule-grant-run.mjs'

type McpLike = { notification: (notification: any) => unknown }

export function channelNotifyFor(getMcp: () => McpLike) {
  const runs = createScheduleGrantRuns()
  const hold = holdChannelCardsDuringGrantedRun(runs, (notification: unknown) => getMcp().notification(notification) as Promise<unknown>)
  return (build: () => unknown, options: Record<string, unknown> = {}) =>
    Promise.resolve(hold({ method: 'notifications/claude/channel', params: build, ...options }))
}
