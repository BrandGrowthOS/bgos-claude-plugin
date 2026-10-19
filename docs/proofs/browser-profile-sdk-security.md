# Managed browser SDK dependency qualification

The shipped MCP SDK is pinned exactly to 1.32.1 in the manifest and both installer locks. The [maintainer advisory](https://github.com/advisories/GHSA-6qxp-vccf-f47h) fixes the affected 1.x OAuth HTTP client in 1.31.0 and explicitly excludes stdio clients and SDK servers. This feature uses server/stdio and in-memory transport imports, with no OAuth client provider. The previous affected dependency version does not by itself establish credential exposure in this feature.

The existing npm and Bun locks had different transitive versions. Compatible security updates repair both graphs, retaining Node 18 compatibility with @hono/node-server 1.19.15. Bun additionally needed its legacy body-parser and nested ws dependency closures repaired. Its development runner moves within the existing tsx range to 4.23.0 and esbuild 0.28.1. Unrelated Bun pins are retained; obsolete nested ws and unused get-tsconfig/resolve-pkg-maps entries are removed.

An actual npm clean install passed all 176 cases in the 12 touched host, MCP, companion and return suites with no skips, then TypeScript `--noEmit`. An independent coherent archive with an actual frozen Bun install passed the same 176 cases and type check. These include existing real Chromium host E2E and actual SDK in-memory roster/tool interaction. npm full and production audits report zero findings; Bun audit returns an empty finding object.

Five executable copied-configuration drills changed the exact SDK pin or resolved version in the manifest, npm lock or Bun lock. Each changed configuration line was printed, the pin test failed with exit 1, exact bytes were restored, and both pin/runtime tests passed with exit 0. The JSON preserves hashes and receipts. Independent review covered the dependency diff and new regression tests.

This is installer, dependency and browser/MCP compatibility qualification. It is separate from fresh Linux browser installation, real OS key-store acceptance, encrypted checkpoint transfer and native reverse handover. No installed agent, production state or host trust was changed.
