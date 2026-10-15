import { test } from 'node:test'
import assert from 'node:assert/strict'
import { artifactInventoryScope, reserveArtifactInventory, retainArtifactInventory, releaseArtifactInventory } from '../lib/browser-profile-artifact-inventory.mjs'
test('four slots per private runtime remain bounded until the final independent cleanup owner releases', () => {
  const scope = artifactInventoryScope(undefined), receipts: object[] = []
  try {
    for (let index = 0; index < 4; index++) receipts.push(reserveArtifactInventory(scope))
    const source = receipts.pop()!, destination = retainArtifactInventory(source, scope); receipts.push(destination); releaseArtifactInventory(source)
    assert.throws(() => reserveArtifactInventory(scope), /capacity/); assert.throws(() => retainArtifactInventory(destination, artifactInventoryScope(undefined)), /capacity/)
    releaseArtifactInventory(receipts.pop()!); receipts.push(reserveArtifactInventory(scope))
  } finally { for (const receipt of receipts) { try { releaseArtifactInventory(receipt) } catch {} } }
})
test('sixteen independent runtime slots are the process-wide retained content ceiling', () => {
  const receipts: object[] = []
  try { for (let index = 0; index < 16; index++) receipts.push(reserveArtifactInventory(artifactInventoryScope(undefined))); assert.throws(() => reserveArtifactInventory(artifactInventoryScope(undefined)), /capacity/) }
  finally { for (const receipt of receipts) { try { releaseArtifactInventory(receipt) } catch {} } }
})
