#!/usr/bin/env bun
/**
 * hoai-browser-creds: print this agent's HOAI credentials as one JSON line.
 *
 * bin/hoai-browser-launch.mjs runs under node and needs the credentials that
 * lib/agent-credentials.ts resolves, but that library is TypeScript with `.js`
 * specifiers that only bun (and tsx) resolve, so node cannot import it. This
 * script is the bridge: bun runs it, it asks the SAME three functions the MCP
 * server's Configuration block asks (resolveCredentialsSelection,
 * loadCredentialsFile, resolveAuth), and it writes one line of JSON to stdout
 * and nothing else. The launcher parses that line and maps it to HOAI_RELAY_*.
 *
 * The line is a credential, so it goes to the launcher's pipe and nowhere else:
 * never a log file, never stderr, never a console in the daemon. A failure to
 * resolve prints the same shape with complete: false rather than an error, so
 * the launcher has one code path.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

import { loadCredentialsFile, resolveAuth, resolveCredentialsSelection } from '../lib/agent-credentials.js'

/** The same default the server uses: ~/.bgos-agent/credentials.json. */
const defaultPath = join(homedir(), '.bgos-agent', 'credentials.json')
// The directory the OPERATOR launched from, which is what the folder pin is
// about; bin/bgos-launch.mjs passes it through as BGOS_LAUNCH_CWD.
const cwd = process.env.BGOS_LAUNCH_CWD?.trim() || process.cwd()

const empty = { backendUrl: '', pairingToken: '', apiKey: '', assistantId: '', mode: 'apikey', complete: false }

function resolve(): typeof empty {
  try {
    const selection = resolveCredentialsSelection({ env: process.env, defaultPath, cwd })
    // A refuse means this host has several paired agents and this process has
    // no pin: it cannot tell which agent it is, so it carries no credentials
    // (the daemon itself refuses to boot in that state). Env-only auth still
    // resolves below, which is exactly what the server does.
    const creds = selection.kind === 'ok' ? loadCredentialsFile(selection.path) : null
    const auth = resolveAuth({ env: process.env, creds })
    return {
      backendUrl: auth.backendUrl,
      pairingToken: auth.pairingToken,
      apiKey: auth.apiKey,
      assistantId: auth.assistantId,
      mode: auth.mode,
      complete: auth.complete,
    }
  } catch {
    return empty
  }
}

process.stdout.write(JSON.stringify(resolve()) + '\n')
