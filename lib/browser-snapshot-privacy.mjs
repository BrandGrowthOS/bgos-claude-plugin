/**
 * What a page snapshot may say about a masked input. A password field's value is not on
 * screen, so it is not the agent's to read, and the accessibility tree carries it anyway:
 *   - textbox "Password" [ref=e5]: the value
 * This keeps that the field holds something and drops the value. Asking the page about each
 * line costs one call per filled text box, so it is bounded, and past the bound or on any
 * failure a filled box is treated as masked: the agent loses a value it could read again by
 * asking for the one element, never the other way round.
 * No em or en dashes in this file.
 */
export const MASKED_VALUE = '(masked)'
const MAX_FIELDS = 64, ASK_MS = 1_000
const FILLED_BOX = /^(\s*-\s+(?:textbox|searchbox|combobox|spinbutton)\b[^\n]*?\[ref=([A-Za-z0-9_-]{1,32})\][^\n:]*): (.+)$/

async function isMasked(locator) {
  let timer
  try {
    return await Promise.race([
      locator.evaluate(element => element instanceof HTMLInputElement && element.type === 'password'),
      new Promise(resolve => { timer = setTimeout(() => resolve(true), ASK_MS) }),
    ])
  } catch { return true } finally { clearTimeout(timer) }
}

/** The snapshot text with every masked input's value replaced. `locatorOf(ref)` finds a snapshot ref. */
export async function maskMaskedInputs(snapshotText, locatorOf) {
  const lines = snapshotText.split('\n')
  let asked = 0
  for (let index = 0; index < lines.length; index++) {
    const match = FILLED_BOX.exec(lines[index])
    if (!match) continue
    const masked = ++asked > MAX_FIELDS || await isMasked(locatorOf(match[2]))
    if (masked) lines[index] = `${match[1]}: ${MASKED_VALUE}`
  }
  return lines.join('\n')
}
