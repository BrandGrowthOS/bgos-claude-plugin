/** The canonical real-child context cases run against the exact vendored shim. */
import { createRequire } from 'node:module'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const previous = process.env.HOAI_SHIM_TEST_PATH
process.env.HOAI_SHIM_TEST_PATH = join(process.cwd(), 'bin', 'hoai-browser-mcp.mjs')
try {
  // Byte copy of BGOS agent-browser/__tests__/shim.managed-context.test.js.
  require('./helpers/browser-managed-context.cjs')
} finally {
  if (previous === undefined) delete process.env.HOAI_SHIM_TEST_PATH
  else process.env.HOAI_SHIM_TEST_PATH = previous
}
