import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import {dirname,resolve} from 'node:path'
import {Server} from '@modelcontextprotocol/sdk/server/index.js'
import {Client} from '@modelcontextprotocol/sdk/client/index.js'
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js'
import {CallToolRequestSchema,ListToolsRequestSchema} from '@modelcontextprotocol/sdk/types.js'
const require=createRequire(import.meta.url),read=(file:string)=>readFileSync(new URL('../'+file,import.meta.url),'utf8')
const pinned='1.32.1'
test('shipped SDK manifest npm lock Bun lock and actual installed artifact agree on the patched exact version',()=>{
  const manifest=JSON.parse(read('package.json')),lock=JSON.parse(read('package-lock.json')),bun=read('bun.lock'),sdk=lock.packages['node_modules/@modelcontextprotocol/sdk']
  assert.equal(manifest.dependencies['@modelcontextprotocol/sdk'],pinned);assert.equal(lock.packages[''].dependencies['@modelcontextprotocol/sdk'],pinned);assert.equal(sdk.version,pinned)
  assert.equal(sdk.resolved,'https://registry.npmjs.org/@modelcontextprotocol/sdk/-/sdk-'+pinned+'.tgz');assert.match(sdk.integrity,/^sha512-[A-Za-z0-9+/]+=*$/)
  assert.ok(bun.includes('"@modelcontextprotocol/sdk": "'+pinned+'"'));const row=bun.split('\n').find(line=>line.startsWith('    "@modelcontextprotocol/sdk": ['))!;assert.ok(row.includes('"@modelcontextprotocol/sdk@'+pinned+'"'));assert.ok(row.includes('"'+sdk.integrity+'"'))
  const installed=JSON.parse(readFileSync(resolve(dirname(require.resolve('@modelcontextprotocol/sdk/server/index.js')),'../../../package.json'),'utf8'));assert.equal(installed.version,pinned)
})
test('fixed SDK keeps the managed in-memory server client roster and tool call flow intact',async()=>{
  const server=new Server({name:'synthetic-managed-sdk-pin',version:'1'},{capabilities:{tools:{}}}),client=new Client({name:'synthetic-pin-client',version:'1'}),[serverTransport,clientTransport]=InMemoryTransport.createLinkedPair()
  server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[{name:'browser_status',description:'Synthetic status',inputSchema:{type:'object',properties:{}}}]}))
  server.setRequestHandler(CallToolRequestSchema,async request=>{assert.equal(request.params.name,'browser_status');return{content:[{type:'text',text:'synthetic-live-managed-session'}]}})
  try{await server.connect(serverTransport);await client.connect(clientTransport);assert.equal((await client.listTools()).tools[0].name,'browser_status');assert.deepEqual(await client.callTool({name:'browser_status',arguments:{}}),{content:[{type:'text',text:'synthetic-live-managed-session'}]})}finally{await Promise.allSettled([client.close(),server.close()])}
})
