# Key helper lifetime and failed-store cleanup

The helper keeps its original promise pending until its original ChildProcess closes, including timeout, abort, output overflow and post-spawn error. It latches the first fixed error and zeroes retained and late output. A late exit0 cannot turn a refused call into success. Pre-aborted calls and synchronous launch failures with no child may still refuse immediately.

The fixed source is frozen at `dab468db70440a7b2fd2a5b919f96f26be7d16bf10b6a5676f840f0ef860ab62`; the existing test file is `2d0da6cdcd8f02a4f1e4d5883bcc0e10063bf654de41363c6e3c3b99d227e8fe`. Exact two-path source commit: `503d22fc4ab154a32b3b588ab77345dc8f949337`. No Host, Companion or activity API changes are part of this repair.

The original actual-import counterexample used synthetic ChildProcess objects. After a stop request, failed endpoint/portable-store cleanup could complete while the original store child remained open. The real Companion.poll/BrowserHost.stop path could then report no pending work and return. The failed operation returned no usable record or saved enrollment. A modeled late unique-item write illustrated the ordering risk; it did not measure an actual libsecret transaction after a kill request.

| Evidence | Result | Boundary |
| --- | --- | --- |
| Full touched test file |33 passed,0 failed/skipped/cancelled; full type-check0 | New lifetime controls use fake children; existing synthetic Node subprocess and actual shared codec opt-in also run. No keyring. |
| Copied loaded original helper |21 passed,12 failed; exit1; unchanged33-case file | Whole mutant equals original source805fe744. First causal case20 is a direct ERR_ASSERTION on premature settlement. Secondary failures include bounded phase assertions. |
| Exact copied restore |33 passed,0 failed/skipped/cancelled | Exact fixed module restored; no assertion/filter change. |
| Actual Linux synthetic helpers | Five expected cases passed on Node22.23.3, UID/GID1000 | Qualified c5 image, networknone and private64MiB tmpfs. Four actual helper PID/start identities gone; missing-executable attempt has no spawned PID. |

The actual Linux run covers normal success, timeout, abort, overflow and a genuine asynchronous ENOENT launch error. Every public result followed original close and stdio closure. Timeout/abort/overflow intentionally used the product's existing SIGKILL request on the original synthetic helper. The wrapper sent no signals and used no force-stop. Docker and SSH exited0, the container was positively absent, and the two live source pins were unchanged. This is physical helper evidence, not a real Secret Service test.

The copied33-case snapshot held244 source hashes at execution. A later unrelated bootstrap-pin change normalized13 CRLF sequences without changing parsed JSON. Its old19fa/current21057 mapping is retained rather than labeling all244 current files unchanged.

Process close does not prove rollback of a D-Bus store already accepted by Secret Service. Cleanup remains restricted to the fresh random record id; a possible unique orphan item is distinct from helper-process cleanup. No disclosure, usable failed enrollment record, older-item deletion or authorization bypass was demonstrated. This proof does not qualify full sessions, real keyring restart, provider login, OS installation or browser behavior.

The [JSON proof](browser-key-helper-lifetime.json) records source pins,21 raw references, the printed executable original line64, all case/process observations and excluded private harness trials. Node's [close contract](https://nodejs.org/download/release/v24.16.0/docs/api/child_process.html#event-close) and [signal-delivery distinction](https://nodejs.org/download/release/v24.16.0/docs/api/child_process.html#subprocesskilled) support the physical ownership boundary.
