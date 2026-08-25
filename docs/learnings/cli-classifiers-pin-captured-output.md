# CLI classifiers must be pinned on captured real output, never on help text

**Date:** 2026-08-25

**Context:** Building the marketplace update path (`lib/plugin-cli.mjs`): the executor runs `claude plugin update hoai@hoai` and must classify the outcome (updated / already current / failed / garbage) from the CLI's text, because the exit code alone does not say whether anything changed.

**Gotcha / Pattern:** The first classifier was written against the `--help` text, which says an update "requires a restart to apply". The real success line on CLI 2.1.241 is
`✔ Plugin "hoai" updated from 0.38.3 to 0.38.4 for scope user. Restart to apply changes.`
Neither the help phrasing nor a plain "updated" substring matched it reliably, so every successful update would have been classified as garbage, which the escalating repair then "fixes" with an uninstall + reinstall of the version it had just installed. The bug was only found by running the real CLI once against a throwaway marketplace and capturing the bytes.

**How to apply next time:** Before writing any classifier for an external CLI, run the real command once in a sandbox and paste the captured line into a golden test. Make the fake CLI used by the sandbox tests print that exact line (byte for byte, including the check mark), so the classifier and the fixture cannot drift apart. Treat the help text as documentation of intent, not of output.

**Regression guard:** `test/plugin-cli.test.ts` (`classifyUpdate` golden lines) + `test/fixtures/fake-claude.mjs` (prints the captured line). The end-to-end proof is in the BGOS PR: a real `claude plugin update` 0.38.3 to 0.38.4 classified `updated`.
