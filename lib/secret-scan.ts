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
  /**
   * When set, finds what `pattern` finds (the same first match) in linear time; `pattern` stays the rule as both twins
   * write it (email files review round 7: the jwt regex is quadratic on a long run of base64url characters).
   */
  match?: (line: string) => string | null
  /**
   * Text every line the rule can match holds (email files review round 8): a text with none of it is not read line by
   * line for this rule. Under bun, 13 rules tried on each of 250000 lines of prose took 1.7 s.
   */
  hint?: RegExp
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
    hint: /AKIA/,
    pattern: /\bAKIA[0-9A-Z]{16}\b/,
    valueGroup: 0,
    allowPlaceholder: false,
  },
  {
    // Heuristic for the paired AWS secret: an "aws"-ish assignment whose
    // value is the classic 40-char base64-ish secret access key.
    name: 'aws_secret_access_key',
    hint: /aws/i,
    pattern: /\baws.{0,30}?['"=:\s]([A-Za-z0-9/+=]{40})(?![A-Za-z0-9/+=])/i,
    valueGroup: 1,
    allowPlaceholder: true,
  },
  {
    name: 'anthropic_api_key',
    hint: /sk-ant-/,
    pattern: /\bsk-ant-[A-Za-z0-9-]{20,}/,
    valueGroup: 0,
    allowPlaceholder: false,
  },
  {
    // sk-proj-... (project keys, base64url-ish) and classic sk-...
    // sk-ant- never matches the second alternative: "ant" is only 3 of the
    // 20 required alphanumerics before its next dash.
    name: 'openai_api_key',
    hint: /sk-/,
    pattern: /\bsk-proj-[A-Za-z0-9_-]{20,}|\bsk-[A-Za-z0-9]{20,}/,
    valueGroup: 0,
    allowPlaceholder: false,
  },
  {
    name: 'github_token',
    hint: /gh[posu]_|github_pat_/,
    pattern: /\b(?:gh[posu]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/,
    valueGroup: 0,
    allowPlaceholder: false,
  },
  {
    name: 'slack_token',
    hint: /xox[baprs]-/,
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
    valueGroup: 0,
    allowPlaceholder: false,
  },
  {
    name: 'stripe_live_key',
    hint: /_live_/,
    pattern: /\b(?:sk|rk)_live_[A-Za-z0-9]{10,}/,
    valueGroup: 0,
    allowPlaceholder: false,
  },
  {
    name: 'google_api_key',
    hint: /AIza/,
    pattern: /\bAIza[0-9A-Za-z_-]{30,}/,
    valueGroup: 0,
    allowPlaceholder: false,
  },
  {
    // The BEGIN line of any PEM private key block (RSA, EC, OPENSSH,
    // ENCRYPTED, PGP...). One finding per BEGIN line is enough to block.
    name: 'private_key_block',
    hint: /-----BEGIN/,
    pattern: /-----BEGIN\s+(?:[A-Z0-9]+\s+)*PRIVATE\s+KEY(?:\s+BLOCK)?-----/,
    // Linear and exact: over a million groups on one line the regex above finds nothing under bun (email files review
    // round 8: JavaScriptCore gives up and says no match, where V8 throws).
    match: (line) => privateKeyBlockMatch(line),
    valueGroup: 0,
    allowPlaceholder: false,
  },
  {
    // eyJ (base64url of '{"') + two more dot-separated base64url segments.
    name: 'jwt',
    hint: /eyJ/,
    pattern: /\beyJ[A-Za-z0-9_=-]{8,}\.[A-Za-z0-9_=-]{8,}\.[A-Za-z0-9_=-]{8,}/,
    // Linear: the regex above retries from every eyJ of a run with no dot after it (-eyJ-eyJ...), which is quadratic.
    match: (line) => jwtMatch(line),
    valueGroup: 0,
    allowPlaceholder: false,
  },
  {
    // scheme://user:password@ connection strings. The PASSWORD portion is
    // the secret; a placeholder password (e.g. ${DB_PASSWORD}) is allowed.
    name: 'connection_string_password',
    hint: /:\/\//,
    pattern:
      /\b(?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s:@/]+:([^\s@/]+)@/i,
    valueGroup: 1,
    allowPlaceholder: true,
  },
  {
    // \s+ so a tab or several spaces after "Bearer" cannot slip a token past.
    name: 'bearer_token',
    hint: /Bearer/,
    pattern: /\bBearer\s+([A-Za-z0-9._~+/=-]{20,})/,
    valueGroup: 1,
    allowPlaceholder: true,
  },
  {
    // keyword [:=] value(len >= 16, not a placeholder). Quotes around either
    // side are tolerated; whitespace and quotes end the value token.
    name: 'generic_secret_assignment',
    hint: /api[_-]?key|secret|token|passwd|password|authorization/i,
    pattern:
      /(?:api[_-]?key|secret|token|passwd|password|authorization)['"]?\s*[:=]\s*['"]?([^\s'"]{16,})/i,
    valueGroup: 1,
    allowPlaceholder: true,
  },
]

/** A word character (\w, what \b reads): A-Z, a-z, 0-9 and _. */
function isWordCode(code: number): boolean {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95
}

/** A character of a run the jwt rule can match in: a segment's [A-Za-z0-9_=-], or the dot between segments. */
function isJwtRunCode(code: number): boolean {
  return isWordCode(code) || code === 61 || code === 45 || code === 46
}

/**
 * The jwt rule's first match on one line, the same string the rule's regex finds, in linear time (email files review
 * round 7). The line is read as maximal runs of [A-Za-z0-9_=.-], each split at its dots into segments, and every
 * character is read a fixed number of times. The regex's match starts at an eyJ with \b before it (the run's start,
 * or a '-', '=' or '.' before it: every word character is in the run's class, so a run never starts right after
 * one), and its first part then runs to its segment's end (it cannot hold a dot). So a segment matches from its first
 * such eyJ when 8 or more characters follow that eyJ in the segment and the next two segments are each 8 or more long;
 * a later eyJ has fewer characters after it. The match is that segment from the eyJ, a dot, the next segment, a dot,
 * and all of the one after it (greedy).
 */
export function jwtMatch(line: string): string | null {
  let at = 0
  while (at < line.length) {
    while (at < line.length && !isJwtRunCode(line.charCodeAt(at))) at++
    const runStart = at
    while (at < line.length && isJwtRunCode(line.charCodeAt(at))) at++
    const runEnd = at
    // eyJ, 8, a dot, 8, a dot, 8.
    if (runEnd - runStart < 3 + 8 + 1 + 8 + 1 + 8) continue
    const segments: [number, number][] = []
    let segmentStart = runStart
    for (let k = runStart; k <= runEnd; k++) {
      if (k === runEnd || line.charCodeAt(k) === 46) {
        segments.push([segmentStart, k])
        segmentStart = k + 1
      }
    }
    for (let n = 0; n + 2 < segments.length; n++) {
      const [start, end] = segments[n]!
      const second = segments[n + 1]!
      const third = segments[n + 2]!
      if (second[1] - second[0] < 8 || third[1] - third[0] < 8) continue
      // Only this segment is read: an eyJ that leaves 8 characters after it starts at end - 11 at the latest.
      for (let e = start; e <= end - 11; e++) {
        if (line.charCodeAt(e) !== 101 || line.charCodeAt(e + 1) !== 121 || line.charCodeAt(e + 2) !== 74) continue
        if (e > runStart && isWordCode(line.charCodeAt(e - 1))) continue
        return line.slice(e, third[1])
      }
    }
  }
  return null
}

/** \s as a regex reads it: the ASCII spaces, NBSP, U+1680, U+2000 to U+200A, the line and paragraph separators, U+202F, U+205F, U+3000 and U+FEFF. */
function isRegexSpace(code: number): boolean {
  return (code >= 9 && code <= 13) || code === 32 || code === 0xa0 || code === 0x1680 || (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 || code === 0x2029 || code === 0x202f || code === 0x205f || code === 0x3000 || code === 0xfeff
}

function spacesFrom(line: string, at: number): number {
  while (at < line.length && isRegexSpace(line.charCodeAt(at))) at++
  return at
}

/** Where PRIVATE\s+KEY(?:\s+BLOCK)?----- ends when it starts at `at`, or -1 (the BLOCK form tried first, as the regex does). */
function armourTail(line: string, at: number): number {
  if (!line.startsWith('PRIVATE', at)) return -1
  const key = spacesFrom(line, at + 7)
  if (key === at + 7 || !line.startsWith('KEY', key)) return -1
  const afterKey = key + 3
  const block = spacesFrom(line, afterKey)
  if (block > afterKey && line.startsWith('BLOCK-----', block)) return block + 10
  return line.startsWith('-----', afterKey) ? afterKey + 5 : -1
}

/**
 * The private_key_block rule's first match on one line, the same string its regex finds, in linear time (email files
 * review round 8). From each -----BEGIN: one or more spaces, then at each word's start either the tail (PRIVATE KEY,
 * an optional BLOCK, -----) or one more word of capitals and digits and its spaces. The regex can stop its words only
 * there (a word is followed by a space, a space run by a word), and once a tail matches no further word can (it ends
 * in -----), so this reads the one match it has.
 */
export function privateKeyBlockMatch(line: string): string | null {
  for (let begin = line.indexOf('-----BEGIN'); begin >= 0; begin = line.indexOf('-----BEGIN', begin + 1)) {
    const first = begin + 10
    let at = spacesFrom(line, first)
    if (at === first) continue
    for (;;) {
      const end = armourTail(line, at)
      if (end >= 0) return line.slice(begin, end)
      let word = at
      while (word < line.length && ((line.charCodeAt(word) >= 65 && line.charCodeAt(word) <= 90) || (line.charCodeAt(word) >= 48 && line.charCodeAt(word) <= 57))) word++
      if (word === at) break
      const next = spacesFrom(line, word)
      if (next === word) break
      at = next
    }
  }
  return null
}

/** Canonical rules_version 1 rule names, in deterministic output order.
 *  Pinned by test/secret-scan.test.ts as the cross-repo canary: the backend
 *  twin must export the exact same strings. */
export const SECRET_SCAN_RULE_NAMES: string[] = RULES.map((r) => r.name)

/**
 * First real (non-placeholder) secret a rule finds on one line, else null.
 * Placeholder-gated rules iterate EVERY match so an allowlisted placeholder
 * earlier in the line can never shadow a real secret later on the same line.
 */
/**
 * The global copy of each placeholder-gated rule's pattern, built once (email files review round 7: it was built
 * again for every line). matchAll clones it, so sharing it is safe.
 */
const GLOBAL_PATTERNS: ReadonlyMap<SecretRule, RegExp> = new Map(
  RULES.filter((rule) => rule.allowPlaceholder).map((rule) => [
    rule,
    new RegExp(rule.pattern.source, rule.pattern.flags.includes('g') ? rule.pattern.flags : `${rule.pattern.flags}g`),
  ]),
)

/**
 * Email files review round 7: no rule can match a line shorter than this (the shortest, a connection string such as
 * redis://a:b@, is 12 characters), so such a line is not read.
 */
const SHORTEST_FINDING_LINE = 8

function matchRuleOnLine(rule: SecretRule, line: string): string | null {
  if (rule.match) return rule.match(line)
  if (!rule.allowPlaceholder) {
    const match = rule.pattern.exec(line)
    return match ? (match[rule.valueGroup] ?? match[0]) : null
  }
  for (const match of line.matchAll(GLOBAL_PATTERNS.get(rule)!)) {
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
  // Email files review round 8: only the rules whose hint the text holds are tried on its lines.
  const rules = RULES.filter((rule) => rule.hint === undefined || rule.hint.test(text))
  if (rules.length === 0) return findings
  // Email files review round 7: the lines are walked with indexOf, as split(/\r?\n/) cuts them (a lone \r stays in
  // its line), so 12 million short lines are not held in one array; a line under SHORTEST_FINDING_LINE is skipped.
  let start = 0
  for (let i = 0; start <= text.length; i++) {
    const newline = text.indexOf('\n', start)
    const stop = newline < 0 ? text.length : newline
    // split(/\r?\n/) drops a \r only right before a \n.
    const end = newline >= 0 && stop > start && text.charCodeAt(stop - 1) === 13 ? stop - 1 : stop
    const from = start
    start = stop + 1
    if (end - from < SHORTEST_FINDING_LINE) continue
    const line = text.slice(from, end)
    for (const rule of rules) {
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
