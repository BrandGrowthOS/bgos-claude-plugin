# Managed browser common runtime qualification

Exact product commit `7106437b6ed128a2fd2f9f5fd7339cd756588e1a` passes all 718 tests in 52 selected files, with zero failures, skips or cancellations. Full TypeScript checking exits 0. The nonroot Linux process uses Node 22.23.3 and pinned Playwright 1.64.1. It finishes normally; the disposable container is positively absent without a forced stop.

All 852 tracked files retain their executed archive SHA256 values after the run. Of these, 851 are byte-identical to their exact Git blobs. Git archive exports `bin/hoai.cmd` with its committed CRLF attribute: its 252 archive bytes equal the 247-byte LF Git blob after newline normalization. The machine-readable receipt records both hashes. No runtime or test source overlay is applied. Archive SHA256 is `6755ca108336244e3fd01f5c045511c8e0b077db62dfa8720b8e1f3daba79c68`.

The explicit scope is the previous 51 common test files plus the new managed instructions test. It covers managed host authority, transport and cleanup, runtime and resume state, paired backup clients, both dynamic backup workers, files, downloads, native field input, permissions, and actual MCP initialize/initialized/tools-list metadata. A real Chromium principal-isolation fixture also executes; synthetic authorization and native doubles elsewhere retain their source-level boundaries.

The selection document and execution marker both name 710. The prior qualified unit image supplies its unchanged installed dependencies only; the exact new archive executes from `/work/source` with a bounded 2 GiB temporary filesystem. No installation or network access occurs during this qualification.

The [machine-readable receipt](browser-profile-common-runtime-final.json) records all selected filenames and 12 raw-file SHA256 values. Raw output is retained privately under `.tmp/browser-runtime-audit/common-final-tests-c063f35e/`; the run-receipt SHA256 is `37dbcba346d175e2d2bef72858dda5b9cde5e90b1c5d09785a7ba1201b50f30e`. The earlier 715-test qualification on 7ecc remains explicitly recorded as historical evidence.

This is a scoped common runtime qualification, not the entire plugin suite. Actual HOAI automatic 60 second backup, cross-machine acceptance, final desktop composition and packaged Codex execution have separate physical receipts. The image provides fixture OS prerequisites; it does not prove a clean operating-system installation or a production login.
