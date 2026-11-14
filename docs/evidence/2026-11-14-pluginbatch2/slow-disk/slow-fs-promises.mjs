// node:fs/promises with a slow writeFile (see hooks.mjs).
import fsp from 'node:fs/promises'

const ms = Number(process.env.SLOW_DISK_MS ?? 150)
export * from 'node:fs/promises'
export async function writeFile(...args) {
  await new Promise((r) => setTimeout(r, ms))
  return fsp.writeFile(...args)
}
export default { ...fsp, writeFile }
