/**
 * Warm the volume looks before a test file's checks read real folder identities.
 *
 * On Windows a file number counts as unknown until its volume's file system is known (lib/file-numbers.mjs), and
 * the look never blocks: the first identity on a volume is unknown while PowerShell answers. A running plugin asks
 * ahead at start (server.ts warmVolumes); a test file whose checks read real identities imports this helper first,
 * so it waits once for the temp folder's volume, the home folder's and this checkout's. Off Windows it does nothing.
 */
import { homedir, tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

import { warmVolumes } from '../../lib/file-numbers.mjs'

await warmVolumes([tmpdir(), homedir(), fileURLToPath(new URL('../../', import.meta.url))])
