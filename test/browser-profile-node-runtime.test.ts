import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { assertBrowserNodeVersion, MINIMUM_BROWSER_NODE_VERSION } from '../lib/browser-profile-node-runtime.mjs'

const hostURL = new URL('../bin/hoai-browser-host.mjs', import.meta.url).href
const root = fileURLToPath(new URL('..', import.meta.url))
const code = 'profile_browser_node_unqualified'

test('the browser minimum refuses older, malformed and prerelease Node versions and accepts qualified release versions', () => {
  assert.equal(MINIMUM_BROWSER_NODE_VERSION, '22.12.0')
  for (const version of ['18.20.8', '20.20.1', '22.0.0', '22.11.9', '022.12.0', '22.12', '22.12.0-rc.1', '', 'unknown']) {
    assert.throws(() => assertBrowserNodeVersion(version), { code }, version)
  }
  for (const version of ['22.12.0', '22.23.3', '24.16.0', '24.21.0']) assert.equal(assertBrowserNodeVersion(version), true)
  assert.equal(assertBrowserNodeVersion(), true, 'the actual test host meets the minimum')
})

for (const mode of ['lazy', 'engine', 'cached']) for (const version of ['18.20.8', '20.20.1', '22.11.9']) {
  test(`imported host ${mode} path refuses Node ${version} before lazy browser work`, () => {
    const program = `
      import assert from 'node:assert/strict'; import Module from 'node:module';
      const originalLoad = Module._load; let loads = 0, browserAccesses = 0;
      Module._load = function(name, ...args) { if (name.startsWith('playwright-core')) { loads++; throw Error('unexpected_lazy_browser_load') }; return originalLoad.call(this, name, ...args) };
      const host = await import(${JSON.stringify(hostURL)}); assert.equal(loads, 0, 'host import remains pure');
      Module._load = originalLoad;
      if (${JSON.stringify(mode)} === 'cached') host.loadPlaywright();
      loads = 0; Module._load = function(name, ...args) { if (name.startsWith('playwright-core')) { loads++; throw Error('unexpected_lazy_browser_load') }; return originalLoad.call(this, name, ...args) };
      Object.defineProperty(process.versions, 'node', { value: ${JSON.stringify(version)}, configurable: true });
      if (${JSON.stringify(mode)} === 'engine') {
        const engine = new host.PlaywrightEngine({caps:['pdf'],outputDir:'.',managedRuntime:{ get browser(){browserAccesses++;throw Error('unexpected_browser_access')}, assertCurrent(){browserAccesses++;throw Error('unexpected_runtime_access')} }});
        await assert.rejects(engine.start(), {code:${JSON.stringify(code)}});
      } else assert.throws(() => host.loadPlaywright(), {code:${JSON.stringify(code)}});
      assert.equal(loads, 0); assert.equal(browserAccesses, 0); console.log(JSON.stringify({minimumRefusal:true,playwrightLoads:loads,browserAccesses}));
    `
    const result = spawnSync(process.execPath, ['--input-type=module', '-'], { cwd: root, input: program, encoding: 'utf8', windowsHide: true, timeout: 15000 })
    assert.equal(result.error, undefined)
    assert.equal(result.status, 0, result.stderr.slice(-2500))
    assert.deepEqual(JSON.parse(result.stdout.trim()), { minimumRefusal: true, playwrightLoads: 0, browserAccesses: 0 })
  })
}
