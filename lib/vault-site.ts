import { parse } from 'tldts'

// A SAVED LOGIN ON ANOTHER HOST OF THE SAME SITE. The plugin's twin of the HOAI server's rule
// (BGOS backend/src/agent-vault/vault-site.ts) and of the desktop's
// (frontend/electron-app/agent-browser/vault-site-match.js): two https origins match when they are
// the same origin ("exact"), or when they share one registrable domain by the public suffix list,
// PRIVATE DOMAINS INCLUDED, on the same port ("same_site"). So github.io, vercel.app or
// blogspot.com sites are each their own site, and a public suffix, an address, a credential or
// another scheme never matches another host. tldts is the version the server and the desktop pin
// (test/vault-site.test.ts checks it), so all three read one list. A same site fill is only ever an
// offer: the owner's desktop asks the owner to confirm that host for that login before it fills.

function httpsOrigin(value: unknown): URL | null {
  try {
    const url = new URL(String(value ?? ''))
    if (url.protocol !== 'https:' || url.username || url.password || !url.hostname) return null
    return url
  } catch {
    return null
  }
}

/** The registrable domain of an https origin ("google.com" for accounts.google.com), or null. */
export function registrableSite(value: unknown): string | null {
  const url = httpsOrigin(value)
  if (!url) return null
  const info = parse(url.hostname, { allowPrivateDomains: true, extractHostname: false })
  if (info.isIp || !info.domain || !info.publicSuffix || info.domain === info.publicSuffix) return null
  return info.domain.toLowerCase()
}

/** "exact" (the saved origin itself), "same_site" (another host of its site, same port), or null. */
export function siteMatch(saved: unknown, tab: unknown): 'exact' | 'same_site' | null {
  const a = httpsOrigin(saved)
  const b = httpsOrigin(tab)
  if (!a || !b) return null
  if (a.origin === b.origin) return 'exact'
  if (a.port !== b.port) return null
  const site = registrableSite(a.origin)
  return site && site === registrableSite(b.origin) ? 'same_site' : null
}
