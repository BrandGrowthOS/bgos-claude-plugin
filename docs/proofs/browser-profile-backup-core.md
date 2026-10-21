# Pure backup dependency delivery proof

The plugin ships 27 exact common modules from BGOS commit 7b769071503748def458591d8596f30420bbe3d9. The 11 added files include both dynamically launched worker entries and the fixed paired client, scheduler, readonly capture and encrypted journal dependencies. No agent backup is enabled by this commit.

Independent review compared every committed source blob and manifest hash. The exact vendor and backup-worker suites pass 4 tests with zero skips, with cross-tree verification explicitly enabled. Actual Node workers encrypted a native-shaped synthetic draft, wrote an encrypted journal, and verified readback. On Windows file fsync succeeds; directory fsync remains unproved and is reported false.

Three isolated executable mutations each printed the loaded changed line, failed with AssertionError and exit 1, restored exact bytes, then passed 4 tests with exit 0: missing seal worker entry, missing journal worker entry, and omitted journal worker in the source inventory. Workspace product bytes were unchanged. Set HOAI_BROWSER_PROFILE_CORE_SOURCE to the BGOS checkout, then run scripts/prove-browser-profile-backup-core.py from this repository to reproduce. The JSON records the exact mutations and source closure.

This qualifies pure dependency delivery only. Active agent capture, automatic 60s scheduling, HOAI upload, Linux directory fsync, final npm/Bun package delivery and two-machine physical cleanup remain separate acceptance evidence.
