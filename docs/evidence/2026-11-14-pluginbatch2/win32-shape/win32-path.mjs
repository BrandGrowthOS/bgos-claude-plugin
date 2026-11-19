// node:path as a Windows runner sees it.
import path from 'node:path'

const w = path.win32
export default w
export const { basename, delimiter, dirname, extname, format, isAbsolute, join, normalize, parse, posix, relative, resolve, sep, toNamespacedPath, win32 } = w
