# Runtime permissions retain their original async call

Date: 2026-10-15

Context: The managed companion now waits for a recipient's native HOAI answer before a supported browser action. It uses the existing signed runtime endpoint and MCP relay.

Gotcha: A relay response deadline can end before an SDK callback starts. Looking up the current runtime's execution at callback time lets the old callback run without its original context or borrow a newer matching request. Bind the exact originating capability through `AsyncLocalStorage`, check it before read and session callbacks as well as writes, and claim its original tool and arguments once.

Cleanup has its own authority boundary. HTTP body cancellation, page listener removal and native command settlement need positive receipts. Attempt every listener cleanup independently. An uncertain cleanup must retain physical capacity and a private refusal latch even if public promise bookkeeping is cleared. A later consumed readback is never a substitute for one confirmed consume response.

Stored browser extras also outlive creation. A creation check that rejects shutdown cannot be reused as the persistent vault/preference proof: normal checkpoint shutdown would then refuse its own saved state. Bind the persistent callback to a private preparation identity, exact original native runtime, complete authority and acting scope. Invalidate it before disposal while keeping closing checks around new factory work.

How to apply next time: Preserve existing transport seams. Add adversarial delayed-callback and failing-cleanup tests before wiring a new permission path. In mutation tests keep the original valid opaque handle and other unrelated fields intact so the targeted guard is the actual reason for refusal.

Regression guard: `test/browser-profile-companion-permission.test.ts`, the persistent extras cases in `test/browser-profile-companion.test.ts`, and `docs/proofs/browser-profile-managed-permission-mutations.json`.
