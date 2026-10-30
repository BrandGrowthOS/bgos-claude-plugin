# Clone installs follow the published version (board row 01a0db74)

KC, 2026-10-30: "Follow the published version". A host that installs the plugin as a git clone (kc-server, for
example) must take the PUBLISHED version, the tag the hoai marketplace ref names, and never plugin main.
Publishing is the one gate for every host.

Branch `fix/clone-follows-published`: `b9f6f15` (red tests), `4db31cd` (the fix), then the report commits. Not
pushed, no version bump, nothing published. (The branch was rebuilt on 2026-10-30 to split four test-only commits
out to `fix/suite-green-off-ci`; before that the red tests and the fix were `4491ee3` and `800001c`, and the old
history is kept as `backup/clone-follows-published-before-split`.)

## What #268 already covered

PR #268 (`fix/clone-follows-release-and-hooks`, shipped as 0.74.0, board row 84c23fab) fixed the two paths the
DAEMON runs:

- **The daemon's own git self-updater** (`lib/self-update.ts` inspectGitUpdate): the check at boot (boot plus 60 s),
  the nightly check and the one-click update all read the tag the marketplace ref names
  (`lib/published-release.mjs`), fetch only that tag and fast-forward to its commit. A checkout ahead of it is
  "not-newer" and stays. A manifest that cannot be read means no update that round.
- **The watcher's clone update** (`lib/watcher-core.mjs` observeCloneInstall and `lib/update-executor.mjs`): the
  same published tag instead of `@{u}`.

So the boot path of a clone daemon already followed the published release from 0.74.0 on, and nothing in
`run.sh`, the systemd or launchd unit, `hoai run` or the stable wrapper pulls at boot (checked: the wrapper only
rolls back, `run.sh` runs no git).

## What #268 did not cover, and what changed here

Every other way a clone checkout moves still took plugin main:

| Path | Before | Now |
|---|---|---|
| `hoai-agent update` (`bin/bgos-agent` cmd_update) | `git fetch --depth 1 origin main`, then `git reset --hard origin/main`: every change merged since the release, and a host AHEAD of main was moved back to main | moves only to a newer published release; a host at it stays; a host ahead of it is not moved back and says `plugin X is ahead of the published release vY; it is not moved back, and stays at X until a published release reaches it`; a marketplace that is offline or unreadable stops the update with the reason and changes nothing |
| `hoai-agent install` (a new clone) | `git clone --depth 1` of main | main is cloned beside the target, pinned to the published tag, and only then put in place; when the release cannot be read no checkout is made at all (a checkout of main would be found and kept by the next install) |
| `bgos-claim` (`ensurePluginCheckout`) | new checkout: clone of main; existing checkout: `git pull --ff-only` of main | the same two rules as above, through the same code |
| `bin/hoai-bootstrap.sh` and `.ps1`, clone method | `git clone --depth 1` of main | the same pin before the checkout is put in place; an unreadable release is `::hoa-fail::plugin-install` with no checkout left |
| the daemon's check log | `running 0.81.0, latest 0.80.2, no update (not-newer)`, which reads as "up to date" | `running 0.81.0 is ahead of the published release v0.80.2; no update, and it stays at 0.81.0 until a published release reaches it` |

One code path for all of them: `lib/follow-published.mjs` (the rules) and `bin/hoai-published-release.mjs` (the CLI
the shell scripts call: `tag`, `follow <checkout> [--fresh]`). It reuses `lib/published-release.mjs`, the reader
#268 added, so the daemon, the watcher and the installers all read the same ref the same way. The rules:

- the target is the published tag's commit, fetched alone (`--no-tags`, one refspec; a depth 1 clone stays depth 1
  and a full clone is not made shallow), and the tag's own package.json must carry the tag's version;
- only a newer published version moves a checkout; at it, or ahead of it, it stays (ahead is said in words);
- a release that cannot be read, a ref that is not `v<x.y.z>`, or a mislabelled tag changes nothing;
- a checkout with local changes is not touched, and the marketplace is not even read for it;
- a checkout with commits that no remote branch or tag holds is never reset over them;
- a new clone is made beside its place and moved in only once pinned; an empty folder in the way is removed only
  then, and a folder with anything in it is refused.

A manual `hoai-agent update` may still cross a major version (it did before; the daemon's own updater keeps its
same-major rule).

## Tests

Red first on a fake git remote whose main runs ahead of the published tag (a merge after the release, then a
bump that release-tag.yml tagged and nobody published), with the marketplace stood in for by a local manifest
server (`HOAI_PUBLISHED_MANIFEST_URL`) and GitHub by a `git` stand in on PATH. HOME is a temp folder in every test;
no real host, service or `~/.bgos-agent` is touched.

- `test/follow-published.test.ts` (11): behind moves to the tag not main; depth 1 stays depth 1; ahead stays and
  says so; same version with later commits stays; unreadable and non release refs; mislabelled tag; local
  changes; unpushed commits; fresh pins a clone of main; fresh with no release is a failure; the exit codes.
- `test/bgos-agent.update-published.test.ts` (6): the REAL `bin/bgos-agent update`: lands on the published tag
  not main; ahead host not moved back, and not told it is up to date; offline marketplace; HTTP 500, a non
  manifest body and a non release ref; local changes (a guard on behaviour that already held); one hand over to
  the new script.
- `test/clone-install.published.test.ts` (6): the REAL `hoai-agent install` clone (published tag; unreachable
  marketplace leaves no checkout and keeps an empty folder); the REAL clone step of `hoai-bootstrap.sh` (same,
  plus an empty folder replaced only by a pinned checkout and a folder with files refused); the `.ps1` twin by
  its text.
- `test/bgos-claim.published.test.ts` (4, over a file URL so the clone is depth 1 as in the field): new checkout,
  no checkout when unreadable, existing checkout moves, ahead stays.
- `test/self-update.published-release.test.ts` (+1): the daemon's ahead line, a major ahead included.
- `test/bgos-agent.update-reexec.test.ts`: its fixture now publishes the release it moves to.

Red at the test commit `b9f6f15` (then `4491ee3`; the code of c636ded) for the true reasons: 29 of the 30 new node tests and the
new bun test fail. The update and both installers landed on main's head, an ahead host printed nothing about it,
an offline marketplace stopped nothing, bgos-claim pulled main, and the shared module did not exist. The one that
passes there is the dirty tree guard on `hoai-agent update`, which pins behaviour that already held.

Mutation proof: 25 one line mutants, each checked to still parse (`node --check`, `bash -n`, `bun build`), each
killed by an assertion (not a load error), with every test file green unmutated. The run prints the changed line
of each (`-` the line, `+` the mutant); the list:

| Mutant | File | Killed by |
|---|---|---|
| L1 no newer check | lib/follow-published.mjs | follow-published |
| L2 ahead reads as current | lib/follow-published.mjs | follow-published |
| L3 local changes ignored | lib/follow-published.mjs | follow-published |
| L4 tag package.json not checked | lib/follow-published.mjs | follow-published |
| L5 a shallow clone is deepened | lib/follow-published.mjs | follow-published |
| L6 every stay is an error | lib/follow-published.mjs | follow-published |
| L7 an unreadable release falls back to a fixed tag | lib/follow-published.mjs | follow-published |
| A1 update moves backwards (`--fresh`) | bin/bgos-agent | update-published |
| A2 unreadable release only warns | bin/bgos-agent | update-published |
| A3 no hand over after a move | bin/bgos-agent | update-reexec |
| A4 install keeps main | bin/bgos-agent | clone-install |
| A5 install keeps an unpinned clone | bin/bgos-agent | clone-install |
| C1 new claim checkout stays on main | bin/bgos-claim.mjs | bgos-claim.published |
| C2 unpinned claim checkout kept | bin/bgos-claim.mjs | bgos-claim.published |
| C3 existing claim checkout moved back | bin/bgos-claim.mjs | bgos-claim.published |
| S1 bootstrap.sh keeps main | bin/hoai-bootstrap.sh | clone-install |
| S2 bootstrap.sh keeps an unpinned clone | bin/hoai-bootstrap.sh | clone-install |
| P1 bootstrap.ps1 keeps main | bin/hoai-bootstrap.ps1 | clone-install (static) |
| U1 daemon does not say it is ahead | lib/self-update.ts | self-update.published-release |
| R1 a reset drops unpushed commits | lib/follow-published.mjs | follow-published |
| R2 bootstrap.sh removes an empty folder before the clone | bin/hoai-bootstrap.sh | clone-install |
| R3 install removes an empty folder before the clone | bin/bgos-agent | clone-install |
| R4 bootstrap.ps1 carries on after a refused move | bin/hoai-bootstrap.ps1 | clone-install (static) |
| R5 an ahead host is told it is up to date | bin/bgos-agent | update-published |
| R6 a host a major ahead gets the generic line | lib/self-update.ts | self-update.published-release |

R4 first SURVIVED: its static check matched the outer `if (-not (Test-Path ...))` that opens the whole clone
block. The check now anchors on the line right after the move, and kills it.

## Review

An independent read of the diff (a reviewer given the code and the goal, not these conclusions) found nothing that
breaks the goal and raised seven points, all fixed in `4db31cd`:

1. `reset --hard` could drop commits that exist only in the checkout (new for bgos-claim, which used
   `pull --ff-only`): the move now refuses a checkout with commits no remote branch or tag holds.
2. The `.ps1` did not check `Move-Item` (a scanner holding the new `.git` open): it now fails `plugin-install`
   when no `server.ts` is in place, and removes the partial clone.
3. An empty folder in the way was removed before the clone was known to work: now only at the move.
4. An ahead host was told "already up to date": now "no change: the plugin stays at X".
5. Stale "origin/main" comments (`lib/update-rpc.ts`, `server.ts`, `lib/private-hook-presence.ts` and its test).
6. The claim tests cloned a local path, where git ignores `--depth 1`: now a file URL, and the depth is asserted.
7. A daemon a whole major ahead got the generic line (`major-change` is answered first): now by version alone.

### Full suite and type check, macOS and Linux

**This change adds no failure, and on its own the suite is exactly as green as c636ded.** The code on this branch's
tip is the code of `4db31cd` (`git diff 4db31cd HEAD` touches only REPORT.md and the evidence folder).

| | type check | what the suite shows |
|---|---|---|
| CI, c636ded | pass | green on Linux (x86) and Windows; this branch runs there once pushed |
| macOS, plain `npm test`, the change against clean HEAD | pass | the same failing set at both: 45 tests at c636ded, 45 with the change, none new (all browser profile tests, from the macOS temp folder below) |
| Linux, the change against clean HEAD in the same container | pass | the change's failing set is a subset of c636ded's (42 tests against 43), none new |
| macOS and a clean Debian 12 VM, this change plus the four test fixes | pass | green on both: macOS 7801 pass and 0 fail, Linux 7805 pass and 0 fail, Chromium 11 and bun 375 on each |

The 36 new or changed tests pass on every run above, none skipped.

**Off CI, the suite is not green at clean HEAD c636ded either.** Four test-only problems, none in this change's
code, make a stock Mac and a fast arm64 Linux box red: macOS's `$TMPDIR` is a link the browser profile code refuses
on purpose (45 failures and two hung files), two private turn test helpers write a marker the coarse Linux file
clock can stamp before the moment it follows, and a 30 ms fake protocol timeout trips under load. Fixing them is
outside this brief, so (KC's choice, 2026-10-30) the four test-only commits are on their own branch,
**`fix/suite-green-off-ci`** (off c636ded, with their red first runs and mutants in
`docs/evidence/2026-10-30-suite-green-off-ci/`). With that branch's commits the suite and type check are green on
both macOS and the clean Debian VM, as the last table row shows.

The private turn clock edge is worth a look by the owners of `lib/private-turn.mjs`: in the field a Stop comes
seconds after a delivery, so it is not a live bug, but the tracker mixes two clocks.

Evidence in `docs/evidence/2026-10-30-clone-follows-published/`:
- `red-at-4491ee3.log`: the red run (at the red test commit, `4491ee3` before the rebuild, `b9f6f15` now).
- `mutation.log` and `mutate.py`: every mutant with its changed line.
- `final-runs.txt`: the summary lines of the green runs of this change plus the four test fixes on both OSes.
- `failing-tests.txt`: the change against clean HEAD on macOS and Linux, failing set by failing set.

## Rollout: how existing hosts pick it up

1. **Nothing changes on a host until the release that carries this is PUBLISHED** (Data bumps the version and moves
   the marketplace ref). Merging alone reaches no clone host, because since 0.74.0 the daemon's own updater
   follows only the published tag. That is the point of the change.
2. **Clone hosts behind that release** (most of the fleet) take it the usual way: the daemon's check at boot plus
   60 s or its nightly check, or a one-click update from the app. From then on `hoai-agent update`, bgos-claim and
   the bootstrap follow the published release too.
3. **Do not run `hoai-agent update` on a clone host before it has this release.** The update runs the script the
   host already has, and the old script resets to origin/main. Let the daemon take the release first (step 2), or
   check out the published tag by hand (`git -C <checkout> fetch --no-tags origin +refs/tags/vX.Y.Z:refs/tags/vX.Y.Z`
   then `git -C <checkout> merge --ff-only vX.Y.Z`).
4. **Hosts already AHEAD of the published version** (a clone that ran the old `hoai-agent update` or `bgos-claim`
   after a merge, possibly kc-server) are not moved back. They keep running what they have and move again when a
   published release passes them. Once they run this code, their daemon log says so at each check
   (`... is ahead of the published release ...`). To see where a host stands, read only:
   `git -C <checkout> log -1 --format=%H`, its `package.json` version, and the marketplace ref
   (`https://raw.githubusercontent.com/BrandGrowthOS/hoai-marketplace/main/.claude-plugin/marketplace.json`). To
   put such a host back on the published version on purpose, that is an owner decision and a manual step on a
   clean checkout (the fetch in step 3, then `git -C <checkout> reset --hard vX.Y.Z`, then a restart); nothing here
   does it.
5. **A checkout with local changes, or with commits no remote branch or tag holds,** is never moved by
   `hoai-agent update` or bgos-claim any more; they say why. Whoever owns that work resolves it by hand.
6. **The bootstrap scripts** take effect wherever the app gets them from (they live in this repo; if the desktop
   app fetches them from main rather than from a release, that part is live at merge). Either way they only change
   NEW clone installs.
7. Marketplace installs are untouched: they already only get what the marketplace ref names.

## Not done

- The `.ps1` clone step is pinned by its text only: no PowerShell was available to run it here (the Windows CI job
  runs the suite, and the same `.ps1` test runs there).
- kc-server was not inspected (the brief: no real agent host). Whether it is ahead today is for whoever has access to
  check with the read only commands in step 4.
- The Windows leg of CI was not run here.
