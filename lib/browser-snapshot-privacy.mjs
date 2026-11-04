/**
 * A masked input's value is not on screen, so it is not the agent's to read. The page's tree
 * carries it anyway, in more than one form:
 *   - textbox "Name" [ref=e2]: the value
 *   - 'textbox "Name: with a colon" [ref=e3]': the value
 *   - textbox "Name" [ref=e4]:
 *       - /placeholder: what the page shows when empty
 *       - text: the value
 * Two layers. maskMaskedInputs drops the value from a tree before anyone reads it, asking the page
 * about each filled box, and treats any box it cannot ask about as masked. maskedValuesOf asks the
 * page itself for those values, so the host can redact them from any reply in any form.
 * No em or en dashes in this file.
 */
export const MASKED_VALUE = '(masked)'
const MAX_FIELDS = 64, ASK_MS = 1_000
const BOX = /^(\s*)-\s+['"]?(?:textbox|searchbox|combobox|spinbutton)\b[^\n]*?\[ref=([A-Za-z0-9_-]{1,32})\][^\n:]*?['"]?:(?: (.*))?$/
const CHILD_TEXT = /^(\s*)-\s+text:\s/

const masksOwnValue = element => element instanceof HTMLInputElement && (element.type === 'password' || (getComputedStyle(element).webkitTextSecurity || 'none') !== 'none')

async function bounded(work, fallback) {
  let timer
  try {
    return await Promise.race([work, new Promise(resolve => { timer = setTimeout(() => resolve(fallback), ASK_MS); timer.unref?.() })])
  } catch { return fallback } finally { clearTimeout(timer) }
}

/** The tree with every masked input's value replaced. `locatorOf(ref)` finds a tree's ref on the page. */
export async function maskMaskedInputs(snapshotText, locatorOf) {
  const lines = snapshotText.split('\n')
  let asked = 0
  const isMasked = ref => ++asked > MAX_FIELDS ? Promise.resolve(true) : bounded(Promise.resolve().then(() => locatorOf(ref).evaluate(masksOwnValue)), true)
  for (let index = 0; index < lines.length; index++) {
    const box = BOX.exec(lines[index])
    if (!box) continue
    if (box[3]) {
      if (await isMasked(box[2]) !== false) lines[index] = `${lines[index].slice(0, lines[index].length - box[3].length)}${MASKED_VALUE}`
      continue
    }
    const children = []
    for (let next = index + 1; next < lines.length && lines[next].search(/\S/) > box[1].length; next++) if (CHILD_TEXT.test(lines[next])) children.push(next)
    if (!children.length || await isMasked(box[2]) === false) continue
    for (const child of children) lines[child] = lines[child].replace(/^(\s*-\s+text:\s).*$/, `$1${MASKED_VALUE}`)
  }
  return lines.join('\n')
}

/** Every value a masked input on this page holds, in every frame the page has. What cannot be asked gives nothing. */
export async function maskedValuesOf(page) {
  const values = await Promise.all(page.frames().map(frame => bounded(frame.locator('input').evaluateAll(elements => elements
    .filter(element => element.type === 'password' || (getComputedStyle(element).webkitTextSecurity || 'none') !== 'none')
    .map(element => element.value)
    .filter(Boolean)), [])))
  return [...new Set(values.flat())]
}
