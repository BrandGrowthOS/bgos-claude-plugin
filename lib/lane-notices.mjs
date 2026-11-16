/** Each lane keeps one receipt per refusal kind, including old id based receipts. */
export const REFUSAL_NOTICES = Object.freeze(['shell_refused', 'owner_mcp_refused'])

/**
 * Ignore invalid delivery claims. Only a real true or a positive numeric chat
 * id proves delivery. The former global delivered flag proves no recipient.
 * @returns {Record<string, { ownerDelivered: boolean, personDelivered: boolean, chatIds: number[] }>}
 */
export function readRefusalReceipts(fs, path) {
  const receipts = {}
  let saved
  try { saved = JSON.parse(fs.readFileSync(path, 'utf8')) } catch { return receipts }
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return receipts
  for (const [key, value] of Object.entries(saved)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const notice = REFUSAL_NOTICES.includes(key) ? key : value.notice
    if (!REFUSAL_NOTICES.includes(notice)) continue
    const receipt = receipts[notice] ??= { ownerDelivered: false, personDelivered: false, chatIds: [] }
    receipt.ownerDelivered ||= value.ownerDelivered === true
    receipt.personDelivered ||= value.personDelivered === true
    if (Array.isArray(value.chatIds)) {
      receipt.chatIds = [...new Set([...receipt.chatIds, ...value.chatIds.filter((id) => Number.isSafeInteger(id) && id > 0)])]
    }
  }
  return receipts
}
