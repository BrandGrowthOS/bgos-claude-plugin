# Native cookie import compatibility proof

A real composed transfer exposed a cookie import refusal. Chromium144 can receive an HTTPS cookie without the Secure attribute. It reports `secure:false` and `sourceScheme:Secure`. The host-only import URL previously followed sourceScheme. Chromium153 inferred Secure from that HTTPS URL and changed the cookie, so the existing strict readback correctly refused activation.

The import URL now follows the actual Secure flag. Explicit sourceScheme and sourcePort metadata remain independent and unchanged. This URL is a CDP parameter only and makes no website request. Domain-cookie and partition handling and strict imported-cookie equality remain unchanged.

The attached JSON records actual Electron40.4.1/Chromium144.0.7559.173 and nonroot sandboxed bundled Chromium153.0.8010.12. Each ran six valid host-only/domain combinations with exact cookie readback. Each also refused the two natively invalid `secure:true`/`sourceScheme:NonSecure` combinations. No live site or account was used.

Reverting executable line61 to the old sourceScheme-derived URL made each focused unit test and each real native probe go red. Exact original bytes were restored, then all four checks passed. The changed executable line and hashes are in the JSON. The full touched suites passed: 37 main tests and 55 plugin tests, zero skips.

These are isolated compatibility and mutation results. The composed desktop-to-agent activation and fresh archived plugin qualification remain separate proofs. Worktree-byte hashes are explicit because Git archive normalizes line endings.

The clean plugin archive at `62b6b0973fd45e71e1913a6528d795d8706e9467` was then installed with `npm ci` in the disposable Linux image. Its normalized native core SHA256 is `2cfdbb6f8e207c81061af5830a28cc940d3410a7471558e9a05f06874edae40e`. The exact archived bytes passed the full 8 case native RTC matrix, 13 phase runtime probe and the cookie matrix. This separate archive receipt is included in the JSON.
