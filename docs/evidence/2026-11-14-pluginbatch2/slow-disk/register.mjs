// node --import tsx --import ./docs/evidence/2026-11-14-pluginbatch2/slow-disk/register.mjs --test <file>
// with SLOW_DISK_FILES (and optionally SLOW_DISK_MS) set; see hooks.mjs.
import { register } from 'node:module'

register('./hooks.mjs', import.meta.url)
