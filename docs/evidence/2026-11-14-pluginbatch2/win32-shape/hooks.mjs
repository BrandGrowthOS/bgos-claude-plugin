// Windows shaped imports for the named files, on any OS (ROUND PLUGINBATCH2, 2026-11-14).
// Each variable is a comma separated list of path endings; an importer whose URL ends with one of them gets:
//   WIN32_PATH_FILES: node:path -> path.win32 (join, dirname, normalize ... give backslashes, as on a Windows runner).
//     Only for code that keeps paths in memory: real disk paths built this way on macOS or Linux name the wrong file.
//   WIN32_FS_FILES:   node:fs -> node:fs with chmodSync a no-op (Windows ignores a folder's POSIX mode bits).
// Everything else resolves as usual. Registered by register.mjs.
const list = (name) => (process.env[name] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
const pathFiles = list('WIN32_PATH_FILES')
const fsFiles = list('WIN32_FS_FILES')
const from = (files, parentURL) => typeof parentURL === 'string' && files.some((end) => parentURL.endsWith(end))

export async function resolve(specifier, context, next) {
  if ((specifier === 'node:path' || specifier === 'path') && from(pathFiles, context.parentURL)) {
    return { url: new URL('./win32-path.mjs', import.meta.url).href, shortCircuit: true }
  }
  if ((specifier === 'node:fs' || specifier === 'fs') && from(fsFiles, context.parentURL)) {
    return { url: new URL('./win32-fs.mjs', import.meta.url).href, shortCircuit: true }
  }
  return next(specifier, context)
}
