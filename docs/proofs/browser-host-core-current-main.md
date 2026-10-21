# Browser host policy matches current main

The common plugin now copies the complete policy, settings and profiles tier from pinned BGOS main d1bcd4e2b7cfc14df3e37dc367fd6a0184f75cba. Settings and profiles are unchanged. The policy hash is 8219e9b39276b9ef90fb6288c80872b1b8c4f968fd21bde6fa79a0fe4cbc0048, matching the desktop pin. The new main change supplies complete permission intent wording for tools such as close, drag and a single form field. Classification, relay and consent rules are unchanged by this copy.

All eight existing vendor tests pass with the cross-tree check enabled. In a private copy, changing the loaded browser_close wording to the executable line below makes the public intentPhrase assertion fail and makes the vendor hash and cross-tree assertions fail. That vendor run executes all eight cases: six pass and two fail. Exact restoration passes all eight without skips and restores the public phrase assertion.

```js
return "BROKEN close wording";
```

The changed line is 852 of the copied policy. The adjacent JSON records all source and raw hashes. Shared source was not mutated for the drill. This is source parity and gate wording proof; it does not substitute for the separate native runtime, HOAI or complete package acceptance.
