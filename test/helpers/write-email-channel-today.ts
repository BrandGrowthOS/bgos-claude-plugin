/**
 * Writes test/fixtures/email-channel-today.json from the builders as they
 * stand. Run ONCE, on the builders from before the read attachments switch,
 * and never again: the file is the record of today's bytes.
 *   node node_modules/tsx/dist/cli.mjs test/helpers/write-email-channel-today.ts
 */
import { writeFileSync } from 'node:fs'
import { EMAIL_CHANNEL_CASES } from './email-channel-cases.ts'

const out: Record<string, { content: string; meta: Record<string, string> }> = {}
for (const [name, build] of EMAIL_CHANNEL_CASES) out[name] = build('absent')
writeFileSync(new URL('../fixtures/email-channel-today.json', import.meta.url), `${JSON.stringify(out, null, 2)}\n`)
