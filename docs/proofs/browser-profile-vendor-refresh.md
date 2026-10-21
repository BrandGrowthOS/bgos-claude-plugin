# Browser profile core vendor refresh

15 October 2026. Local review branch only. No production or installed agent was changed.

The shipped generator copied all nine core modules from committed BGOS source
`901647978b666739575074c44c7e92160fe6bcf9`. The previous pin lagged behind the
human readiness and permission helpers. The generated semantic change adds
those fixed desktop client methods; the paired adapter still uses only shared
signing helpers and does not instantiate or inherit the human Bearer client.
No wire or paired runtime behavior was changed in this refresh.

An independent reviewer compared every module byte for byte with `git show` at
the declared source commit and checked every SHA256 in `vendor.json`. All nine
match. The actual frozen Chromium153 companion proof at `ce7eeb9` remains
historical evidence for that archive. The next native navigation proof must
use an archive containing this refresh.

Validation:

- Seven exact vendor, pairing, runtime, permission and companion suites:
  127 cases passed, zero skipped. The cross-tree test used the declared commit
  in the BGOS checkout, rather than its mutable worktree.
- Plugin `tsc --noEmit`: exit 0.
- [Executable mutation receipt](browser-profile-vendor-refresh-mutation.json):
  changed the real `pendingRuntimePermissions` method from GET to POST. The
  pinned-byte test failed with an assertion and exit 1. Exact original bytes
  were restored; the same test and the seven suites passed again. The receipt
  prints the changed executable line and both source hashes.

This pin check detects bundled source drift. It does not establish physical
input latency, provider sign-in compatibility, reverse relocation or release
acceptance.
