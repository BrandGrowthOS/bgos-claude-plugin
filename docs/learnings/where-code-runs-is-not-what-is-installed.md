# Where the code is RUNNING is not what the machine has INSTALLED

**Date:** 2026-08-25

**Context:** The app's connect screen hands every new user
`npx -y --package github:BrandGrowthOS/bgos-claude-plugin hoai setup <CODE>`, and
the manual restart advice is "run `hoai` from the agent's folder". A real user ran
`npx -y --package github:BrandGrowthOS/bgos-claude-plugin hoai doctor` and got two
lines out of one run that contradicted each other, with a green tick on the wrong one:

```
PASS  Install method   clone install, channel server:bgos,
                       root /Users/alex/.npm/_npx/c00bcfc5e22688dd/node_modules/claude-channel-bgos
PASS  claude mcp list  plugin:hoai:bgos: bun
                       /Users/alex/.claude/plugins/cache/hoai-latest/hoai/0.34.3/server.ts - Connected
```

His install is a marketplace one. He reported a deaf agent twice.

**Gotcha / Pattern:**

`detectInstallMethod` decided the install method from the REAL path of the running
script: under `<config>/plugins` means marketplace, anywhere else means clone. The
second half is an inference from ABSENCE, and it is wrong for every execution root
that is not an install at all. npm unpacks `npx --package <repo>` into
`~/.npm/_npx/<hash>/node_modules/<pkg>` and deletes it when the command returns. A
directory that exists for the length of one command is evidence of nothing.

Three things follow, and all three had to change:

1. **An npx / bunx / dlx cache is not evidence in EITHER direction.** It is
   recognised (`isEphemeralExecutionRoot`) and refused as a verdict, rather than
   being allowed to mean "not the plugins dir, therefore a clone". A relative
   script path is refused for the same reason: it names no directory on this host.
2. **Ask what the machine HAS.** `<config>/plugins/installed_plugins.json` is
   Claude Code's own record of what `claude plugin install` put there, with the
   `installPath` and the `<plugin>@<marketplace>` id. That is positive evidence an
   ephemeral execution root cannot supply, and the same doctor run already printed
   it one line lower from `claude mcp list`.
3. **The marketplace NAME is part of the spec.** The reporting user's cache path is
   `plugins/cache/hoai-latest/hoai/0.34.3`, so his channel is
   `plugin:hoai@hoai-latest`. The hardcoded `MARKETPLACE_CHANNEL_SPEC`
   (`plugin:hoai@hoai`) would have left him just as deaf as the clone spec did,
   which means a fix that only got `marketplace` right would still have failed him.
   The name is now read off the path (`plugins/cache/<name>/...`,
   `plugins/marketplaces/<name>/...`) or off the installed_plugins.json key.

**Fail closed, and check which way that is.** The dangerous guess here is `clone`,
because it produces an agent that starts, reports Connected in `claude mcp list`,
and drops every inbound message with no error anywhere. So an undetermined machine
now answers `method: 'unknown'` with an EMPTY `channelSpec` and a reason, `hoai`
refuses to launch and prints it, `hoai doctor` renders a FAIL row instead of a PASS,
and `launchFlagArgs`/`launchArgsFor` throw rather than spell a flag with no value. A
loud refusal a user can act on beats a silent misconnection.

**What did NOT change:** a genuine clone checkout, which is how the whole Mac fleet
runs, detects exactly as before, including on a host that ALSO has the marketplace
plugin installed (running the checkout's own `hoai` means the checkout). A global
npm install and a checkout that merely happens to sit in `/tmp` are persistent
directories a user chose, and are not treated as ephemeral: the temp rule only fires
inside a `node_modules` tree under a temp root.

**How to apply next time:** when a check answers "what is this?" from a path, ask
what the path is evidence OF. A location tells you where code is executing. If the
question is what the machine has installed, read the machine's own install record.
And when you must fail, work out which direction of the wrong answer is silent, and
refuse in the other one.

**Regression guard:** `test/bgos-install-method.test.ts` (the npx-shaped fixture off
the real report, marketplace-on-disk, two-installs-ambiguous, cannot-determine,
clone-with-a-marketplace-also-present, and the marketplace-name assertions) and
`test/hoai-core.test.ts` (`buildRunPlan` refuses, `relaunchClaudeArgs` returns null,
`launchArgsFor` throws, `resolveWrapperPluginRoot` will not aim the shim at an npx
dir), plus the doctor row tests in `test/bgos-doctor.test.ts`. Twelve compiling
mutants were run against these guards and all twelve were killed.
