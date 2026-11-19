import * as host from '../../lib/vault-host.mjs'
import * as fs from 'node:fs'

export * from '../../lib/vault-host.mjs'

// Unit and contract tests never need a Windows subprocess. POSIX still checks
// real owner/mode bits, and Windows policy tests supply their own ACLs.
/** @type {import('../../lib/vault-host.mjs').VaultSecurity} */
export const testSecurity = {
  platform: process.platform,
  async readWindowsAcl() {
    return { ownerSid: 'S-1-5-21-1000', userSid: 'S-1-5-21-1000', protected: true,
      entries: [{ sid: 'S-1-5-21-1000', type: 'Allow', rights: 2032127 }] }
  },
  async restrictWindowsAcl() {},
}

export const readHostRecord = (dir, io = fs, security = testSecurity) => host.readHostRecord(dir, io, security)
export const loadOrCreateHostKey = (dir, id, io = fs, security = testSecurity) => host.loadOrCreateHostKey(dir, id, io, security)
export const provisionSigningIdentity = (dir, id, secret, io = fs, security = testSecurity) => host.provisionSigningIdentity(dir, id, secret, io, security)
export const confirmHostPin = (dir, io = fs, security = testSecurity) => host.confirmHostPin(dir, io, security)
export const registerHostKey = options => host.registerHostKey({ security: testSecurity, ...options })
