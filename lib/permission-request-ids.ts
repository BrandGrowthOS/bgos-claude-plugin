/**
 * THE PERMISSION REQUEST IDS THAT ARE LIVE IN THIS DAEMON, from every producer.
 *
 * A request id is five letters. The CLI mints the ids of its own permission
 * requests, and this daemon mints the ids of the group lanes' prompts
 * (server.ts reserveGroupPermissionRequestId). The relay that posts a request's
 * card and waits for its answer is asynchronous, and the verdict it sends back
 * names only the id. So two live operations under one id would share one
 * pending entry, one card binding and one verdict.
 *
 * This registry is the one place an id is held. A producer claims the id
 * before any asynchronous step and releases it when the request has ended:
 *   - a claim on a free id reserves it (`reserved`);
 *   - a claim from the same producer with the same request (same tool,
 *     description and preview) while the id is held is the same request sent
 *     again (`retransmission`): it is joined to the one already open, which
 *     answers it;
 *   - any other claim on a held id (`collision`) cannot be told apart from
 *     the open request by its verdict, so the newcomer is denied and the open
 *     request is marked `collided`: it ends in a deny and can no longer be
 *     allowed (server.ts groupNotificationStep reads the mark).
 * A reservation is released only by the object that holds it, so a late
 * release by an ended request never frees a newer request's id.
 */

export type PermissionProducer = 'cli' | 'group'

export interface PermissionReservation {
  readonly requestId: string
  readonly producer: PermissionProducer
  readonly fingerprint: string
  /** Set when another request claimed this id while it was open. */
  collided: boolean
}

export type PermissionClaim =
  | { kind: 'reserved'; reservation: PermissionReservation }
  | { kind: 'retransmission'; holder: PermissionReservation }
  | { kind: 'collision'; holder: PermissionReservation }

export interface PermissionRequestIds {
  claim(requestId: string, producer: PermissionProducer, fingerprint: string): PermissionClaim
  /** Frees the id only when `reservation` is the one holding it. */
  release(reservation: PermissionReservation): boolean
  /** Is `reservation` still the one holding its id. */
  holds(reservation: PermissionReservation): boolean
  has(requestId: string): boolean
  /** Is the request open under this id marked by a collision. */
  collided(requestId: string): boolean
}

/** What makes two requests the same request: its tool, description and preview. */
export function permissionRequestFingerprint(params: {
  tool_name: string
  description: string
  input_preview?: string
}): string {
  return JSON.stringify([params.tool_name, params.description, params.input_preview ?? null])
}

export function createPermissionRequestIds(): PermissionRequestIds {
  const live = new Map<string, PermissionReservation>()
  return {
    claim(requestId, producer, fingerprint) {
      const holder = live.get(requestId)
      if (!holder) {
        const reservation: PermissionReservation = { requestId, producer, fingerprint, collided: false }
        live.set(requestId, reservation)
        return { kind: 'reserved', reservation }
      }
      if (!holder.collided && holder.producer === producer && holder.fingerprint === fingerprint) {
        return { kind: 'retransmission', holder }
      }
      holder.collided = true
      return { kind: 'collision', holder }
    },
    release(reservation) {
      if (live.get(reservation.requestId) !== reservation) return false
      live.delete(reservation.requestId)
      return true
    },
    holds(reservation) {
      return live.get(reservation.requestId) === reservation
    },
    has(requestId) {
      return live.has(requestId)
    },
    collided(requestId) {
      return live.get(requestId)?.collided === true
    },
  }
}

/**
 * Admit one request: reserve its id, run it, and release the id when it has
 * ended, however it ended. A retransmission runs nothing. A collision runs
 * nothing, denies the newcomer and ends the request that holds the id
 * (`endHolder`), which ends in a deny.
 */
export async function admitPermissionRequest(opts: {
  ids: PermissionRequestIds
  requestId: string
  producer: PermissionProducer
  fingerprint: string
  run: () => unknown
  denyNewcomer: () => unknown
  endHolder: (holder: PermissionReservation) => void
  log: (line: string) => void
}): Promise<void> {
  const claim = opts.ids.claim(opts.requestId, opts.producer, opts.fingerprint)
  if (claim.kind === 'retransmission') {
    opts.log(`Permission request [${opts.requestId}] arrived again while it is open; the open request answers it`)
    return
  }
  if (claim.kind === 'collision') {
    opts.log(
      `Permission request [${opts.requestId}] names an id another open request holds ` +
        `(${claim.holder.producer}); both end in a deny`,
    )
    try {
      opts.endHolder(claim.holder)
    } finally {
      await opts.denyNewcomer()
    }
    return
  }
  const { reservation } = claim
  try {
    await opts.run()
  } finally {
    opts.ids.release(reservation)
  }
}
