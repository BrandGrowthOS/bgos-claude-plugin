# fix/email-files-hardenings (lane mailharden, board row 84f19b9f)

Follow ups Data found when gating plugin #296 (peer msg 178687). Branch made from #296's head
70b93259eb (feat/email-send-files). #296 was still open when this branch was cut, so it stays on #296 and
its PR targets feat/email-send-files.

Goal: an agent that emails a file from the computer can only send a real, single file it is allowed to
read, and a trick file can never freeze it.

## Stop check

No PR or branch of BrandGrowthOS/bgos-claude-plugin had built this: PR search for nlink, O_NONBLOCK, FIFO and
homesOf found only unrelated FIFO hits (#201, #214, #242, #261), and a grep of every remote branch found
nlink, O_NONBLOCK and isFIFO in lib/email-outbound-files.ts on none.

## What changed (lib/email-outbound-files.ts, plus one doc comment in lib/agent-email-tools.ts)

1. homesOf returns each home beside its real path (realpathSync.native, plainLocal). Only the home is resolved,
   never the path being checked, and only a home that homeForm accepts and that is absolute on this computer,
   so a UNC, relative or drive top home reaches no file system call. secretWordsForm and underRuntimeDir read
   it, so a file named by the home's real path is read below the home (a "John Key" home refuses nothing of
   its own), and a runtime folder that holds the real home is not taken as one. This holds for a home passed
   in and for the daemon's own (os.homedir(), and USERPROFILE on Windows).
2. A file with more than one name (nlink above 1) is refused: on the lstat (before the open, so it is never
   opened) and again on the open handle's fstat (so a second name made after the lstat is caught).
   Sentence: "<path> has more than one name (a hard link), so it is not attached."
   A stat with no nlink (only a test's fake) counts as one name, as an unknown dev or ino already falls back.
3. The open uses O_RDONLY | O_NONBLOCK where the platform has it; on win32 it is O_RDONLY alone (what 'r'
   was), whatever fs.constants says, so undefined never reaches the flags. A FIFO swapped in after the lstat
   opens at once and the existing handle check (regular file, same dev and ino) refuses it as "changed while
   HOAI read it" before a byte is read. OutboundFs.open now takes numeric flags; every fake ignores them.

The claims that steps 1 and 2 make "no file system call" now say "on the path": homesOf reads the owner's own
home for its real path. A network or device path still meets no file system call at all, home included.

One existing test changed: the "second look" test made a hard link into .ssh to show the second look runs
steps 1 and 2 on the same file. A hard link is now refused before the open, so it reaches the same file
through a junction in .ssh instead; the assertion and its sentence are unchanged. Two messages of the
Windows alias tests now say "through the given file system", which is what they count.

## The 2 macOS tests

With TMPDIR behind a symlink (scratch mac/var to mac/private/var, the shape of macOS's /var), #296's earlier
head a0d5426 fails exactly 2 tests of test/email-outbound-files.test.ts: "review round 4: the word rules read
only the path below the home folder ..." and "final fix 2: the runtime folders are also taken by their real
path ...". On 70b93259eb both already pass (resolvedHomeCtx for the first, a fixture canonicalized with
realpathSync.native for the second), and they pass after this change too. What 70b93259eb still refused is a
file named by the home's real path (the preflight and step 1 read the whole path, so "John Key" refused it)
and a runtime folder holding the real home: that is the new "mailharden 1" test. a0d5426's own text of the
runtime folder test still differs in wording only when its file is named through the /var link ("leads to
... (HOAI followed its links)" instead of "is in"): the file is refused either way and the followed sentence
is the accurate one, so the product wording is left alone.

## Proof

- Red first on 70b93259eb's lib with the final test text: all three new tests fail (1: the preflight refuses
  the real path; 2: the hard link into .ssh is read; 3: the open of a FIFO blocked for 3 s). Green after.
- The six email test files that import the module (email-outbound-files, agent-email-files,
  agent-email-files-admission, email-files, agent-email-send, permission-card-email-send): 338 of 338, plain
  and with TMPDIR behind the var to private/var link.
- docs/notes/fix-email-files-hardenings-probe.mjs, lib at 70b93259eb: node 24.22.1 and bun 1.3.14 both BLOCK
  on the FIFO swap and READ the hard link. Fixed lib: the swap, a FIFO there from the start and the hard link
  all return at once (0 to 12 ms) with plain sentences, under both runtimes.
- Mutants, each killed by its own test: handle nlink check removed (2), path nlink check removed (2),
  O_NONBLOCK removed (3), O_NONBLOCK passed on win32 (3), real home not added (1), real home added only for a
  passed in home and not the daemon's own (1, "no home passed: the preflight"), handle regular file check
  removed (3).
- tsc --noEmit clean under heavy --light.
- Full suite under heavy on this WSL: bun family 374 of 374. The node family is not all green here, and every
  failure also fails on an untouched 70b93259eb checkout on this machine; none of those files imports the
  changed module. They are the 10 real Chromium cases (no browser here: the cached Playwright Chromium lacks
  libnss3, and installing it needs sudo), private-turn-late-line (2 every run) and private-turn-owner-authority
  and owner-tap (a varying few, on base too, 3 runs each side), browser-profile-sync-key-store "failed OS store
  cleanup waits original close", and two browser-profile-node-runtime timeouts under full load (green alone).
  CI's Linux and Windows legs are the clean run.

## Review (fresh reviewers, four lenses, each finding put to a skeptic)

- Time of check: approve. Every swap tried after the lstat is refused (a FIFO, a link to a FIFO, a second
  name, a rename over the file, an unlink to nlink 0); the order of the fstat count and the second look does
  not matter. One PRE-EXISTING gap, confirmed and not changed here: a parent folder swapped back and forth
  (renameat2 RENAME_EXCHANGE) between a real folder and a link into ~/.ssh can get a single-name file of the
  key folder read, because every path based check can see a different state. Same rate on 70b93259eb (3.6%)
  and after (3.4%). Proposed follow up, for Ares to decide: on Linux, after the fstat, readlink
  /proc/self/fd/<fd> and run the lexical checks on that kernel path (verified under node and bun); macOS
  (F_GETPATH) and Windows (GetFinalPathNameByHandle) have no node or bun API, so there it stays a written
  known limit. The agent can already copy a key file (the accepted limit), so the race buys no more than a
  copy does.
- Links and homes: approve. The real home gives no exemption the old resolvedHomeCtx did not already give the
  same file by its link spelling; siblings (John Keys), a real home of / or of a broad folder, and relative,
  UNC and drive letter homes on Linux were all checked.
- Windows: approve. Flags on win32 are O_RDONLY exactly as 'r' was; NumberOfLinks is 1 on FAT, exFAT, ReFS
  and Dev Drive and for an 8.3 alias. Fixed from it: the sentence no longer says "on this computer" (a hard
  link on an SMB share has its second name on the server), and the "no file system call" claims now say "on
  the path".
- Test honesty: every mutant dies at the assertion its test names. Added from it: the daemon's own home (no
  ctx.home; HOME and USERPROFILE pointed at the linked home).

## Residuals, not done here

- The parent folder swap race above.
- macOS is not run here (no Mac, and CI has no macOS leg). Whether bun's realpath.native on macOS opens the
  last part of a path (to ask F_GETPATH) is unverified: if it opened a FIFO blocking, step 3 could hang before
  the non-blocking open. The probe's "FIFO from the start" line answers it on a Mac.
- O_NOFOLLOW is not added (not asked): the dev and ino handle check already refuses an open that a link
  swapped in after the lstat sent elsewhere.
- A regular file on a hung network or FUSE mount can still hold the read; O_NONBLOCK does nothing for a
  regular file.
