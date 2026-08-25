import { resolveChannelSpec } from './bin/hoai-core.mjs'
for (const cwd of ['/Users/fitecho/BGOS','/Users/fitecho/Voxor/Vexa','/tmp']) {
  const r = resolveChannelSpec({ cwd })
  console.log(`  ${cwd.padEnd(26)} spec=${String(r.spec).padEnd(20)} source=${r.source}`)
}
