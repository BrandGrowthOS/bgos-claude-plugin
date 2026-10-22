/**
 * published-release: the ONE release a clone install may update to (board row
 * 84c23fab, "plugin updates reach some hosts unreleased").
 *
 * WHY THIS EXISTS. A marketplace install only ever gets what the marketplace
 * ref names (BrandGrowthOS/hoai-marketplace, .claude-plugin/marketplace.json,
 * "ref": "v<x.y.z>"). A clone took whatever origin/main held: the daemon's
 * self-updater (lib/self-update.ts inspectGitUpdate) fast-forwarded to the head
 * of origin/main as soon as its package.json carried a newer version, and the
 * watcher (lib/watcher-core.mjs observeCloneInstall) to the branch upstream the
 * same way. Either way a clone landed on whatever had been merged after the
 * release, released or not.
 *
 * WHY THE MARKETPLACE REF AND NOT THE NEWEST TAG. .github/workflows/release-tag.yml
 * tags EVERY push to main whose package.json version has no tag yet, so a tag
 * says "this version reached main", not "this version was published". Twelve
 * tags from v0.65.0 to v0.73.0 were never named by the marketplace (v0.65.0,
 * v0.65.1, v0.65.3, v0.65.4, v0.67.3, v0.67.4, v0.68.0, v0.68.1, v0.68.2,
 * v0.69.7, v0.70.0, v0.71.0), and a clone following tags would have taken each
 * of them. The ref is the step a person takes on purpose.
 *
 * HOW IT IS READ. One GET of the public marketplace manifest from GitHub's raw
 * host, bounded by a timeout, parsed by plugin-cli's own marketplace reader.
 * Anything but exactly one strict v<semver> ref for this plugin is an error,
 * and every caller fails closed: no update this round, the reason logged. An
 * update can wait a day; landing on a version nobody published is the bug.
 *
 * Plain JavaScript, node >= 18 builtins only, import-safe, because the same
 * file serves server.ts (bun), the watcher bundle (bare node) and the tests.
 */

import { HOAI_MARKETPLACE_SOURCE, readMarketplaceLatest } from './plugin-cli.mjs'

/** The marketplace manifest on its default branch, as GitHub serves it raw. */
export const PUBLISHED_MANIFEST_URL = `https://raw.githubusercontent.com/${HOAI_MARKETPLACE_SOURCE}/main/.claude-plugin/marketplace.json`
/** One small GET; a check that cannot finish in this long tries again next time. */
export const PUBLISHED_RELEASE_TIMEOUT_MS = 15_000
/** The manifest is a few KB; anything far bigger is not the manifest. */
const MANIFEST_MAX_CHARS = 256 * 1024
/** A release tag exactly as release-tag.yml writes it: v + strict semver. */
const RELEASE_TAG_RE = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

/**
 * The version a release tag names ('v0.73.0' is '0.73.0'), or null for
 * anything that is not a release tag.
 * @param {unknown} tag
 * @returns {string | null}
 */
export function releaseTagVersion(tag) {
  if (typeof tag !== 'string' || !RELEASE_TAG_RE.test(tag)) return null
  return tag.slice(1)
}

/**
 * Is the release `tag` newer than the installed `version`? null when either is
 * not a strict version, so a caller that cannot tell does not decide on it.
 * @param {string} tag
 * @param {string | null | undefined} version
 * @returns {boolean | null}
 */
export function releaseIsNewer(tag, version) {
  const release = releaseTagVersion(tag)
  const installed = releaseTagVersion(`v${String(version ?? '').trim()}`)
  if (release === null || installed === null) return null
  const a = release.split('.').map(Number)
  const b = installed.split('.').map(Number)
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] > b[i]
  return false
}

/**
 * The release tag a marketplace manifest publishes for this plugin, or null.
 * A manifest that declares a version beside its ref must agree with it: two
 * answers is no answer.
 * @param {unknown} manifestText
 * @returns {string | null}
 */
export function publishedReleaseTagFrom(manifestText) {
  const latest = readMarketplaceLatest(manifestText)
  if (!latest || typeof latest.ref !== 'string') return null
  const tag = latest.ref.trim()
  const version = releaseTagVersion(tag)
  return version !== null && version === latest.version ? tag : null
}

/**
 * The fetch refspec for exactly one release tag. Forced, so the local tag
 * always matches the one origin publishes. Throws on anything that is not a
 * release tag, so nothing else can ever reach git's argv through it.
 * @param {string} tag
 * @returns {string}
 */
export function releaseTagRefspec(tag) {
  if (releaseTagVersion(tag) === null) throw new Error(`not a release tag: ${String(tag)}`)
  return `+refs/tags/${tag}:refs/tags/${tag}`
}

/**
 * Read the published release tag over the network. Throws, with a reason a
 * log line can carry, when the manifest cannot be read or names no release.
 * @param {{ fetchImpl?: typeof fetch, url?: string, timeoutMs?: number }} [opts]
 * @returns {Promise<string>}
 */
export async function readPublishedReleaseTag(opts = {}) {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  const url = opts.url ?? PUBLISHED_MANIFEST_URL
  const timeoutMs = opts.timeoutMs ?? PUBLISHED_RELEASE_TIMEOUT_MS
  if (typeof fetchImpl !== 'function') throw new Error('the published release could not be read: this runtime has no fetch')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  timer.unref?.()
  let text
  try {
    const res = await fetchImpl(url, { signal: controller.signal })
    if (!res || !res.ok) throw new Error(`HTTP ${res?.status ?? 'no response'}`)
    text = String(await res.text())
  } catch (error) {
    const why = controller.signal.aborted ? `no answer within ${timeoutMs / 1000}s` : error instanceof Error ? error.message : String(error)
    throw new Error(`the published release could not be read from ${url}: ${why}`)
  } finally {
    clearTimeout(timer)
  }
  if (text.length > MANIFEST_MAX_CHARS) throw new Error(`the published release could not be read from ${url}: the answer is not the manifest`)
  const tag = publishedReleaseTagFrom(text)
  if (!tag) throw new Error(`the marketplace manifest at ${url} names no published v<x.y.z> release for this plugin`)
  return tag
}
