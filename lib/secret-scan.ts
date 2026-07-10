/**
 * Agent Pack secret scan, rules_version 1.
 *
 * The packaging gate for Type 3 "Full handoff" (Agent Packs): every candidate
 * file is scanned line by line BEFORE anything is zipped or uploaded, and ANY
 * finding blocks packaging entirely. Chat history is never a scan input
 * because it is never a pack input.
 *
 * One ruleset, implemented twice with IDENTICAL rules and rule-name strings:
 *   - backend  backend/src/agent-handoffs/secret-scan.util.ts (jest)
 *   - plugin   lib/secret-scan.ts (this file, bun/node test)
 * The rule names below are the canonical cross-repo strings for
 * rules_version 1; they ride findings onto the wire and into the handoff row
 * (secret_scan jsonb), so renaming any of them is a breaking wire change.
 *
 * Pure and import-safe: no env reads, no network, no clock, no process exit
 * (this repo's lib/ convention, see lib/call-owner.ts).
 *
 * Findings mask the matched secret to its first 4 characters plus "...";
 * the full value never appears in results, logs, or persisted rows.
 *
 * v1 has NO entropy detector on purpose: the false positive risk on prose,
 * hashes, and ids outweighs the marginal catch rate (documented decision D3).
 */

export const SECRET_SCAN_RULES_VERSION = 1

export interface SecretFinding {
  /** Workspace-relative path (or pack entry name) of the scanned file. */
  file: string
  /** 1-based line number of the hit. */
  line: number
  /** Canonical rule name (rules_version 1 set, shared with the backend). */
  rule: string
  /** First 4 chars of the matched secret + "..." (never the full value). */
  excerpt: string
}

interface SecretRule {
  name: string
  pattern: RegExp
  /** Capture group holding the secret value; 0 means the whole match. */
  valueGroup: number
  /** When true, a captured value matching the placeholder allowlist is
   *  NOT a finding (docs and templates legitimately show placeholders). */
  allowPlaceholder: boolean
}

/**
 * Placeholder allowlist: values that are obviously templates, not secrets.
 * ${ENV_VAR} / $ENV_VAR, <angle placeholders>, your-..., xxx..., ***,
 * TODO, CHANGEME, REDACTED, EXAMPLE... (case insensitive, whole value).
 */
const PLACEHOLDER_RE =
  /^(\$\{?[A-Z_]+\}?|<[^>]+>|your[-_].*|xxx+|\*{3,}|TODO|CHANGEME|REDACTED|EXAMPLE.*)$/i

export function isPlaceholderValue(value: string): boolean {
  return PLACEHOLDER_RE.test(value)
}

/** Mask a matched secret for findings: first 4 chars + "...". */
export function maskSecret(value: string): string {
  return `${value.slice(0, 4)}...`
}

/**
 * The rules_version 1 detector set. Order is the deterministic output order
 * when several rules hit the same line. Every pattern is applied per line
 * (line anchored scanning), first match per rule per line.
 */
const RULES: SecretRule[] = [
  {
    // AKIA + 16 uppercase alphanumerics (AWS access key id).
    name: 'aws_access_key_id',
    pattern: /\bAKIA[0-9A-Z]{16}\b/,
    valueGroup: 0,
    allowPlaceholder: false,
  },
  {
    // Heuristic for the paired AWS secret: an "aws"-ish assignment whose
    // value is the classic 40-char base64-ish secret access key.
    name: 'aws_secret_access_key',
    pattern: /\baws.{0,30}?['"=:\s]([A-Za-z0-9/+=]{40})(?![A-Za-z0-9/+=])/i,
    valueGroup: 1,
    allowPlaceholder: true,
  },
  {
    name: 'anthropic_api_key',
    pattern: /\bsk-ant-[A-Za-z0-9-]{20,}/,
    valueGroup: 0,
    allowPlaceholder: false,
  },
  {
    // sk-proj-... (project keys, base64url-ish) and classic sk-...
    // sk-ant- never matches the second alternative: "ant" is only 3 of the
    // 20 required alphanumerics before its next dash.
    name: 'openai_api_key',
    pattern: /\bsk-proj-[A-Za-z0-9_-]{20,}|\bsk-[A-Za-z0-9]{20,}/,
    valueGroup: 0,
    allowPlaceholder: false,
  },
  {
    name: 'github_token',
    pattern: /\b(?:gh[posu]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/,
    valueGroup: 0,
    allowPlaceholder: false,
  },
  {
    name: 'slack_token',
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
    valueGroup: 0,
    allowPlaceholder: false,
  },
  {
    name: 'stripe_live_key',
    pattern: /\b(?:sk|rk)_live_[A-Za-z0-9]{10,}/,
    valueGroup: 0,
    allowPlaceholder: false,
  },
  {
    name: 'google_api_key',
    pattern: /\bAIza[0-9A-Za-z_-]{30,}/,
    valueGroup: 0,
    allowPlaceholder: false,
  },
  {
    // The BEGIN line of any PEM private key block (RSA, EC, OPENSSH,
    // ENCRYPTED, PGP...). One finding per BEGIN line is enough to block.
    name: 'private_key_block',
    pattern: /-----BEGIN\s+(?:[A-Z0-9]+\s+)*PRIVATE\s+KEY(?:\s+BLOCK)?-----/,
    valueGroup: 0,
    allowPlaceholder: false,
  },
  {
    // eyJ (base64url of '{"') + two more dot-separated base64url segments.
    name: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_=-]{8,}\.[A-Za-z0-9_=-]{8,}\.[A-Za-z0-9_=-]{8,}/,
    valueGroup: 0,
    allowPlaceholder: false,
  },
  {
    // scheme://user:password@ connection strings. The PASSWORD portion is
    // the secret; a placeholder password (e.g. ${DB_PASSWORD}) is allowed.
    name: 'connection_string_password',
    pattern:
      /\b(?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s:@/]+:([^\s@/]+)@/i,
    valueGroup: 1,
    allowPlaceholder: true,
  },
  {
    // \s+ so a tab or several spaces after "Bearer" cannot slip a token past.
    name: 'bearer_token',
    pattern: /\bBearer\s+([A-Za-z0-9._~+/=-]{20,})/,
    valueGroup: 1,
    allowPlaceholder: true,
  },
  {
    // keyword [:=] value(len >= 16, not a placeholder). Quotes around either
    // side are tolerated; whitespace and quotes end the value token.
    name: 'generic_secret_assignment',
    pattern:
      /(?:api[_-]?key|secret|token|passwd|password|authorization)['"]?\s*[:=]\s*['"]?([^\s'"]{16,})/i,
    valueGroup: 1,
    allowPlaceholder: true,
  },
]

/** Canonical rules_version 1 rule names, in deterministic output order.
 *  Pinned by test/secret-scan.test.ts as the cross-repo canary: the backend
 *  twin must export the exact same strings. */
export const SECRET_SCAN_RULE_NAMES: string[] = RULES.map((r) => r.name)

/**
 * First real (non-placeholder) secret a rule finds on one line, else null.
 * Placeholder-gated rules iterate EVERY match so an allowlisted placeholder
 * earlier in the line can never shadow a real secret later on the same line.
 */
function matchRuleOnLine(rule: SecretRule, line: string): string | null {
  if (!rule.allowPlaceholder) {
    const match = rule.pattern.exec(line)
    return match ? (match[rule.valueGroup] ?? match[0]) : null
  }
  const global = new RegExp(
    rule.pattern.source,
    rule.pattern.flags.includes('g')
      ? rule.pattern.flags
      : `${rule.pattern.flags}g`,
  )
  for (const match of line.matchAll(global)) {
    const value = match[rule.valueGroup] ?? match[0]
    if (!isPlaceholderValue(value)) return value
  }
  return null
}

/**
 * Scan one file's text, line by line. Returns at most one finding per rule
 * per line (a blocked pack is blocked either way; excerpts stay small).
 */
export function scanText(file: string, text: string): SecretFinding[] {
  const findings: SecretFinding[] = []
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (!line) continue
    for (const rule of RULES) {
      const value = matchRuleOnLine(rule, line)
      if (value === null) continue
      findings.push({
        file,
        line: i + 1,
        rule: rule.name,
        excerpt: maskSecret(value),
      })
    }
  }
  return findings
}

/** Scan a set of files (deterministic: input order, then line order). */
export function scanFiles(
  files: Array<{ path: string; text: string }>,
): SecretFinding[] {
  const findings: SecretFinding[] = []
  for (const f of files) {
    findings.push(...scanText(f.path, f.text))
  }
  return findings
}
