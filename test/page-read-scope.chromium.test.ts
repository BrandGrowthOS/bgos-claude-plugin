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
  const gates = gated ? new GateKeeper({ postCard: async (card: any) => { cards.push(card); return true }, readGate: async (gateId: string) => (answer === 'pending' ? { gateId, state: 'pending', status: 'pending' } : { gateId, state: 'answered', status: 'answered', answered: true, choice: answer, answer }), randomBytes: (n: number) => Buffer.alloc(n, 7), sleep: async () => {}, log: () => {} } as any) : undefined
  const core: any = new BrowserHostCore({ pool, browserTools: servedBrowserTools(await listTools({ caps: DEFAULT_CAPS, outputDir: join(home, 'tools') })), deviceLabel: 'Build box', gates, isOwnerPrincipal: () => true } as any)
  const intentChecks:any[]=[];core.intentCheck=async(...args:any[])=>{intentChecks.push(args);return {}}
  core._settingsFor = () => ({})
  core._grantsFor = () => ({ [site.origin]: { navigate, write, access: 'allow' } })
  t.after(async () => { await engine.stop().catch(() => {}); await site.close(); rmSync(home, { recursive: true, force: true }) })
  await engine.callTool('browser_navigate', { url: `${site.origin}${path}` })
  return { intentChecks, answer: (choice:string)=>{answer=choice}, core, engine, site, cards, clicks: site.clicks, page: engine.selectedPage(), origin: site.origin, call: (name: string, args: any = {}) => core.callTool(OWNER, name, args) }
}


import register from './page-read-scope-cases.cjs'
register(async(t:any,lang:string)=>{
 const r=await rig(t,`<html lang=${lang}><h1>Public page</h1><input aria-label=Search value=Ordinary></html>`)
 const pages=[r.page];for(let i=0;i<3;i++){const page=await r.page.context().newPage();await page.goto(`${r.origin}/other${i}`);pages.push(page)}
 await new Promise(resolve=>setTimeout(resolve,200));await r.engine.callTool('browser_tabs',{action:'select',index:0})
 return {pages,privacy:r.engine._engine._privacy,callEngine:(name:string,args:any)=>r.engine.callTool(name,args),call:r.call}
},'machine host')
