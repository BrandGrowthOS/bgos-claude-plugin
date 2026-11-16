/** Marketplace startup guard. Reads only; a failed probe always fails open. */
import { readFileSync, readdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { resolveCredentialsSelection, resolveAuth, type CredentialsFile, type CredentialsSelection } from './agent-credentials.js'
import { decideAttachScope, effectiveAttachScopeMode, resolveAttachScopeMode, sameFolder } from './attach-scope.mjs'

function readOptional(path: string): string | null {
  try { return readFileSync(path, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}
function listOptional(path: string): string[] {
  try { return readdirSync(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

interface MarketplaceAttachResult {
  decision: ReturnType<typeof decideAttachScope>
  modeInfo: { mode: string; source: string; invalid?: string }
  selection?: CredentialsSelection | { kind: 'ok'; path: string; via: 'recorded-home' }
  credentials?: CredentialsFile | null
  homeMatched?: boolean
}

function parseCredentials(raw: string | null): CredentialsFile | null {
  if (raw === null) return null
  const parsed = JSON.parse(raw)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('unreadable credentials')
  return parsed
}

function sameAgent(a: unknown, b: unknown): boolean {
  return /^\d{1,12}$/.test(String(a)) && /^\d{1,12}$/.test(String(b)) && Number(a) === Number(b)
}

export function evaluateMarketplaceAttach({
  cwd, home, env, readText = readOptional, listDir = listOptional, realpath = realpathSync,
}: {
  cwd: string
  home: string
  env: Record<string, string | undefined>
  readText?: (path: string) => string | null
  listDir?: (path: string) => string[]
  realpath?: (path: string) => string
}): MarketplaceAttachResult {
  const fallback = { ...decideAttachScope({ assistantId: '' }), mode: 'home' }
  try {
    const setting = resolveAttachScopeMode({ env, readText, settingsPath: join(home, '.bgos-agent', 'attach-scope.json') })
    const modeInfo = effectiveAttachScopeMode(setting, 'marketplace')
    let selection: NonNullable<MarketplaceAttachResult['selection']> = resolveCredentialsSelection({ env, cwd,
      defaultPath: join(home, '.bgos-agent', 'credentials.json'), readText, listDir,
      exists: (path) => readText(path) !== null,
    })
    if (selection.kind === 'refuse') {
      // A unique recorded home is local identity evidence even when no pin
      // was written. Ambiguous homes never choose an agent by file order.
      const agentDir = selection.agentDir
      const matches = selection.candidateIds.flatMap((id) => {
        const path = join(agentDir, `credentials-${id}.json`)
        const candidate = parseCredentials(readText(path))
        const homeDir = candidate?.homeDir
        return sameAgent(candidate?.assistantId, id) && typeof homeDir === 'string' && homeDir.trim() &&
          sameFolder(realpath(cwd), realpath(homeDir)) ? [{ path }] : []
      })
      if (matches.length === 1) selection = { kind: 'ok', path: matches[0]!.path, via: 'recorded-home' }
    }
    const credentials = selection.kind === 'ok' ? parseCredentials(readText(selection.path)) : null
    const rawId = resolveAuth({ env, creds: credentials }).assistantId
    // The manifest's unsubstituted optional setting is known absence, just
    // as the shared credentials resolver treats it, not unreadable identity.
    const assistantId = rawId === '${user_config.assistant_id}' ? '' : rawId
    const pin = (readText(join(cwd, '.bgos-agent-id')) ?? '').trim()
    const folderPinId = /^\d{1,12}$/.test(pin) ? pin : ''
    let decision = decideAttachScope({ mode: 'strict', env, assistantId, cwd, folderPinId, realpath })
    const ownPin = folderPinId !== '' && sameAgent(folderPinId, assistantId)
    // A file rejected for authentication cannot lend its home to another id.
    const recorded = sameAgent(credentials?.assistantId, assistantId) && typeof credentials?.homeDir === 'string'
      ? credentials.homeDir.trim() : ''
    const ownHome = recorded !== '' && sameFolder(realpath(cwd), realpath(recorded))
    const homeMatched = ownPin || ownHome
    const result = () => ({ decision: { ...decision, mode: modeInfo.mode }, modeInfo, selection, credentials, homeMatched })
    // Explicit rollback and malformed settings preserve the original fail-open contract.
    if (setting.invalid || (setting.source !== 'default' && setting.mode === 'off')) {
      decision = { ...decision, verdict: 'attach', ...(setting.invalid ? { outcome: 'unreadable', refusedFrom: null } : {}) }
      return result()
    }
    if (['1', 'true'].includes((env.BGOS_ALLOW_ANY_FOLDER ?? '').trim().toLowerCase())) {
      decision = { ...decision, verdict: 'attach', outcome: 'match', refusedFrom: null }
      return result()
    }
    // No pairing on disk is known absence, not a failed read. Stay dormant.
    if (!assistantId && !env.HOAI_ATTACH_SCOPE) {
      decision = { ...decision, verdict: 'refuse', outcome: 'unscoped', refusedFrom: 'strict' }
      return result()
    }
    if (decision.outcome !== 'unscoped') return result()
    // An explicit strict mode still requires launcher intent. The marketplace
    // default also accepts residence in this agent's own home.
    if (modeInfo.mode === 'home' || modeInfo.mode === 'wrong-agent') {
      // Home admits this start, but strict mode would still require scope.
      if (ownPin || ownHome) decision = { ...decision, verdict: 'attach', outcome: 'match' }
    }
    return result()
  } catch {
    return { decision: fallback, modeInfo: { mode: 'home', source: 'default' } }
  }
}
