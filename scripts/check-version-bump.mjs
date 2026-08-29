/**
 * Fail a pull request that changes shipping code without advancing the version.
 *
 * WHY THIS EXISTS. Claude Code resolves a plugin's identity from its declared version, in the order
 * marketplace-entry version, then plugin.json version, then a content hash. A plugin that declares a
 * version and does not move it is therefore PINNED: the marketplace refreshes, the update runs, the
 * CLI reports success, and the machine keeps the old code. Two plugins in Anthropic's own
 * auto-updating marketplace have been frozen exactly that way for six and seven months while their
 * upstream content changed underneath them.
 *
 * That failure is silent and it gets worse, not better, once auto-update is enabled: every machine
 * dutifully checks, finds "nothing new", and stays behind. So this gate is the precondition for
 * turning marketplace auto-update on, not a nicety alongside it.
 *
 * The existing job in this workflow already pins package.json to plugin.json. This one adds the half
 * that was missing: the version must also INCREASE against the pull request's base.
 *
 * Pure decision logic lives in decideVersionBump so it can be unit tested without a git checkout or
 * a CI runner. The CLI at the bottom only marshals arguments and picks an exit code.
 */

/**
 * Paths that never reach a user's machine as executable plugin content, so a change confined to them
 * needs no version bump. Everything else is treated as shipping, which is the safe default: a false
 * "you must bump" is a mild annoyance, a false "no bump needed" is a silently frozen fleet.
 *
 * scripts/ is dev tooling only (it holds the test runner) and is referenced by nothing in server.ts,
 * lib/ or bin/, verified before this list was written.
 */
const NON_SHIPPING_PATTERNS = [
  /^docs\//,
  /^test\//,
  /^scripts\//,
  /^\.github\//,
  /^README\.md$/,
  /^CHANGELOG\.md$/,
  /^LICENSE$/,
  /^\.gitignore$/,
  /^\.gitattributes$/,
]

/** True when a changed path is plugin content that actually reaches a machine. */
export function isShippingPath(path) {
  const p = String(path ?? '').trim().replace(/\\/g, '/')
  if (!p) return false
  return !NON_SHIPPING_PATTERNS.some((re) => re.test(p))
}

/** Leading MAJOR.MINOR.PATCH, tolerant of a v prefix and any pre-release suffix. */
export function parseSemver(value) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(value ?? '').trim())
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

/**
 * True when head is strictly greater than base. Returns false when EITHER side is unparseable,
 * because an unreadable version is not evidence of an advance and we would rather fail the gate than
 * wave a release through on a parse accident.
 */
export function isAdvance(head, base) {
  const h = parseSemver(head)
  const b = parseSemver(base)
  if (!h || !b) return false
  for (let i = 0; i < 3; i += 1) {
    if (h[i] !== b[i]) return h[i] > b[i]
  }
  return false
}

/**
 * @param {object} input
 * @param {string} input.headPkg        package.json version on the branch
 * @param {string} input.headManifest   .claude-plugin/plugin.json version on the branch
 * @param {string} input.basePkg        package.json version at the pull request base
 * @param {string[]} input.changedPaths files changed between base and head
 * @returns {{verdict: 'ok'|'mismatch'|'not-advanced'|'no-shipping-change', message: string}}
 */
export function decideVersionBump({ headPkg, headManifest, basePkg, changedPaths }) {
  if (headPkg !== headManifest) {
    return {
      verdict: 'mismatch',
      message:
        `package.json (${headPkg}) and .claude-plugin/plugin.json (${headManifest}) disagree. ` +
        'Bump both together: Claude Code reads the manifest, npm reads package.json, and a machine ' +
        'that sees two different numbers installs the wrong one.',
    }
  }

  const ships = (changedPaths ?? []).some(isShippingPath)
  if (!ships) {
    return {
      verdict: 'no-shipping-change',
      message: 'No shipping path changed, so no version bump is required.',
    }
  }

  if (!isAdvance(headPkg, basePkg)) {
    return {
      verdict: 'not-advanced',
      message:
        `Shipping code changed but the version did not advance (base ${basePkg}, head ${headPkg}). ` +
        'A release whose version does not move installs cleanly, reports success and changes ' +
        'nothing, on every machine at once. Bump package.json and .claude-plugin/plugin.json.',
    }
  }

  return { verdict: 'ok', message: `Version advances ${basePkg} -> ${headPkg}.` }
}

/** Exit code per verdict. Both passing verdicts are 0; both failures are 1. */
export const EXIT_CODE = {
  ok: 0,
  'no-shipping-change': 0,
  mismatch: 1,
  'not-advanced': 1,
}

function readArg(name) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined
}

/**
 * Run as a CLI only when invoked directly, never on import. Checking argv rather than
 * import.meta.main keeps this working identically under Node and Bun.
 */
const invokedDirectly =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  typeof process.argv[1] === 'string' &&
  process.argv[1].replace(/\\/g, '/').endsWith('scripts/check-version-bump.mjs')

if (invokedDirectly) {
  const changedPaths = String(readArg('changed') ?? '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)

  const result = decideVersionBump({
    headPkg: readArg('head-pkg'),
    headManifest: readArg('head-manifest'),
    basePkg: readArg('base-pkg'),
    changedPaths,
  })

  const code = EXIT_CODE[result.verdict] ?? 1
  const line = `${result.verdict}: ${result.message}`
  if (code === 0) {
    console.log(line)
  } else {
    // GitHub renders this as an inline annotation on the offending file.
    console.log(`::error file=package.json::${line}`)
  }
  process.exit(code)
}
