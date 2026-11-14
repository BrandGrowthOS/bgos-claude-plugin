/**
 * agent-host-page-fill: type one saved login into the page, press Sign in,
 * and wait until the login document is gone (shared agent vault, plugin
 * 0.89.0; BGOS plan 2026-11-13 section 4.3 step 5).
 *
 * The login form is found and filled by the same page function the owner's
 * live view uses (lib/remote-credentials.mjs credentialDocument): one visible
 * password field, at most one username field, a form that posts to the same
 * origin, never a sign up, a one time code or a card form. The captured
 * elements are kept as one handle, so a page that swaps a field between the
 * capture and the fill is refused.
 *
 * Then Sign in is pressed: the form's own visible submit control, else the
 * form's requestSubmit(), else Enter in the password field. Signed in means
 * the top frame committed a NEW document (the handle's document is no longer
 * the page's) AND no password field of the page then holds a value; a form
 * only taken off the page and put back is the same document. Otherwise, after
 * `waitMs`, the captured fields and every password field are emptied and the
 * answer is `sign_in_failed`. The caller then forgets the tab's history
 * (forgetPageHistory), so the filled document can never come back. Nothing
 * here returns, logs or keeps a value.
 *
 * No em or en dashes in this file.
 */
import { credentialDocument } from './remote-credentials.mjs'

export const LOGIN_GONE_WAIT_MS = 15_000
const POLL_MS = 250

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * @param {any} page a Playwright page
 * @param {{ username: string, password: string }} values
 * @param {{ origin: string, waitMs?: number }} opts
 * @returns {Promise<{ filled: true } | { filled: false, reason: string }>}
 */
export async function fillLoginInPage(page, values, { origin, waitMs = LOGIN_GONE_WAIT_MS }) {
  let handle = null
  try {
    try {
      handle = await page.evaluateHandle(credentialDocument, { origin, formRequired: true, action: 'capture' })
      const captured = await handle.evaluate((c) => c?.ok === true)
      if (!captured) return { filled: false, reason: 'no_login_form' }
    } catch {
      return { filled: false, reason: 'no_login_form' }
    }
    let typed
    try {
      typed = await handle.evaluate(credentialDocument, { origin, formRequired: true, action: 'fill', values: { username: values.username, password: values.password } })
    } catch {
      typed = null
    }
    if (typed?.ok !== true) {
      await clearFields(handle)
      return { filled: false, reason: 'page_changed' }
    }
    // Press Sign in.
    let pressed = 'none'
    try {
      pressed = await handle.evaluate((c) => {
        const form = c.form
        if (form) {
          const visible = (el) => el.isConnected && !el.disabled && el.getClientRects().length > 0
          const submit = [...form.querySelectorAll('button, input')].find((el) =>
            el.form === form && visible(el) && (['submit', 'image'].includes(el.type) || (el.tagName === 'BUTTON' && !el.getAttribute('type'))))
          if (submit) { submit.click(); return 'click' }
          if (typeof form.requestSubmit === 'function') { form.requestSubmit(); return 'submit' }
        }
        c.password.focus()
        return 'enter'
      })
    } catch {
      // The click navigated at once and the document went away under the call.
      pressed = 'gone'
    }
    if (pressed === 'enter') await page.keyboard.press('Enter').catch(() => {})
    // Signed in means BOTH: the top frame committed a NEW document (a form that
    // is only taken off the page and put back is the same document), and no
    // password field anywhere on the page then holds a value (H1).
    const until = Date.now() + waitMs
    for (;;) {
      if (await newDocument(page, handle)) {
        const held = await passwordValueLeft(page, until)
        if (held === false) return { filled: true }
        break
      }
      if (Date.now() >= until) break
      await sleep(POLL_MS)
    }
    await clearFields(handle)
    await clearPasswordFields(page)
    return { filled: false, reason: 'sign_in_failed' }
  } finally {
    if (handle) await handle.dispose().catch(() => {})
  }
}

/** True once the top frame holds another document than the captured login one. */
async function newDocument(page, handle) {
  if (page.isClosed?.()) return true
  try {
    return await handle.evaluate((c) => c.document !== document)
  } catch {
    // The execution context of the old document was destroyed: a new one committed.
    return true
  }
}

/** Does any password field in any frame of the page hold a value? Null while it cannot be read until `until`. */
async function passwordValueLeft(page, until) {
  for (;;) {
    try {
      let any = false
      for (const frame of page.frames()) {
        any = (await frame.evaluate(() => [...document.querySelectorAll('input[type=password]')].some((i) => i.value !== ''))) || any
      }
      return any
    } catch {
      // The new document is still loading.
      if (Date.now() >= until) return true
      await sleep(POLL_MS)
    }
  }
}

/** Empty every password field in every frame of the page, whatever document it is now. */
async function clearPasswordFields(page) {
  for (const frame of page.frames?.() ?? []) {
    try {
      await frame.evaluate(() => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
        for (const input of document.querySelectorAll('input[type=password]')) {
          if (input.value === '') continue
          setter?.call(input, '')
          input.dispatchEvent(new Event('input', { bubbles: true }))
          input.dispatchEvent(new Event('change', { bubbles: true }))
        }
      })
    } catch { /* a frame that went away holds nothing */ }
  }
}

/** Empty both captured fields, as a person would, so a failed sign in leaves no value on the page. */
async function clearFields(handle) {
  try {
    await handle.evaluate((c) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      for (const input of [c.username, c.password].filter(Boolean)) {
        if (!input.isConnected) continue
        setter?.call(input, '')
        input.dispatchEvent(new Event('input', { bubbles: true }))
        input.dispatchEvent(new Event('change', { bubbles: true }))
      }
    })
  } catch { /* the document is gone: nothing is left on it */ }
}

/**
 * Forget the tab's back and forward history (Page.resetNavigationHistory), so
 * a filled login document can never be restored, from the history or from the
 * back forward cache, whose entries go with it. Answers ok only when the
 * history then holds the current entry alone.
 *
 * @param {any} page a Playwright page
 * @returns {Promise<{ ok: boolean }>}
 */
export async function forgetPageHistory(page) {
  let cdp = null
  try {
    cdp = await page.context().newCDPSession(page)
    await cdp.send('Page.resetNavigationHistory')
    const history = await cdp.send('Page.getNavigationHistory')
    return { ok: Array.isArray(history?.entries) && history.entries.length === 1 }
  } catch {
    return { ok: false }
  } finally {
    if (cdp) await cdp.detach().catch(() => {})
  }
}
