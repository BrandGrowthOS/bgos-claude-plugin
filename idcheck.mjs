import { superviseAssistantId } from './bin/hoai-core.mjs'
const dirs = ['/Users/fitecho/BGOS','/Users/fitecho/Voxor','/Users/fitecho/Voxor/Vexa','/Users/fitecho/Voxor/Vorath','/Users/fitecho/Voxor/Vexa/team/pylon','/Users/fitecho/Voxor/Vexa/team/observer','/Users/fitecho/Voxor/Vexa/team/zealot','/Users/fitecho/Voxor/Vexa/team/prism']
let ok=0
for (const cwd of dirs) {
  let r
  try { r = superviseAssistantId({ cwd }) } catch (e) { r = 'ERR:'+e.message.slice(0,40) }
  const id = (r && typeof r === 'object') ? (r.id ?? JSON.stringify(r).slice(0,50)) : r
  if (id && String(id).match(/^\d+$/)) ok++
  console.log(`  ${cwd.replace('/Users/fitecho/','').padEnd(28)} -> ${id ?? 'none'}`)
}
console.log(`  RESOLVED: ${ok}/8`)
