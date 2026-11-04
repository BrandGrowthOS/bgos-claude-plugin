# Independent code review

A read-only reviewer compared the working tree with b251d37 and the brief.
The initial review found four important boundary issues:

1. An unsubstituted marketplace assistant setting bypassed known absence.
2. A selected credentials file rejected for authentication could lend its home
   to another effective identity.
3. Canonical-equivalent home paths attached but did not confirm the home for
   downstream Memory, Skills, Changes and session-pin checks.
4. Multiple recorded homes could not resolve without folder pins or env ids.

All four were reproduced in `review-red.log` before their corrections. The
fixes are covered by `review-regressions.log` and mutations M11 through M15.

On the follow-up review, the reviewer confirmed all four addressed and found
no remaining Critical or Important issues. The review confirmed that the new
selection route remains local, backend reporting remains compatible, pairing
locks treat proven home identity as pinned, and clone scoping and duplicate
copy precedence remain intact. The reviewer read the code, expanded tests and
the final 15-mutation results, but did not run tests or edit any files.

A final read-only review covered the full-suite test updates. It confirmed
that the bootstrap fixture now models CommonJS independently of repository
package scope, Memory/Changes/lock checks remain fully anchored, home-refusal
checks retain handshake and exit ordering, and stand-down tests still execute
the extracted production branch with an explicit clone-path preflight. No
unjustified weakening was found.
