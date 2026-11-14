// A slow disk for the named files, on any OS (ROUND PLUGINBATCH2, 2026-11-14): node:fs/promises writeFile takes
// SLOW_DISK_MS longer (default 150), as a loaded Windows runner with a virus scanner can. SLOW_DISK_FILES is a comma
// separated list of importer path endings. Used to show the email lane tests' fixed sleeps race the file save.
const files = (process.env.SLOW_DISK_FILES ?? '').split(',').map((s) => s.trim()).filter(Boolean)

export async function resolve(specifier, context, next) {
  if ((specifier === 'node:fs/promises' || specifier === 'fs/promises') && typeof context.parentURL === 'string' &&
    files.some((end) => context.parentURL.endsWith(end))) {
    return { url: new URL('./slow-fs-promises.mjs', import.meta.url).href, shortCircuit: true }
  }
  return next(specifier, context)
}
