# Bounded Node browser test fixtures

The runtime remains exactly the committed 418aa6dc implementation. The documentation-only 16ca2b40 successor and three test fixture repairs were qualified together in a disposable nonroot Linux image with Playwright 1.64.1, Chromium 156 and Bun 1.3.9. No installed agent or production configuration changed.

The first combined Node run retained 708 tests, 682 passes, 2 failures and 24 cancellations with zero skips. Its unit image lacked Git for the external committed-source check. One launch test exhausted 100 immediate turns before asynchronous setup reached the runtime factory. Synthetic download tests awaited intentionally unreferenced production timers without the browser socket that normally keeps Node alive. TypeScript was clean and runtime bytes were unchanged.

The launch fixture now awaits an explicit factory-entry latch with a referenced 5 second entry deadline and 10 second test timeout. It retains the original held launch, revocation, exact disposal count and cleared runtime assertions. The two download files run their original test bodies under 15 second native test deadlines with a referenced fixture interval, cleared both by test cleanup and finally. Production timers and all behavior assertions stay unchanged.

The final manifest derives 47 existing test files from the change against c8f17d0 and adds only the directly affected host-core vendor, host supervisor and legacy host download files. All 50 files ran with `node --import tsx --test --test-concurrency=1`; 708 passed, zero failed, cancelled or skipped. `tsc --noEmit` exited 0. All 598 executed source and test hashes matched before and after. All 842 tracked worktree raw hashes also stayed unchanged. Docker positively reported the container absent after normal exit, with no forced stop.

A private copy with the factory-entry await omitted failed with ERR_ASSERTION, then passed after exact restoration. Separately, unreferencing each fixture keeper reproduced Node cancellation and each restored case passed. Those two results are causal harness diagnostics, not assertion mutation proof. Each changed executable line and raw output is retained in the JSON receipt.

The cross-tree check uses exact real BGOS commit/path-tree/blob objects, and the host-core check reads the separately pinned original bytes. The image uses fresh development dependencies plus Git and a separate Bun install. The legacy E2E has an explicit exact bundled Chromium executable; default sanitized cache discovery and exact/foreign CA checks are separate receipts. Existing Windows CRLF checkouts were preserved; execution uses exact Git product bytes. This receipt does not claim physical human actions or a deployment.

Raw paths, SHA256s, the complete selected manifest, exact source hashes and both successful and failed trials are recorded in [the machine receipt](browser-profile-node-fixtures.json).
