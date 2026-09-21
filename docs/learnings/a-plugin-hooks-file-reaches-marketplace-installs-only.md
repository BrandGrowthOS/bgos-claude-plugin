# A plugin hooks file reaches marketplace installs only

**Date:** 2026-09-20

**Context:** Stage 4 of the BGOS Mission program gave the Claude Code channel an
agent activity rail, fed by the CLI's own hooks rather than by anything the
agent self reports. The plugin ships `hooks/hooks.json` registering nine events,
each running `bin/hoai-hook.mjs`. On a marketplace install it works the moment
the plugin updates. On a clone install it never runs once, ever, and there is no
error anywhere.

**Gotcha / Pattern:** Claude Code loads `<pluginRoot>/hooks/hooks.json`
automatically for an INSTALLED plugin, meaning one under `~/.claude/plugins`.
Its own help text says so: "Plugin hooks (~/.claude/plugins/*/hooks/hooks.json)"
and "The standard hooks/hooks.json is loaded automatically". A CLONE install is
not an installed plugin. It is a git checkout that publishes an MCP server entry
through the workspace `.mcp.json` and launches with
`--dangerously-load-development-channels server:bgos`, so the CLI has no idea
that checkout is a plugin at all and never opens its hooks file.

The failure mode is the dangerous one: **silence**. The agent pairs, chats,
replies, passes `hoai doctor`, and the tool detail simply is not there. Nobody
files a bug for a feature that is quietly absent, which is the same class as
`docs/learnings/silence-is-not-proof-of-deafness.md`.

Two more facts that shape the fix:

- `${CLAUDE_PLUGIN_ROOT}` is substituted ONLY inside a plugin's own hooks file
  ("This variable is only available in hooks defined in a plugin's
  hooks/hooks.json file, not in settings.json"). A settings entry must therefore
  carry an absolute path to the checkout's forwarder.
- `--safe-mode` disables hooks outright on BOTH install shapes, and it also
  ignores hooks passed through `--settings`, while the session's init still
  lists installed plugins. So "the plugin is listed" is not proof the rail is
  live.

**How to apply next time:** Any capability delivered through a plugin manifest
file (hooks today, and whatever the CLI adds next) needs a second delivery path
for clone installs, written at agent folder creation AND at every launch so
existing folders gain it. Use `ensureHookEntries` in `lib/claude-preseed.mjs`:
it builds on `mutateJsonVerified`, so it survives a concurrent `claude` writing
the same settings file, it is idempotent (a second run rewrites identical
bytes), it replaces a previous HOAI entry rather than stacking a dead one beside
it when the checkout moves, and it leaves a hook the user wrote themselves
alone. Call it from every launcher: `bin/bgos-agent`, `bin/bgos-claim.mjs`,
`bin/hoai-bootstrap.sh`, `bin/hoai-bootstrap.ps1`. Skip it for a marketplace
install so no event ever fires the forwarder twice.

And say the install shape out loud in the README, because the person debugging
"why is there no tool detail" will be looking at the code, not at how they
installed it.

**Regression guard:** `test/claude-preseed.test.ts`, three tests: "every
launcher that creates an agent folder registers the hook entries" (all four
callers, by source scan, each naming `hoai-hook.mjs` and
`settings.local.json`), "the two bootstraps skip a marketplace install, so no
hook ever fires twice", and "the clone entry list and hooks/hooks.json register
the same events" (the two halves of the fleet cannot drift into being fed
different events).
