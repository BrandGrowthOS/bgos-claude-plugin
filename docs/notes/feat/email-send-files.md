
## Why test/email-outbound-files.test.ts never ended under main's runner (Data's P1-2)

**What held it:** the test's own `scripted.mjs` Worker, left idle at the end of `review round 8: ONE long lived content Worker...`. The port is that Worker's private `kPort` MessagePort, with `hasRef()` true. Under node, the first byte on a Worker started with `{ stdout: true }` makes the parent's stream start reading, and that refs the port whatever `worker.unref()` said.

**Where the byte came from:** main's runner preloads `scripts/test-progress.mjs` and sets `--test-reporter=tap`. A Worker from a file or data URL inherits both (an `eval` Worker does not run the `--import`). The preload's `afterEach` starts a node:test harness in the Worker, which writes `TAP version 13`, 15 bytes. It needs both flags: the preload without the reporter flag writes nothing.

**The fix:** the test now ends its own Worker in a `finally`, so nothing is left to hold the file, on a red run too. `scripts/` stays identical to main at `09f96a9`. The test's own process calls no `process.exit`, as before: the one this relies on runs inside the scripted Worker. No longer timeout.

Scratch probes under the runner's real flags, one idle Worker, 3 s alive, on node 24.22.1 on Linux. CI floats on node 24 and has a Windows job, and those were not probed:

| Worker | Preload | Result |
|---|---|---|
| Writes nothing itself | main's | Never ends: `kPort` ref'd, 15 bytes buffered |
| Same | none | Ends in 3 s |
| Writes one line itself | none | Never ends: this part is node, not the preload |
| The real content Worker | main's | Ends in 3 s: its silencer drops the bytes |
| The real content Worker | none | Ends in 3 s |

**Can the product leak the same way? Nothing found, and it does not depend on this.** The launcher (`bin/bgos-launch.mjs`, node) starts the daemon under bun, and the Agent Pack wrapper starts bun directly. Under bun 1.3.14, a Worker that writes to stdout, an idle one, the real one, one that fails to load and one that throws all let the process end by itself in probes. Nothing shipped runs this Worker under node, by reading. The real Worker's silencer gave 0 bytes in every run, and the daemon's shutdown ends in `process.exit`, so it does not rely on ending by itself. The limit: no test in this repo starts this Worker under bun, and these probes are of one bun version. Under bun the silencer is also not total: `process.emitWarning` and `Bun.write(Bun.stdout)` still get through, and neither is called by the Worker's code today.

**Left for Data, not changed:** the preload's hook runs in any file or data URL Worker a test starts. Any later test that leaves such a Worker idle with `{ stdout: true }` will hang the same way, and it would fail by the file's name, with no test named and no totals. With `{ stdout: false }` it prints a second `TAP version 13` into the file's output. `if (isMainThread)` around the hook ended the hang in probes. A test of it must not use an `eval` Worker, which stays green without the change.

The comments in `lib/email-outbound-files.ts`, `lib/email-outbound-content-worker.ts` and `lib/email-outbound-content-quiet.ts` read "left unread" as safe. Left unread, one byte still refs the port. They are comments only, and the real Worker writes no byte.
