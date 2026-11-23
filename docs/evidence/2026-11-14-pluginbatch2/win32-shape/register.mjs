// node --import tsx --import ./docs/evidence/2026-11-14-pluginbatch2/win32-shape/register.mjs --test <file>
// with WIN32_PATH_FILES and WIN32_FS_FILES naming the files that get Windows shaped imports (see hooks.mjs).
import { register } from 'node:module'

register('./hooks.mjs', import.meta.url)
