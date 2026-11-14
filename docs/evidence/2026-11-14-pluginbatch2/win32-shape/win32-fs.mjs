// node:fs as a Windows runner treats a folder's mode: chmod changes nothing that stops a write.
import fs from 'node:fs'

export * from 'node:fs'
export function chmodSync() {}
export default { ...fs, chmodSync }
