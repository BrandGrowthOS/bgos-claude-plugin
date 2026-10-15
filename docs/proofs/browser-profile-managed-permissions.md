# Managed permission composition proof

Date: 2026-10-15

The companion now connects a recipient's native HOAI decision to the one original signed runtime RPC through the existing MCP relay. It preserves hard policy denials, excludes credential entry and scripting, consumes an allowance once, and checks the original page, complete authority, endpoint, socket and callback context before acting. PDF retains its existing read policy.

## Focused validation

The final four relevant suites passed 56 tests with zero failures, cancellations or skips:

```text
node node_modules/tsx/dist/cli.mjs --test test/browser-profile-companion-permission.test.ts test/browser-profile-companion.test.ts test/browser-profile-companion-host.test.ts test/browser-profile-permission-client.test.ts
node node_modules/typescript/bin/tsc --noEmit
```

The compiler completed without diagnostics. No full repository suite was run.

The new composition tests use the actual `ProfileRuntimeEndpoint` state machine and unchanged `RelaySessions`, with explicit signed-dispatch and human-answer fixtures. They prove one original action and consume, denial and uncertain-consume refusal, excluded operations, original page and authority fences, duplicate callback rejection, and an old SDK callback released during a newer matching read, write or session request. An actual permission HTTP client case holds a late streaming response cancellation while native disposal starts independently, then verifies that no late action executes. Failed HTTP and page listener cleanup retain private reservations.

Stored extras proof tests reproduce the daemon EOF failure: the original creation-only checker rejected `closing=true` during saved login and preference capture. The replacement persistent proof permits the exact original runtime's normal shutdown and refuses replacement authority, recipient, disposal and revocation. Creation remains fenced before and after factory awaits. A separate close test seals a real synthetic checkpoint, transitions a server fixture to stopped and disposes the native runtime while preserving the existing protocol's uncertain active-RPC close outcome.

These are deterministic fixture proofs. A fresh installed plugin, actual Linux keyring, native desktop approval, real HOAI HTTP and two-machine EOF/checkpoint transfer need the separate complete archive proof. No production user record was exercised by this slice.

## Direct mutation proof

[The machine-readable receipt](browser-profile-managed-permission-mutations.json) records 30 final direct mutations. Each changed executable line was printed, the selected test failed with an assertion and exit 1, the original source bytes were restored exactly, and the same selected test passed with exit 0. Every selection executed a positive number of tests. Syntax, compilation failures and timeouts were not accepted as proof.

Mutations cover original page and message identity, navigation history, answered versus historical consumed status, one consume, unknown consume, post-consume checks, transactional listener ownership, independent listener cleanup, private cleanup fences, original callback and argument claims, full runtime/endpoint/binding/recipient identity, originating asynchronous context, cancellation reaching native work, physical disposal drain, persistent extras lifetime, private preparation revocation and creation-time shutdown checks.

Two exploratory trials are excluded. The first message-byte trial survived because a synthetic response used an unrelated invalid opaque handle; the fixture now retains the original handle and the final targeted guard mutation fails as intended. The first disposal-drain trial timed out because an early assertion skipped resolving a deferred fetch; cleanup now resolves the fetch and cancellation in `finally`, and the same executable mutation then produced an assertion failure. A non-unique search guard also stopped the runner before any edit and was narrowed to the exact admission expression.

The receipt distinguishes tested worktree bytes from Git's required LF normalization. The executable source is identical after replacing CRLF with LF, and both hashes are recorded. Mutation restoration applies to the exact tested bytes.

## Independent review and security

Root and the independent handover reviewer closed the final source review. Review found and fixed transactional listener cleanup and the asynchronous callback context race. The final lifecycle delta was independently exercised with 42 focused tests before the final 56-test run. Subsequent fixture refinements strengthened the targeted failure paths without changing the reviewed production source.

The security model and remaining limits are in [managed runtime permissions](../browser-profile-managed-permissions.md). HOAI authorizes the human answer. A compromised HOAI server or approved agent operator remains inside that trust boundary. This feature grants no automatic password, OTP, text-entry or arbitrary-script authority. An unknown consume result never executes or retries. This slice does not claim production deployment, a real native user decision or complete cross-machine acceptance.
