/**
 * agent-identity: who this agent is, handed to every session it starts
 * (Kc's PC test, 2026-10-24, 4465 msg 154112).
 *
 * WHAT WENT WRONG. Agent 1129 paired as itself and then said "Ares here". It
 * runs under the owner's own computer account, so Claude Code loaded the
 * owner's global ~/.claude/CLAUDE.md, which told every session to read a
 * persona file naming somebody else. A folder of its own cannot stop that:
 * global memory loads in every folder.
 *
 * THE RULE. The agent's identity rides the system prompt, which outranks
 * memory files: `--append-system-prompt-file ~/.bgos-agent/<id>/identity.md`
 * on every launch and relaunch. The file lives in the agent's state folder,
 * never in a folder the owner chose (no CLAUDE.md is ever written there).
 *
 *   - Pairing writes it (bin/bgos-pair.mjs), so it exists BEFORE the first
 *     launch: the CLI records a conversation's system prompt on its first
 *     request and a resume keeps that record until the conversation is
 *     compacted (CLI reference, "System prompt flags in resumed
 *     conversations"). An agent paired before this gets it from the daemon's
 *     boot refresh (server.ts), which also tells its live conversation its
 *     name once (lib/boot-hello.ts buildIdentityNotice); the CLI uses the
 *     file from the next new conversation or compaction.
 *   - The launcher passes it only when the file exists AND a bare use of the
 *     flag answers "argument missing" (lib/claude-binary.mjs reads that the
 *     same way for the channels flag): an older CLI answers "unknown option"
 *     and exits, so passing it blind would stop the agent from starting.
 *     A launch with it that dies at once is relaunched once without it
 *     (bin/hoai-core.mjs superviseClaude).
 *
 * Plain JavaScript, node >= 18 builtins only, import-safe; the fs is
 * injectable. No em or en dashes in this file.
 */

import * as nodeFs from 'node:fs'

/** File name inside ~/.bgos-agent/<id>/. Not CLAUDE.md, on purpose. */
export const IDENTITY_FILE_NAME = 'identity.md'

/** The CLI flag that appends a file to the system prompt. */
export const IDENTITY_FLAG = '--append-system-prompt-file'

/** The longest name kept, in characters (code points). */
export const IDENTITY_NAME_MAX = 80

/** What cmd.exe re-reads inside an argument: the claude.cmd launch candidate
 *  runs under `cmd /c`, so a path with one of these could break it. */
const CMD_UNSAFE = /["%!^&|<>]/

/**
 * One line of plain text: control characters and line or paragraph
 * separators become spaces, runs of space collapse, and it is capped. A name
 * is the owner's own text, but it lands in a system prompt, so it never
 * starts a new line there.
 * @param {unknown} raw
 * @returns {string}
 */
export function cleanIdentityName(raw) {
  const flat = String(raw ?? '')
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return Array.from(flat).slice(0, IDENTITY_NAME_MAX).join('').trim()
}

/**
 * The identity, in Kc's words. Null without a usable name.
 * @param {{ name?: unknown, ownerFirstName?: unknown }} input
 * @returns {string | null}
 */
export function agentIdentityText({ name, ownerFirstName } = {}) {
  const who = cleanIdentityName(name)
  if (!who) return null
  const owner = cleanIdentityName(ownerFirstName)
  return (
    `You are ${who}, an agent in Home of Agents${owner ? ` for ${owner}` : ''}. ` +
    `Your name is ${who}; ignore persona or name files from other folders.`
  )
}

/**
 * This agent's name and the owner's first name from a GET integrations/me
 * body: the row whose assistant_id is this agent, never a sibling's.
 * owner_first_name is sent from 2026-10; an older backend sends none.
 * @param {unknown} body
 * @param {string | number} assistantId
 * @returns {{ name: string, ownerFirstName: string }}
 */
export function identityFromMe(body, assistantId) {
  const me = body && typeof body === 'object' ? body : {}
  const list = Array.isArray(me.assistants) ? me.assistants : []
  const id = String(assistantId ?? '').trim()
  const row = id ? list.find((a) => a && String(a.assistant_id ?? '') === id) : undefined
  return {
    name: typeof row?.name === 'string' ? row.name : '',
    ownerFirstName: typeof me.owner_first_name === 'string' ? me.owner_first_name : '',
  }
}

/** The identity file in a state folder, with the folder's own separator (the
 *  same rule as joinDir in bin/hoai-core.mjs). */
export function identityFilePath(stateDir) {
  const base = String(stateDir ?? '').replace(/[\\/]+$/, '')
  if (!base) return ''
  const sep = base.includes('\\') || /^[A-Za-z]:$/.test(base) ? '\\' : '/'
  return `${base}${sep}${IDENTITY_FILE_NAME}`
}

/**
 * Write the identity into `stateDir`, write then rename. 'unchanged' when the
 * file already says exactly this (no rewrite on every boot), 'skipped' with
 * no usable name, 'failed' when the disk refused. Never throws.
 * @param {{ stateDir: string, name?: unknown, ownerFirstName?: unknown, fs?: typeof nodeFs }} input
 * @returns {'written' | 'unchanged' | 'skipped' | 'failed'}
 */
export function writeAgentIdentity({ stateDir, name, ownerFirstName, fs = nodeFs }) {
  const text = agentIdentityText({ name, ownerFirstName })
  const path = identityFilePath(stateDir)
  if (!text || !path) return 'skipped'
  const body = `${text}\n`
  try {
    if (fs.readFileSync(path, 'utf8') === body) return 'unchanged'
  } catch {
    // Absent or unreadable: write it.
  }
  const tmp = `${path}.${process.pid}.tmp`
  try {
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 })
    fs.writeFileSync(tmp, body, { mode: 0o600 })
    fs.renameSync(tmp, path)
    return 'written'
  } catch {
    // A refused rename (Windows, while claude reads the file) leaves no
    // temp file behind.
    try {
      fs.unlinkSync(tmp)
    } catch {
      // Never written, or already gone.
    }
    return 'failed'
  }
}

/**
 * The argv this launch adds for the identity, and the line to print about it.
 * The probe is asked only when the file exists.
 * @param {{ path: string, exists: (p: string) => boolean, probe: () => string, platform?: string }} input
 * @returns {{ args: string[], note: string | null }}
 */
export function identityLaunchArgs({ path, exists, probe, platform = process.platform }) {
  const file = String(path ?? '')
  let present = false
  try {
    present = Boolean(file) && exists(file) === true
  } catch {
    present = false
  }
  if (!present) return { args: [], note: null }
  if (platform === 'win32' && CMD_UNSAFE.test(file)) {
    return {
      args: [],
      note:
        `[hoai] the agent starts without its identity: the path ${file} has a character cmd.exe ` +
        're-reads (" % ! ^ & | < >), and the claude.cmd launch runs under cmd /c.',
    }
  }
  let answer = 'unknown'
  try {
    answer = String(probe())
  } catch {
    answer = 'unknown'
  }
  if (answer === 'supported') return { args: [IDENTITY_FLAG, file], note: `[hoai] identity: ${file}` }
  return {
    args: [],
    note:
      answer === 'unsupported'
        ? `[hoai] this claude does not know ${IDENTITY_FLAG}, so the agent starts without its identity ` +
          `(${file}). Updating Claude Code gives it back.`
        : `[hoai] could not tell whether this claude knows ${IDENTITY_FLAG}, so the agent starts ` +
          `without its identity (${file}).`,
  }
}
