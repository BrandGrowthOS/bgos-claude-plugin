/**
 * What `claude auth status --json` prints for a claude.ai login, in the key set of the CLI 2.1.330
 * (read from its program text, never run): no accountUuid, an organization id and the seat's email.
 * Every account test feeds this shape, so the account proof is tested on what the CLI really says.
 * The emails are fixture addresses on a reserved test domain; no real account is named.
 */

import { accountTokenFrom } from '../../lib/claude-account-id.mjs'

export const FIXTURE_ORG = '5d1a0c3e-7f42-4b9a-9c1e-0a7e3b2f6d10'

/** The CLI's answer for one seat. `email: null` leaves the key out; '' prints it empty. */
export function seatStatus(email: string | null, orgId: string | null = FIXTURE_ORG, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    loggedIn: true,
    authMethod: 'claude.ai',
    apiProvider: 'firstParty',
    ...(email === null ? {} : { email }),
    ...(orgId === null ? {} : { orgId }),
    orgName: 'Fixture Team',
    subscriptionType: 'team',
    ...extra,
  })
}

/** The one way token of a seat: `name` becomes <name>@seats.example.test in FIXTURE_ORG. */
export function seatToken(name: string, orgId: string = FIXTURE_ORG): string {
  return accountTokenFrom(seatStatus(`${name.toLowerCase()}@seats.example.test`, orgId))!
}
