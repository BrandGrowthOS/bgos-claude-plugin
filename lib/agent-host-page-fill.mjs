/**
 * agent-host-page-fill: type one saved login into the page, press Sign in,
 * and wait until the login document is gone (shared agent vault, plugin
 * 0.90.0; BGOS plan 2026-11-13 section 4.3 step 5).
 *
 * The login form is found and filled by the same page function the owner's
 * live view uses (lib/remote-credentials.mjs credentialDocument): one visible
 * password field, at most one username field, a form that posts to the same
 * origin, never a sign up, a one time code or a card form. The captured
 * elements are kept as one handle, so a page that swaps a field between the
 * capture and the fill is refused.
 *
 * Then Sign in is pressed: the form's own visible submit control, else the
 * form's requestSubmit(), else Enter in the password field. The login
 * document is gone when the handle's document is no longer the page's (a
 * navigation destroyed it) or its password field left the page. If it is
 * still there after `waitMs`, both fields are emptied and the answer is
 * `sign_in_failed`. Nothing here returns, logs or keeps a value.
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
    const until = Date.now() + waitMs
    for (;;) {
      if (await loginGone(page, handle)) return { filled: true }
      if (Date.now() >= until) break
      await sleep(POLL_MS)
    }
    await clearFields(handle)
    return { filled: false, reason: 'sign_in_failed' }
  } finally {
    if (handle) await handle.dispose().catch(() => {})
  }
}

/** True once the captured login document is not the page's any more, or its password field left it. */
async function loginGone(page, handle) {
  if (page.isClosed?.()) return true
  try {
    return await handle.evaluate((c) => c.document !== document || !c.password?.isConnected)
  } catch {
    // The execution context of the old document was destroyed: it is gone.
    return true
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
