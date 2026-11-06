/**
 * Every way page content reaches the agent on this machine's host, on the real core, the real
 * engine and a real Chromium, and that a normal site still browses. Made up values on loopback.
 * No em or en dashes in this file.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BrowserHostCore, ChromiumEngine, DEFAULT_CAPS, listTools, resolveChromeExecutable, servedBrowserTools } from '../bin/hoai-browser-host.mjs'
import { GateKeeper } from '../lib/browser-gate.mjs'
import { CSRF, serveSite } from './browser-site-fixture.ts'

const chrome = resolveChromeExecutable()
const skip = chrome.path ? false : 'no Chrome or Chromium is installed on this machine'
const OWNER = { assistantId: 42, assistantName: 'Atlas', principal: 'user-owner_1' }
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const textOf = (reply: any) => (reply?.content || []).filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n')
const hasImage = (reply: any) => (reply?.content || []).some((part: any) => part.type === 'image')
const refOf = (tree: string, name: string) => new RegExp(`${name}[^\\n]*?\\[ref=((?:f\\d+)?e\\d+)\\]`).exec(tree)?.[1]

async function rig(t: any, html?: any, { answer = 'deny', write = 'allow', navigate = 'allow', path = '/', gates: gated = true }: any = {}) {
  const site = await serveSite(typeof html === 'string' ? ((p: string) => (p === '/' ? html : undefined)) : html)
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'b9r-')))
  const engine: any = new ChromiumEngine({ executable: chrome.path!, profileDir: join(home, 'browser', 'k'), outputDir: join(home, 'output', 'k'), scope: 'fixture' })
  await engine.start()
  const cards: any[] = []
  const slot: any = { engine, paths: { key: 'k' } }
  const pool: any = { acquire: async () => slot, peek: () => slot, slotKey: () => 'k', pathsFor: () => slot.paths, release: async () => true }
  const gates = gated ? new GateKeeper({ postCard: async (card: any) => { cards.push(card); return true }, readGate: async (gateId: string) => (answer === 'pending' ? { gateId, state: 'pending', status: 'pending' } : { gateId, state: 'answered', status: 'answered', answered: true, choice: answer, answer }), randomBytes: (n: number) => Buffer.alloc(n, cards.length + 1), sleep: async () => {}, log: () => {} } as any) : undefined
  const core: any = new BrowserHostCore({ pool, browserTools: servedBrowserTools(await listTools({ caps: DEFAULT_CAPS, outputDir: join(home, 'tools') })), deviceLabel: 'Build box', gates, isOwnerPrincipal: () => true } as any)
  const intentChecks:any[]=[];core.intentCheck=async(...args:any[])=>{intentChecks.push(args);return {}}
  core._settingsFor = () => ({})
  core._grantsFor = () => ({ [site.origin]: { navigate, write, access: 'allow' } })
  t.after(async () => { await engine.stop().catch(() => {}); await site.close(); rmSync(home, { recursive: true, force: true }) })
  await engine.callTool('browser_navigate', { url: `${site.origin}${path}` })
  return { intentChecks, answer: (choice:string)=>{answer=choice}, core, engine, site, cards, clicks: site.clicks, page: engine.selectedPage(), origin: site.origin, call: (name: string, args: any = {}) => core.callTool(OWNER, name, args) }
}


import register from './page-handoff-cases.cjs'
register(async (t:any)=>{
 let body='<h1>Start</h1>', index=0
 const r=await rig(t,()=>body)
 return {...r,handBack:async()=>r.engine.handBackPrivacy(r.page),nextPage:(html:string)=>{body=html},engine:r.engine._engine,route:async(name:string,args:any,choices:Array<string|((card:any)=>string|Promise<string>)>=[])=>{const start=r.cards.length;const post=r.core.gates._postCard;const read=r.core.gates._readGate;
 const answers=new Map();r.core.gates._readGate=async(id:string)=>({gateId:id,state:'answered',choice:answers.get(id)||'deny'});
 r.core.gates._postCard=async(card:any)=>{const choice=choices.shift();answers.set(card.gateId,typeof choice==='function'?await choice(card):choice||'deny');return post(card)};
 try{return {result:await r.call(name,args),cards:r.cards.slice(start)}}finally{r.core.gates._postCard=post;r.core.gates._readGate=read}},gate:async(name:string,args:any,choice="deny")=>{r.answer(choice);const before=r.cards.length;await r.call(name,args);return r.cards[before]||{}},set:async(html:string)=>{body=`<meta charset="utf-8">${html}`;await r.page.goto(`${r.origin}/${++index}`)},call:async(name:string,args:any={})=>{try{return await r.call(name,args)}catch(e:any){return {content:[{type:'text',text:e.message}]}}}}
}, 'machine')
