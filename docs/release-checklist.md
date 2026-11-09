# Release checklist

Run before a release is merged to main. A step that cannot run on the machine
doing the release is a stop, not a skip: run it where it can.

## Every release

1. `npm test` passes (both families, node:test and bun:test).
2. `npx tsc --noEmit` passes.
3. The version moved in `package.json`, `.claude-plugin/plugin.json` and
   `package-lock.json`, and `CHANGELOG.md` has its entry.
4. A release that re-vendors the HOAI browser shim follows
   [vendoring-the-hoai-browser-shim.md](vendoring-the-hoai-browser-shim.md).

## A release that touches threads

Threads, By the way, group threads, or anything they call: `lib/thread-*`,
`lib/group-lane*`, `lib/aside-fork.ts`, `lib/stream-json-child.ts`,
`lib/lane-process.ts`, `lib/threads-cli.ts`, `hooks/hooks.json` (a lane runs
the plugin's hooks), or the thread wiring in `server.ts`.

5. The live thread gate passes, on a machine with Claude Code installed:

   ```
   HOAI_LIVE_THREAD=1 npx tsx --test test/thread-live.e2e.test.ts
   ```

   It runs the real daemon with the real Claude Code CLI against stand ins for
   the HOAI server and the model API, in a sandboxed `HOME` and
   `CLAUDE_CONFIG_DIR` with a made up key: no real account, no real key. It
   checks that a thread answers, that a thread on a long lived agent (a 300 MB
   main transcript) keeps the daemon small and the main chat going, that a
   thread that cannot open says so in its own thread, and that a large
   repository runs its thread read only with nothing copied. The fifth case
   appends an active goal to the main transcript's last uuid and checks that
   its thread makes no goal check: exactly two API requests in all, neither
   naming the condition. It must fail if the daemon's goal clear is unwired.
   `HOAI_LIVE_THREAD=1` makes a missing Claude Code a failure instead of a
   skip; `HOAI_LIVE_CLAUDE=<path>` picks a specific `claude` binary.

   Why this is a gate: 0.87.0 shipped threads whose unit tests all passed, and
   the first thread message on a real agent took its daemon down (see
   `docs/thread-lanes-spike.md`, "0.87.0 crash"). The fakes never ran the
   path at a real agent's size.
