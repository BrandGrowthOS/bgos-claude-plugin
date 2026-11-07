// ── Agent email files: the one rule for what counts as a text file ──
//
// A .txt or .csv email file must be clean text: valid UTF-8 with no NUL and no control character but tab, newline,
// form feed and return. A text that opens with markup is still text: the backend serves a Word or Excel file's
// extracted text as attachment-N.txt, and a document may well begin with '<'. It is saved as text and only ever read
// with Read, never opened or run.
//
// Both directions read this one function, so the rule cannot drift between them: a file that comes in
// (lib/email-files.ts isType, on the daemon's main thread, for a download) and a file to attach (the content Worker,
// lib/email-outbound-content.ts, which reads the text it returns, so the whole file is decoded once and never on
// the main thread).
//
// No em or en dashes in this file.

/** Every control character a clean text may not hold: all of C0 but tab, newline, form feed and return; DEL; all of C1. */
const CONTROL = /[\u0000-\u0008\u000B\u000E-\u001F\u007F-\u009F]/

/** The bytes decoded as clean text, or null when they are not clean text (see the rule above). */
export function cleanTextOf(bytes: Uint8Array): string | null {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
  return CONTROL.test(text) ? null : text
}
