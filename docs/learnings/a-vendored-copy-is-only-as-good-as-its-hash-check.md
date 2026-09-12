# A vendored copy is only as good as the thing that notices it drifted

**Date:** 2026-09-12

**Context:** `bin/hoai-browser-mcp.mjs` is a byte-identical copy of the BGOS Agent Browser shim
(`frontend/electron-app/agent-browser/shim/hoai-browser-mcp.mjs`). The shim is framework neutral on
purpose: it never reads a plugin's files and takes its relay credentials from env, so every channel
plugin ships the same bytes. PR #131 vendored it and put the sha256 in the commit message.

**Gotcha / Pattern:** The byte-identity requirement was enforced only by prose. Nothing in `test/`
or `.github/workflows/` compared the copy to anything, so the claim was true on the day it was
written and untested every day after. The BGOS shim was then fixed twice inside the same week (the
relay answer is the body's `status`, not the HTTP code, because NestJS answers 201; and the pairing
lane must carry `assistantId`, which the relay DTO requires on both lanes), and this repo kept
shipping the stale copy. As vendored, the plugin's DEFAULT lane was dead: every successful relayed
frame was read as an error and the agent told the owner their desktop app was offline. A human
review caught it, which is not a mechanism.

Two things worth separating, because they need different fixes:

1. **The copy no longer matching what this repo says it is.** Cheap to catch in-repo: pin the hash
   in a committed file and compare on every run.
2. **The source of truth moving without the copy.** NOT catchable from here. BGOS is a separate
   private repo and is not on this runner, so no plugin-side CI check can see it. That check has to
   live on the BGOS side, or the re-vendor has to be a step of the BGOS fix.

The only protection that actually held against defect 2 was behavioural, and only by luck of
coverage: the ported relay cases fail 6 of 9 against the pre-fix blob. Behavioural cover catches a
copy that is WRONG; it says nothing about a copy that is merely OLD in a way no test reaches.

**How to apply next time:** When a file is a copy rather than a fork, commit the hash next to it and
make a test read it (`bin/hoai-browser-mcp.vendor.json` +
`test/hoai-browser-mcp.vendor.test.ts`). The pin turns a silent re-vendor into a red test, which
forces whoever re-vendors to state the new hash in the tree. Add the cross-tree comparison as an
opt-in case gated on an env var naming the other tree (`HOAI_BROWSER_SHIM_SOURCE`) and skip it with
a reason that says why CI cannot do it, rather than pretending the suite checks something it cannot
reach. Pin the file to `text eol=lf` in `.gitattributes` in the same breath: with `core.autocrlf` a
Windows checkout has different bytes and the hash is unverifiable on disk for the people most likely
to check it. And write the re-vendor procedure down where the pin points at it
(`docs/vendoring-the-hoai-browser-shim.md`), including the honest paragraph about what it does not
catch.

**Regression guard:** `test/hoai-browser-mcp.vendor.test.ts` (the pin vs the file's bytes; the LF
rule and the `.gitattributes` line that enforces it; the checklist naming the pin, the guard and the
cross-tree variable; plus the opt-in cross-tree hash). Behavioural cover for a wrong copy stays in
`test/hoai-browser-mcp.relay.test.ts` (9 cases, 6 fail against the pre-fix blob). Still unguarded by
design, and stated in both the note and the checklist: a BGOS-side shim change that this repo never
picks up.
