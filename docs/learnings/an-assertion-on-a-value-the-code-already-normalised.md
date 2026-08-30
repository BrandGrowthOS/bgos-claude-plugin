# An assertion on a value the code already normalised cannot fail

**Date:** 2026-08-30

**Context:** An adversarial review of seven changes, run as a fan-out of skeptics told to break each
one, with every surviving finding verified by mutating the implementation and re-running.

**Gotcha / Pattern:** Several tests were green for reasons unrelated to what they claimed to check.
They share one shape: the test reads a value the implementation has ALREADY forced into the asserted
form.

- `assert.ok(entry.description.length <= 100)` looped over the WIRE entries, which
  `prepareSlashCommands` had built with `.slice(0, 100)`. True by construction for every input.
  Deleting the slice left it green.
- `shouldShutdownOnStdin` was tested four ways and consumed by nothing: `server.ts` hard-coded the
  same two event names at the call site. Inverting the predicate broke no test and changed no
  behaviour. A guard no production path consults cannot fail.
- Two shutdown tests grepped `server.ts` for listener text, so they passed against a listener whose
  callback did nothing.
- `.some(isShippingPath)` versus `.every(...)` in the CI version gate: every test case was
  all-shipping or all-furniture, where the two agree. No test passed a mixed list, which is the modal
  shape of a real pull request.
- Four separate breakages to `known-good-store`'s default filesystem survived the whole suite,
  because every test injected a memory fs and the real one never ran.

**How to apply next time:** Three questions, cheap enough to ask on every test you write.

1. **Would this fail if I deleted the line it is about?** If the assertion reads a value the code
   already normalised, it will not. Feed input the guard has to ACT on: a 3,300-character description,
   not a 40-character one.
2. **Does a production path call the thing I am testing?** Grep for a caller. A pure function with
   four tests and no consumer is documentation.
3. **Is there an input shape where two plausible implementations disagree, and does a test use it?**
   `some` and `every` agree on homogeneous lists; only a mixed one separates them.

And where a module has a real-filesystem default beside an injectable one, run the default at least
once, in a temp dir. It is a few lines and it is the only thing that can catch it.

**Regression guard:** Each case now has a test that fails against the mutant, verified by applying
the mutant and re-running: `test/slash-catalog.test.ts` (truncation with an oversized input, plus
behavioural route tests), `test/process-lifecycle.test.ts` (fake stdin, listener counts),
`test/version-bump.test.ts` (mixed-path cases in both directions), `test/known-good-store.test.ts`
(real fs in a temp home).
