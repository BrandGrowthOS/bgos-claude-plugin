# Managed host keyring environment

The daemon's default headless host filter discarded DBUS_SESSION_BUS_ADDRESS. The managed Linux key-store provider requires an explicit local Unix session bus and correctly refuses when it is absent. A direct-bin fixture that inherited the full environment did not cover this supervisor startup boundary.

The privileged Node host now receives exactly DBUS_SESSION_BUS_ADDRESS and XDG_RUNTIME_DIR in addition to its existing host settings. Headless Chromium strips them again. SSH_AUTH_SOCK, code-loader variables and credential variables remain excluded. The existing deliberately headed Linux browser display/session environment is unchanged.

A coherent committed plugin archive plus the exact two changed environment source/test files passed 45 tests. One existing shell-wrapper case is excluded on Windows. Actual shared endpoint crypto was enabled, with no crypto opt-in skip. Four executable copied-source drills each failed, restored exact bytes and passed: remove Node bus access, remove Node runtime access, leak bus to headless Chromium, and leak runtime directory to headless Chromium. The JSON records the actual changed executable lines and hashes read back before execution. No shared source was mutated.

Actual private Linux keyring qualification through the immutable host filter remains separate from these Windows tests. No production configuration, installed agent or host trust was changed.
