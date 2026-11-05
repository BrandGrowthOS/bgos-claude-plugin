// ── Agent email files, outbound: the plugin's check of every file to attach ──
//
// HOAI row 5b141728, step 2 (DESIGN-OUT.md D7, rule 4). email_draft and
// email_send take `files: [{ path }]`. Rule 1 follows the agent's usual send
// setting, so in Send for me with Always ask off nothing after this file and
// rule 2's turn check stops a file going out: this file is where a key, a
// password store or a sign in file is refused, before any byte is read.
//
// Each path goes through four steps, in this order:
//   1. a lexical refusal BEFORE any file system call: not a full path, a
//      network (UNC) or device path (\\host, //host, \\?\, \\.\, and on a
//      path with a drive letter or on Windows a device name or a stream
//      after a colon), a Unix system folder (/proc, /dev, /sys, /etc). A
//      stat of \\host\share on Windows opens an SMB
//      connection and can hand the user's NTLM hash to that host (G2), so
//      nothing here may touch such a path;
//   2. backslashes read as slashes, then the secret list
//      (OUTBOUND_SECRET_PATTERNS) and lanePathIsSecret (lib/hard-floor-lane.mjs,
//      which splits on slashes only, so it is always handed the forward slash
//      form: G1);
//   3. realpath.native, then steps 1 and 2 again on the real path: a link in
//      a plain folder that leads into ~/.aws is caught here;
//   4. a regular file, read through one open handle checked against the
//      stat, at most 25 MB each and 25 MB in all, at most 10, and its bytes
//      the type its name says, on the same safe list as an inbound file
//      (lib/email-files.ts isType); a text file whose header has a password
//      column is a renamed password export, and one that holds a private key
//      or an age key, a cookie file's header, this daemon's own credential,
//      anything the secret scanner finds (lib/secret-scan.ts, the scan an
//      email's words get) or a password written out anywhere in it is
//      refused. Round 3: a Word file's words and an Excel file's shared
//      strings get the same checks. A PDF's words are not read: a PDF is
//      caught only by its name. Round 5: the password table check reads a
//      Word or Excel file row by row (each Word table row, the first rows of
//      each Excel sheet, inline strings too), as a text header is read.
//      Round 4: a disk recovery key (BitLocker's eight groups of six digits,
//      or "recovery key:" and a grouped value) and a run of 12 or more BIP39
//      words (a wallet recovery phrase) are refused too, and the word rules
//      of the secret list read only the path below the home folder.
//      Round 7: that content stage (everything that reads a file's words)
//      lives in lib/email-outbound-content.ts and runs in a worker thread
//      that is terminated at OUTBOUND_CONTENT_DEADLINE_MS (5 seconds); late,
//      broken or unreadable, the file is refused. Steps 1 to 3 and the size
//      and type checks of step 4 stay on the main thread. Round 8: one long
//      lived Worker, reused for every file and replaced only after a deadline,
//      an error, an exit or a bad reply; the deadline is 5 seconds plus 1 per
//      MB (at most 40); a path over 4096 characters is refused before any
//      pattern reads it. Round 9: the Worker keeps its own budget and
//      answers a slow file itself, the hard deadline ends after it, and at
//      most OUTBOUND_CONTENT_WORKERS_MAX Workers start in the daemon's life.
//
// Every refusal is one plain sentence that names the file and says why. The
// file system functions are injected (ctx.fs), so a test proves that a
// network path met no file system call at all. The backend checks the type,
// the size and the count again and runs a virus scan (rule 3), which looks
// for no password or key: for a secret, this file is the only wall.
//
// No em or en dashes in this file.

import { realpath as realpathCallback, realpathSync } from 'node:fs'
import { lstat as lstatPromise, open as openPromise, realpath as realpathPromise } from 'node:fs/promises'
import { homedir } from 'node:os'
import { Worker } from 'node:worker_threads'

import {
  CONTENT_VERDICT_KINDS,
  FOREIGN_PASSWORD_WORDS,
  OFFICE_TEXT_MAX,
  PASS_OR_PIN,
  SHORT_PASSWORD_WORDS,
  type ContentType,
  type ContentVerdict,
} from './email-outbound-content.ts'
import { isType, TYPE_OF_EXTENSION, type EmailFileType } from './email-files.ts'
import { parsePreviewObject } from './email-send-approval.ts'
import { lanePathIsSecret } from './hard-floor-lane.mjs'

/** At most this many files go with one email (the backend's AGENT_EMAIL_OUTBOUND_MAX_FILES). */
export const AGENT_EMAIL_OUTBOUND_MAX_FILES = 10
/** At most this many bytes, each file and all of them together (the backend's AGENT_EMAIL_OUTBOUND_MAX_BYTES). */
export const AGENT_EMAIL_OUTBOUND_MAX_BYTES = 25 * 1024 * 1024

const MB = 1024 * 1024

/**
 * THE SECRET LIST (rule 4), read on the lower case, forward slash, resolved
 * form of a path (`c:/users/kc/.ssh/id_rsa`, `/home/kc/.aws/config`). Any
 * match refuses the file. lanePathIsSecret runs beside it and adds
 * .config/gcloud, .bgos-plugin-state, another person's lane and any `..` that
 * climbs out. One list, so a test can empty it and see the refusals go.
 *
 * Round 4: it has two halves. SECRET_PLACES (a key or cloud folder, a key
 * file, a browser profile store, a keychain, ~/.claude, ~/.bgos-*, any .hoai
 * folder) is read on the whole path. SECRET_WORDS (a word an owner puts in a name: key, seed,
 * pass, wallet) is read only on the path below the owner's home folder when
 * the file is inside it (secretWordsForm), so a home named after a person
 * (C:\Users\John Key, /Users/amy.seed) does not refuse every file on the
 * computer. Outside the home the whole path is read, as before.
 */


// Round 4: ONE vocabulary of password words (FOREIGN_PASSWORD_WORDS, SHORT_PASSWORD_WORDS, PASS_OR_PIN), read by the
// name rules below and by the content checks; round 7 moved it to lib/email-outbound-content.ts with those checks.

/** Where a secret lives, whatever the path above it: read on the whole path. */
const SECRET_PLACES: readonly RegExp[] = [
  // .env, .env.local, .envrc: any segment.
  /(?:^|\/)\.env[^/]*(?:\/|$)/,
  // Key and cloud folders.
  /(?:^|\/)\.(?:ssh|aws|gnupg|azure|kube|docker|password-store)(?:\/|$)/,
  // A git folder: its config can hold a token, its objects the whole history.
  /(?:^|\/)\.git(?:\/|$)/,
  // Key and certificate files.
  /\.(?:pem|key|p12|pfx|ppk|kdbx|keystore|jks)$/,
  // id_rsa, id_ed25519, id_ecdsa.pub: anywhere, not only in .ssh.
  /(?:^|\/)id_[^/]*$/,
  // Password files of common tools.
  /(?:^|\/)\.(?:netrc|npmrc|pypirc|pgpass|git-credentials)$/,
  // sops keeps its age key at ~/.config/sops/age/keys.txt, ~/Library/Application Support/sops/age and %AppData%\sops\age.
  /(?:^|\/)(?:\.config|library\/application support|appdata\/roaming)\/sops(?:\/|$)/,
  // Browser profile stores: Chrome, Edge, Brave and Chromium keep every profile under "User Data" on Windows.
  /(?:^|\/)user data(?:\/|$)/,
  /(?:^|\/)firefox\/profiles(?:\/|$)/,
  /(?:^|\/)\.mozilla(?:\/|$)/,
  /(?:^|\/)library\/application support\/(?:google\/chrome|microsoft edge|bravesoftware|chromium|firefox)(?:\/|$)/,
  /(?:^|\/)\.config\/(?:google-chrome|chromium|microsoft-edge|bravesoftware)(?:\/|$)/,
  /(?:^|\/)(?:login data|login data for account|cookies|cookies\.sqlite|key3\.db|key4\.db|logins\.json|signons\.sqlite|web data|local state)$/,
  // Round 5: Opera's profile (AppData\Roaming\Opera Software), a snap or flatpak browser's (~/snap/firefox,
  // ~/.var/app/org.mozilla.firefox, every flatpak app's data), and Safari's and macOS's cookie store.
  /(?:^|\/)opera software(?:\/|$)/,
  /(?:^|\/)snap\/(?:chromium|firefox)(?:\/|$)/,
  /(?:^|\/)\.var\/app(?:\/|$)/,
  /(?:^|\/)library\/safari(?:\/|$)/,
  /(?:^|\/)library\/cookies(?:\/|$)/,
  // Round 5: Windows' own key and credential stores (DPAPI master keys, the vault, saved credentials).
  /(?:^|\/)appdata\/(?:local|roaming)\/microsoft\/(?:protect|vault|credentials)(?:\/|$)/,
  // Round 5: shell history, where a typed password or token stays: PowerShell's ConsoleHost_history.txt and a
  // *_history file (.bash_history, .zsh_history, .python_history).
  /(?:^|\/)psreadline\/consolehost_history\.txt$/,
  /(?:^|\/)[^/]*_history$/,
  // Keychains.
  /(?:^|\/)library\/keychains(?:\/|$)/,
  /\.keychain(?:-db)?(?:\/|$)/,
  // Claude's own folder and file (~/.claude, ~/.claude.json), and every HOAI state folder (~/.bgos-agent, which holds
  // the stranger's email files, and ~/.bgos-plugin-state, which holds the pairing).
  /(?:^|\/)\.claude[^/]*(?:\/|$)/,
  /(?:^|\/)\.bgos-[^/]*(?:\/|$)/,
  // Final fix 4: every .hoai folder, as the tool text and the session instructions promise: ~/.hoai (the Agent Browser's
  // sessions, screenshots and downloads) and <agent folder>/.hoai/board-files, the owner's board files included.
  /(?:^|\/)\.hoai(?:\/|$)/,
]

/** Words an owner puts in the name of a secret: read on the path below the home folder (round 4). */
const SECRET_WORDS: readonly RegExp[] = [
  // credentials, credentials.csv, db-credentials.txt, credentialsbackup.txt, credential.txt, a Credentials folder: the
  // word anywhere in a file or folder name, as the password word is (credentialing is not it).
  /(?:^|\/)[^/]*(?:credentials|credential(?![a-z]))[^/]*(?:\/|$)/,
  // Password exports and the files of password managers: Chrome Passwords.csv, logins.csv (Firefox),
  // bitwarden_export.csv, a Passwords folder, recovery-codes.txt. Each is a safe type, so its name is the wall.
  // A file named with the word, or a folder named just Password(s); a folder that only has the word in a longer
  // name (a password-reset-app project) is not a store.
  /(?:^|\/)(?:passwords?(?:\/|$)|[^/]*passwords?[^/]*$)/,
  /(?:^|\/)logins?[^/]*\.csv$/,
  /(?:^|\/)(?:bitwarden|lastpass|1password|keepass|dashlane|nordpass)[^/]*(?:\/|$)/,
  /(?:^|\/)[^/]*(?:recovery|backup)[ _-]?codes?[^/]*$/,
  // A folder named for passwords (My Passwords, old_passwords), a password manager or a password vault: every file
  // in it. The singular word in a longer folder name (password-reset-app) is still a project, not a store.
  /(?:^|\/)[^/]*(?:passwords|password[ _-]?(?:manager|vault))[^/]*\//,
  // Recovery keys and wallet secrets, as a file or a folder: BitLocker Recovery Key 1A2B3C4D.TXT (the name Windows
  // gives a saved key), seed phrase.txt, wallet-recovery-phrase.txt, mnemonic.txt, a wallet backup, and 2FA, MFA or
  // OTP backup codes and secrets. Each is a safe type, so its name is the wall.
  /(?:^|\/)[^/]*recovery[ _-]?keys?[^/]*(?:\/|$)/,
  /(?:^|\/)[^/]*(?:seed|recovery)[ _-]?phrases?[^/]*(?:\/|$)/,
  /(?:^|\/)[^/]*mnemonic[^/]*(?:\/|$)/,
  /(?:^|\/)[^/]*(?:wallet[ _-]?backup|backup[ _-]?wallet)[^/]*(?:\/|$)/,
  /(?:^|\/)[^/]*(?:2fa|mfa|otp)[ _-]?(?:backup|recovery|codes?|secrets?)[^/]*(?:\/|$)/,
  // Review round 2: names a reasonable owner gives a key, token or sign in file, as a file or a folder. Each is a safe
  // type, so its name is the wall. A word that is often part of an ordinary name counts only where it ends the name
  // (session token.txt, but not token economy deck.pdf; github login.txt, but not login page mockup.png).
  // secrets anywhere; secret where it ends the name (client secret.txt, but not Secret Santa.xlsx or secretary).
  /(?<![a-z0-9])(?:secrets(?![a-z])|secret(?:\.[^/]*)?(?:\/|$))/,
  // An api, access, secret or private key: api keys.txt, kc_accessKeys.csv (the AWS console's download), eth_private_key.
  /(?<![a-z0-9])(?:api|access|secret|private)[ _-]?keys?(?![a-z])/,
  // A file or folder named just key or keys: keys.txt, Keys/stripe.txt (not key results, keynote or house keys).
  /(?:^|\/)keys?(?:\.[^/]*)?(?:\/|$)/,
  // A name that ends with token or tokens: tokens.txt, session token.txt, a Tokens folder.
  /(?<![a-z0-9])tokens?(?:\.[^/]*)?(?:\/|$)/,
  // A login file: logins anywhere, login details or info, or a name that ends with login.
  /(?<![a-z0-9])log[ _-]?in(?:s(?![a-z])|[ _-]?(?:details|info)|(?:\.[^/]*)?(?:\/|$))/,
  // A sign in file: sign in details or info, or a name that ends with sign in. A Sign-in sheet.pdf (who came to a
  // meeting) and a list of event sign-ins are not a sign in to an account, so they go.
  /(?<![a-z0-9])sign[ _-]?in(?:[ _-]?(?:details|info)|(?:\.[^/]*)?(?:\/|$))/,
  // passwd anywhere, pwd or pwds as a word.
  /passwd|(?<![a-z0-9])pwds?(?![a-z0-9])/,
  /passphrases?/,
  // A seed: seed words, or a name that ends with seed (not seed round deck or sunflower seeds).
  /(?<![a-z0-9])seed(?:[ _-]?(?:words?|phrases?)|(?:\.[^/]*)?(?:\/|$))/,
  /backup[ _-]?phrases?/,
  // 2FA, MFA or TOTP as a word, and an authenticator's export or backup (2fa.txt, 2FA QR.png).
  /(?<![a-z0-9])(?:2fa|mfa|totp)(?![a-z0-9])|authenticator/,
  // Review round 3: a name that ends with key or keys after a space, an underscore or a dash (stripe key.txt,
  // ssh_keys.docx, wifi key.txt, an SSH Keys folder), but not a key that opens a door or explains a map or a test.
  // Each of those words must start a word: BitLocker key.txt and backdoor key.txt are refused.
  /(?<!(?<![a-z0-9])(?:answer|map|house|car|door|office|spare|room|locker))[ _-]keys?(?:\.[^/]*)?(?:\/|$)/,
  // A key backup, list, vault or ring that starts the name: key backup.txt, a Keys Backup folder, keyring.txt.
  /(?:^|\/)keys?[ _-]?(?:backups?|lists?|vaults?|rings?)(?![a-z])/,
  // creds as a word anywhere, in a file or a folder name: creds.txt, kc_creds.csv, creds/aws.txt (not credit).
  /(?<![a-z0-9])creds?(?![a-z])/,
  // privkey, priv key, rootkey (the name AWS gives a downloaded root access key).
  /(?<![a-z0-9])(?:priv|root)[ _-]?keys?(?![a-z])/,
  // A pgp, gpg or ssh private or secret file: pgp private.txt, ssh private.docx.
  /(?<![a-z0-9])(?:pgp|gpg|ssh)[ _-]?(?:private|secret)(?![a-z])/,
  // A wallet: a name that is or ends with wallet (wallet.txt, crypto wallet.txt, a Wallets folder), not wallet design.png.
  /(?<![a-z0-9])wallets?(?:\.[^/]*)?(?:\/|$)/,
  // A wallet brand anywhere, or a ledger recovery, backup, seed or words file. A ledger alone is an account book
  // (General Ledger 2026.xlsx), so it goes.
  /metamask|trezor|(?<![a-z0-9])ledger[ _-]?(?:recovery|backup|seed|words?)/,
  // Recovery words or a recovery sheet, or a file or folder named just recovery (not disaster recovery plan.pdf).
  /(?<![a-z0-9])recovery[ _-]?(?:words?|sheets?)|(?:^|\/)recovery(?:\.[^/]*)?(?:\/|$)/,
  // 12, 15, 18, 21 or 24 words: the lengths of a wallet recovery phrase.
  /(?<![a-z0-9])(?:12|15|18|21|24)[ _-]?words?(?![a-z])/,
  // A file or folder named just seeds (not sunflower seeds.jpg).
  /(?:^|\/)seeds(?:\.[^/]*)?(?:\/|$)/,
  // A cookie jar saved as text (cookies.txt, youtube-cookies.txt): every cookie in it signs in as the owner.
  /(?<![a-z0-9])cookies?\.txt$/,
  // A .env inside a longer name: prod.env.txt, app.env.csv (not envelope or my.environment).
  /(?:^|\/)[^/]+\.env(?![a-z])/,
  // Round 4: pw, pws, passcode(s), passkey(s), pass(es) or pin(s) as a whole word that ends the name (pw.txt, gmail pw.txt,
  // bank pin.txt, a Pins folder), but not a boarding pass, a day pass or a map pin; and a pw list or pin codes.
  new RegExp(String.raw`(?:(?<![a-z0-9])(?:${SHORT_PASSWORD_WORDS})|${PASS_OR_PIN})(?:\.[^/]*)?(?:\/|$)`),
  /(?<![a-z0-9])(?:pws?[ _-]?lists?|pin[ _-]?codes?)(?![a-z])/,
  // Round 4: the word password in another language, anywhere in a name (Passwort.txt, contraseñas.xlsx, senhas.csv).
  new RegExp(String.raw`(?<![a-z0-9])(?:${FOREIGN_PASSWORD_WORDS})`),
  // Round 4: a disk encryption tool anywhere in a name: its recovery key is what such a file holds.
  /bitlocker|filevault|veracrypt/,
]

export const OUTBOUND_SECRET_PATTERNS: readonly RegExp[] = Object.freeze([
  ...SECRET_PLACES,
  ...SECRET_WORDS,
])
/** The patterns read only below the home folder. */
const WORD_PATTERNS: ReadonlySet<RegExp> = new Set(SECRET_WORDS)

/** A Unicode control character: never in a file name HOAI attaches. */
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/
/** Names Windows gives to devices: `nul`, `nul.pdf` and `CON` open a device, never a file. */
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$|clock\$)$/i
/** Unix folders that hold the system's live state or its own secrets. */
const SYSTEM_ROOTS: ReadonlySet<string> = new Set(['proc', 'dev', 'sys', 'etc'])

const TYPE_LABEL: Readonly<Record<EmailFileType, string>> = {
  pdf: 'PDF', png: 'PNG', jpg: 'JPG', gif: 'GIF', webp: 'WebP', text: 'text', docx: 'Word', xlsx: 'Excel',
}
const TYPE_MIME: Readonly<Record<EmailFileType, string>> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  text: 'text/plain',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
}
const SAFE_LIST_WORDS = 'only PDF, pictures (PNG, JPG, GIF, WebP), text (TXT, CSV), Word (DOCX) and Excel (XLSX) files are'

/** What the read needs of a stat: the fields the swap check compares. */
export interface OutboundStat {
  isFile(): boolean
  size: number | bigint
  dev?: number | bigint
  ino?: number | bigint
  /** The modified, change and birth times in ns, which a stat asked for bigints gives. */
  mtimeNs?: bigint
  ctimeNs?: bigint
  birthtimeNs?: bigint
}

/** A stat as the read keeps it: the numbers and times the swap check compares as they came, the size as a number. */
interface ReadStat extends OutboundStat {
  size: number
}

/** Every stat here asks for this, so sameFileAs compares device and file numbers and the times in ns as bigint. */
const FILE_NUMBERS_AS_BIGINT = { bigint: true } as const

function readStat(stat: OutboundStat): ReadStat {
  return {
    isFile: () => stat.isFile(),
    size: Number(stat.size),
    dev: stat.dev,
    ino: stat.ino,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
    birthtimeNs: stat.birthtimeNs,
  }
}

/** What the read needs of an open file. */
export interface OutboundHandle {
  stat(options: typeof FILE_NUMBERS_AS_BIGINT): Promise<OutboundStat>
  read(buffer: Uint8Array, offset: number, length: number, position: number): Promise<{ bytesRead: number }>
  close(): Promise<void>
}

/** The file system this file uses; a test passes its own to count the calls. */
export interface OutboundFs {
  realpath(path: string): Promise<string>
  lstat(path: string, options: typeof FILE_NUMBERS_AS_BIGINT): Promise<OutboundStat>
  open(path: string, flags: 'r'): Promise<OutboundHandle>
}

export interface OutboundFileCtx {
  /** The home `~` stands for; this computer's home when left out. */
  home?: string
  /** The owner's user id, so lanePathIsSecret refuses every other person's lane. */
  actorUserId?: string
  fs?: Partial<OutboundFs>
  /** This daemon's own credentials: a text file that holds one is refused, as an email that carries one is. */
  secrets?: readonly string[]
  /**
   * Round 7: the wall clock budget, in ms, for reading a Word or Excel file's words, kept on the content Worker's own
   * clock (round 6 took an injected clock, which cannot cross into a Worker). Round 8: officeReadBudgetMs of the
   * file's size when left out (2 s plus 1 s per MB, 3 s inside the Worker deadline). Round 9: the budget of the whole
   * content stage (the read and every check), fixed when given; left out, the Worker sizes it from the larger of the
   * file's size and its words.
   */
  officeReadMs?: number
  /** Round 7: the content Worker's module; lib/email-outbound-content-worker.ts when left out (a test passes a broken one). */
  contentWorker?: URL
  /**
   * Final pre push fix: this daemon's own runtime folders wherever they were moved (server.ts OUTBOUND_RUNTIME_DIRS:
   * the resolved CLAUDE_CONFIG_DIR, the plugin state folder, BGOS_PLUGIN_STATE_DIR or ~/.bgos-plugin-state, and
   * ~/.bgos-agent). A
   * path at or below one (read lower case, with forward slashes, as the secret list reads it) is refused as a HOAI or
   * Claude folder, as ~/.claude and ~/.bgos-* are by name. A folder that is the home or holds it, the top of a drive,
   * or a relative or network value is not taken as one: it would refuse every file of the owner.
   */
  runtimeDirs?: readonly string[]
}

export interface OutboundFile {
  /** The path as the agent named it. */
  path: string
  /** The path after every link: what was read. */
  realPath: string
  /** The file's own name, which the email shows. */
  name: string
  type: EmailFileType
  mime: string
  size: number
  bytes: Uint8Array
}

export type OutboundRead = { ok: true; file: OutboundFile } | { ok: false; error: string }
export type OutboundReadAll = { ok: true; files: OutboundFile[] } | { ok: false; error: string }

/** realpath.native: it resolves every link and, on Windows, a short (8.3) name into the long one. */
function nativeRealpath(path: string): Promise<string> {
  const native = (realpathCallback as unknown as { native?: typeof realpathCallback }).native
  if (typeof native !== 'function') return realpathPromise(path)
  return new Promise((resolve, reject) => native(path, (err, real) => (err ? reject(err) : resolve(String(real)))))
}

const REAL_FS: OutboundFs = Object.freeze<OutboundFs>({
  realpath: nativeRealpath,
  lstat: (path, options) => lstatPromise(path, options),
  open: async (path, flags) => {
    const handle = await openPromise(path, flags)
    return {
      stat: (options) => handle.stat(options),
      read: (buffer, offset, length, position) => handle.read(buffer, offset, length, position),
      close: () => handle.close(),
    }
  },
})

/** The real file system, for the test that it answers with bigints when asked. */
export const OUTBOUND_REAL_FS_FOR_TESTS = REAL_FS

function fsOf(ctx: OutboundFileCtx): OutboundFs {
  return { ...REAL_FS, ...(ctx.fs ?? {}) } as OutboundFs
}

/** The path as the agent wrote it, kept to one line of a sentence. */
function shown(path: string): string {
  return path.length > 200 ? `${path.slice(0, 120)}...${path.slice(-60)}` : path
}

const megabytes = (bytes: number): number => Math.ceil(bytes / MB)

/** `~`, `~/x` and `~\x` stand for the home; nothing else is expanded. */
function expandHome(path: string, home: string): string {
  if (path === '~') return home
  if (path.startsWith('~/') || path.startsWith('~\\')) {
    // Round 8: the home's trailing slashes dropped by a backward loop, not a regex.
    let end = home.length
    while (end > 0 && (home[end - 1] === '/' || home[end - 1] === '\\')) end--
    return `${home.slice(0, end)}/${path.slice(2)}`
  }
  return path
}

/**
 * Round 8: the longest path read. Windows and Linux open nothing longer (MAX_PATH with long paths on is 32767 only
 * behind \\?\, which is refused as a device path; Linux's PATH_MAX is 4096). A longer path is refused before any
 * regular expression reads it.
 */
const PATH_MAX_CHARS = 4096

/**
 * Round 8: a segment with its trailing dots and spaces dropped (Windows opens `.ssh.` and `.ssh ` as `.ssh`), by a
 * backward loop: the regex /[. ]+$/ tried again from every dot or space of a long run that does not end the segment,
 * which is quadratic. A segment of dots and spaces only is kept as it is (`.` and `..`).
 */
function withoutTrailingDotsAndSpaces(segment: string): string {
  let end = segment.length
  while (end > 0 && (segment[end - 1] === '.' || segment[end - 1] === ' ')) end--
  return end === 0 ? segment : segment.slice(0, end)
}

/**
 * A home folder in the form the secret list reads (lower case, forward slashes, trailing dots and spaces dropped, `..`
 * resolved), or null when it is not a full local path or is the top of a drive.
 */
function homeForm(home: unknown): string | null {
  if (typeof home !== 'string' || home.trim() === '' || home.length > PATH_MAX_CHARS || /^[\\/]{2}/.test(home)) return null
  const slashed = home.replace(/\\/g, '/')
  const drive = /^[a-z]:\//i.test(slashed) ? slashed.slice(0, 2).toLowerCase() : ''
  if (!drive && !slashed.startsWith('/')) return null
  const segments: string[] = []
  for (const raw of (drive ? slashed.slice(2) : slashed).split('/')) {
    const seg = withoutTrailingDotsAndSpaces(raw)
    if (seg === '' || seg === '.') continue
    if (seg === '..') segments.pop()
    else segments.push(seg.toLowerCase())
  }
  return segments.length === 0 ? null : `${drive}/${segments.join('/')}`
}

/**
 * Round 4: the part of a path the word rules (SECRET_WORDS) read. Inside the owner's home folder (the home passed in,
 * else this daemon's os.homedir() and, on Windows, USERPROFILE), only the path below it, starting with a slash: a
 * home named C:\Users\John Key or /Users/amy.seed does not make every file in it look like a key. Outside every home,
 * the whole path, as before.
 */
function secretWordsForm(form: string, ctx: OutboundFileCtx): string {
  let below: string | null = null
  for (const home of homesOf(ctx)) {
    const h = homeForm(home)
    if (h === null || (form !== h && !form.startsWith(`${h}/`))) continue
    const rest = form.slice(h.length) || '/'
    if (below === null || rest.length < below.length) below = rest
  }
  return below ?? form
}

/** The owner's home folders: the home passed in, else this daemon's os.homedir() and, on Windows, USERPROFILE. */
function homesOf(ctx: OutboundFileCtx): unknown[] {
  return ctx.home !== undefined ? [ctx.home] : [homedir(), process.platform === 'win32' ? process.env.USERPROFILE : undefined]
}

/**
 * Final pre push fix: is this form at or below one of the daemon's own runtime folders (ctx.runtimeDirs)? Each folder
 * is read in the form the secret list reads (homeForm); one that is not a full local path, is the top of a drive, or
 * is a home folder or above one is skipped.
 */
function underRuntimeDir(form: string, ctx: OutboundFileCtx): boolean {
  const dirs = ctx.runtimeDirs
  if (!Array.isArray(dirs) || dirs.length === 0) return false
  const homes = homesOf(ctx).map(homeForm).filter((h): h is string => h !== null)
  for (const dir of dirs) {
    const d = homeForm(dir)
    if (d === null || homes.some((h) => h === d || h.startsWith(`${d}/`))) continue
    if (form === d || form.startsWith(`${d}/`)) return true
  }
  return false
}

/** realpathSync.native where the runtime has it (it reads an 8.3 short name as the long one on Windows). */
function nativeRealpathSync(path: string): string {
  const native = (realpathSync as unknown as { native?: (p: string) => string }).native
  return String(typeof native === 'function' ? native(path) : realpathSync(path))
}

/**
 * Final fix 2: the runtime folders server.ts hands every file check (OUTBOUND_RUNTIME_DIRS), each as configured and,
 * beside it, by its real path when it resolves (read at boot): a CLAUDE_CONFIG_DIR or BGOS_PLUGIN_STATE_DIR that is a
 * junction, a link or an 8.3 short spelling then also holds the files reached by the folder's real long path. A folder
 * that does not resolve keeps its configured form alone; the same spelling is listed once.
 */
export function outboundRuntimeDirs(dirs: readonly string[], real: (dir: string) => string = nativeRealpathSync): readonly string[] {
  const out: string[] = []
  const add = (dir: string) => {
    if (!out.includes(dir)) out.push(dir)
  }
  for (const dir of dirs) {
    add(dir)
    let resolved: string
    try {
      resolved = plainLocal(String(real(dir)))
    } catch {
      continue
    }
    add(resolved)
  }
  return Object.freeze(out)
}

type LexicalKind = 'secret' | 'runtime' | 'device' | 'system' | 'not_full' | 'empty' | 'control' | 'too_long'
type Lexical = { kind: LexicalKind } | { kind: 'ok'; form: string }

/** Two slashes of any kind at the start: \\host, //host, \\?\ and \\.\ (device paths), \/host. */
const NETWORK_OR_DEVICE = /^[\\/]{2}/

/**
 * Steps 1 and 2 on one spelling: no file system call. `form` is the lower
 * case, forward slash, resolved path that both secret checks read.
 */
function lexical(path: string, ctx: OutboundFileCtx): Lexical {
  // Round 8: before any regular expression reads it.
  if (path.length > PATH_MAX_CHARS) return { kind: 'too_long' }
  if (path.trim() === '') return { kind: 'empty' }
  if (CONTROL.test(path)) return { kind: 'control' }
  // `~` expands only a leading `~/` or `~\`, so a path that starts with two slashes is still one here; and a home
  // that is itself a network path is refused the same way.
  const expanded = expandHome(path, ctx.home ?? homedir())
  if (expanded.length > PATH_MAX_CHARS) return { kind: 'too_long' }
  if (NETWORK_OR_DEVICE.test(expanded)) return { kind: 'device' }
  const slashed = expanded.replace(/\\/g, '/')
  const drive = /^[a-z]:\//i.test(slashed) ? slashed.slice(0, 2).toLowerCase() : ''
  if (!drive && !slashed.startsWith('/')) return { kind: 'not_full' }
  const rest = drive ? slashed.slice(2) : slashed
  // Final fix 4: Windows' own rules, read on a path with a drive letter or on Windows; on Linux and macOS a ?, * or : and
  // a device word are ordinary parts of a name (/home/kc/Meeting 10:30.pdf, /home/kc/con.pdf).
  const windows = drive !== '' || process.platform === 'win32'
  // A wildcard or a colon after the drive (an NTFS stream such as a.pdf:hidden) names no plain file.
  if (windows && /[?*:]/.test(rest)) return { kind: 'device' }
  const segments: string[] = []
  for (const raw of rest.split('/')) {
    // Windows drops trailing dots and spaces: `.ssh.` and `.ssh ` open `.ssh`, so they are read as it (round 8: by a
    // backward loop).
    const seg = withoutTrailingDotsAndSpaces(raw)
    if (seg === '' || seg === '.') continue
    if (windows && WINDOWS_DEVICE.test(seg.split('.')[0]!.trim())) return { kind: 'device' }
    if (seg === '..') {
      // Above the top is not a full path; lanePathIsSecret reads the same climb as a secret.
      if (segments.length === 0) return { kind: 'not_full' }
      segments.pop()
      continue
    }
    segments.push(seg.toLowerCase())
  }
  if (!drive && segments.length > 0 && (SYSTEM_ROOTS.has(segments[0]!) || (segments[0] === 'private' && segments[1] === 'etc'))) {
    return { kind: 'system' }
  }
  const form = `${drive}/${segments.join('/')}`
  const words = secretWordsForm(form, ctx)
  if (OUTBOUND_SECRET_PATTERNS.some((pattern) => pattern.test(WORD_PATTERNS.has(pattern) ? words : form))) return { kind: 'secret' }
  if (lanePathIsSecret(form, { actorUserId: ctx.actorUserId ?? '' })) return { kind: 'secret' }
  // Final pre push fix: the daemon's own Claude and HOAI folders wherever they were moved (final fix 2: with a
  // sentence of their own, as these are not key files by name).
  if (underRuntimeDir(form, ctx)) return { kind: 'runtime' }
  return { kind: 'ok', form }
}

/**
 * The clause every rule 4 refusal ends with (a key, a password store, a sign in file, a private key inside a text
 * file): the agent may not get the same secret past the check another way.
 */
export const OUTBOUND_NO_WAY_AROUND = 'Do not copy, rename or retype it to send it another way; ask your owner.'

function lexicalSentence(kind: Exclude<LexicalKind, 'ok'>, path: string, followed: boolean): string {
  const name = shown(path)
  const lead = followed ? `${name} leads to` : `${name}`
  switch (kind) {
    case 'empty':
      return 'An attached file names no file, so nothing is attached.'
    case 'control':
      return 'A file path holds a control character, so it is not attached.'
    case 'too_long':
      return `${name} is too long to be a file path, so it is not attached.`
    case 'device':
      return followed
        ? `${lead} a network or device path (HOAI followed its links), so it is never attached.`
        : `${name} is a network or device path, so it is never attached.`
    case 'system':
      return followed
        ? `${lead} a system file (HOAI followed its links), so it is never attached.`
        : `${name} is a system file, so it is never attached.`
    case 'not_full':
      return `${name} is not a full path, so it is not attached; name the file from the top, like C:\\Users\\you\\Documents\\report.pdf or /home/you/report.pdf.`
    case 'secret':
      return followed
        ? `${lead} a key or password file (HOAI followed its links), so it is never attached. ${OUTBOUND_NO_WAY_AROUND}`
        : `${name} looks like a key or password file, so it is never attached. ${OUTBOUND_NO_WAY_AROUND}`
    case 'runtime':
      return followed
        ? `${lead} this agent's own Claude or HOAI folder (HOAI followed its links), so it is never attached. ${OUTBOUND_NO_WAY_AROUND}`
        : `${name} is in this agent's own Claude or HOAI folder, so it is never attached. ${OUTBOUND_NO_WAY_AROUND}`
  }
}

/**
 * Steps 1 and 2 alone, with no file system call: why this path is refused
 * before anything is read, or null. The permission relay runs it on the CLI's
 * preview so a key path never reaches a card or the floor check.
 */
export function outboundFileLexicalRefusal(path: unknown, ctx: OutboundFileCtx = {}): string | null {
  if (typeof path !== 'string') return lexicalSentence('empty', '', false)
  const seen = lexical(path, ctx)
  return seen.kind === 'ok' ? null : lexicalSentence(seen.kind, path, false)
}

/** A real path Windows hands back as \\?\C:\...: the same local file, read as C:\... (\\?\UNC\ stays a network path). */
function plainLocal(real: string): string {
  return /^\\\\\?\\[a-z]:\\/i.test(real) ? real.slice(4) : real
}

/** A share's path as realpath answers it: \\server\share... or \\?\UNC\server\share..., never a \\?\ or \\.\ device path. */
const SHARE_ANSWER = /^(?:\\\\\?\\UNC\\|[\\/]{2}(?![?.][\\/]))[^\\/]+[\\/][^\\/]+/i

/**
 * Final fix 3: a share path as the checks of steps 1 and 2 read it, for those checks only (nothing is opened by it): the
 * given drive plus the share and the folders below it. The server's name is dropped, so a NAS named keys refuses
 * nothing. An admin share is the disk it stands for (\\localhost\C$\Users\kc is C:\Users\kc), so a moved runtime folder
 * and the owner's home are found there. The word rules read the rest of any share as a place outside the home. Final
 * fix 4: a hidden share is read without its one trailing $ (\\nas\Keys$ as Keys), as the name rules end a word at a
 * slash, a dot or the end of the name; the admin share is told first, as its $ is what makes it one.
 */
function shareSide(drive: string, real: string): string {
  const head = SHARE_ANSWER.exec(real)![0]
  const share = head.slice(Math.max(head.lastIndexOf('\\'), head.lastIndexOf('/')) + 1)
  const rest = real.slice(head.length)
  if (/^[a-z]\$$/i.test(share)) return `${share[0]}:${rest}`
  return `${drive}\\${share.endsWith('$') ? share.slice(0, -1) : share}${rest}`
}

/**
 * Final fix 2: where a path really leads, read as a local path when it is on a drive the owner mapped. On Windows
 * realpath turns Z:\Contracts\offer.pdf on a mapped drive into \\server\share\Contracts\offer.pdf, which steps 1 and
 * 2 refuse as a network path. When the given path starts with a drive letter, realpath answers a share path, the drive
 * itself answers a share path (realpath of Z:\), and the answer is that share path plus exactly the given path below
 * its drive (read as steps 1 and 2 read a path, so case, slashes and dots do not count), the real path is the drive
 * letter form: the given drive plus the answer below the share, in the real spelling. Nothing new is contacted: the
 * share is the one the owner mapped, and realpath already reached it. Anything else stays the answer as it is, so a
 * link inside the share, a local folder linked to a share and a given UNC or device path stay refused. Final fix 3: the
 * drive letter form drops the part of the real path the drive stands for (Z: to \\nas\kc\.ssh reads as Z:\notes.pdf),
 * so that part is read too: when steps 1 and 2 refuse shareSide(), that form is the answer, and the caller's own check
 * refuses it as a link that leads there, at the first look and at the second.
 */
async function localReal(fs: OutboundFs, given: string, answer: string, ctx: OutboundFileCtx): Promise<string> {
  const real = plainLocal(answer)
  if (!/^[a-z]:[\\/]/i.test(given) || !SHARE_ANSWER.test(real)) return real
  let root: string
  try {
    root = plainLocal(await fs.realpath(`${given.slice(0, 2)}\\`))
  } catch {
    return real
  }
  if (!SHARE_ANSWER.test(root)) return real
  let top = root.length
  while (top > 0 && (root[top - 1] === '\\' || root[top - 1] === '/')) top--
  const below = real.slice(top)
  if (real.slice(0, top).toLowerCase() !== root.slice(0, top).toLowerCase() || !/^[\\/]/.test(below)) return real
  const mapped = `${given.slice(0, 2)}${below}`
  const a = lexical(mapped, ctx)
  const b = lexical(given, ctx)
  if (a.kind !== 'ok' || b.kind !== 'ok' || a.form !== b.form) return real
  const side = shareSide(given.slice(0, 2), real)
  return lexical(side, ctx).kind === 'ok' ? mapped : side
}


/**
 * Round 7: the hard deadline of the content stage. The content Worker is terminated this long after it is started,
 * whatever it is doing, and the file is refused with the try again words (fail closed). Round 8: the base of the
 * deadline, which grows with the file (outboundContentDeadlineMs).
 */
export const OUTBOUND_CONTENT_DEADLINE_MS = 5000
/** Round 8: what each MB of the file adds to the deadline, and the longest deadline. */
export const OUTBOUND_CONTENT_DEADLINE_PER_MB_MS = 1000
export const OUTBOUND_CONTENT_DEADLINE_MAX_MS = 40_000

/**
 * Round 8: the deadline of one file's content stage, 5 s plus 1 s per MB, at most 40 s (30 s for a 25 MB file). The
 * main thread is free while the Worker reads, so an ordinary large file (a 25 MB log under bun) is given the time its
 * checks take, and only a file the checks cannot finish in that time is refused.
 */
export function outboundContentDeadlineMs(size: number): number {
  const scaled = OUTBOUND_CONTENT_DEADLINE_MS + Math.ceil((OUTBOUND_CONTENT_DEADLINE_PER_MB_MS * Math.max(0, size)) / MB)
  return Math.min(OUTBOUND_CONTENT_DEADLINE_MAX_MS, scaled)
}

/**
 * Round 9: the hard deadline of one file's content stage, the backstop behind the Worker's own budget
 * (email-outbound-content.ts: officeReadBudgetMs of the larger of the file's size and its words, 3 s inside
 * outboundContentDeadlineMs of the same size). A text file's words are at most its bytes, so its deadline is that of
 * its size. A Word or Excel file's words can be up to OFFICE_TEXT_MAX (25 MB) whatever its size (24 KB inflated to 24 MB
 * of words), so its deadline is that of 25 MB, 30 s: the Worker's budget always ends first, and the Worker answers
 * itself instead of being replaced.
 */
export function outboundContentHardDeadlineMs(type: ContentType, size: number): number {
  return outboundContentDeadlineMs(type === 'text' ? size : Math.max(size, OFFICE_TEXT_MAX))
}

/**
 * Round 9: at most this many content Workers start in one process (per Worker module; the daemon has one, the real
 * one); past them every text, Word and Excel file is refused at once (a safety stop) and no Worker starts. Only a
 * Worker that is replaced counts after the first: an error, an exit, a bad reply, or a hard deadline the Worker's own
 * budget did not answer first. Round 11, measured under bun 1.3.9: the cap bounds how many Workers start, not the
 * memory they hold. A Worker costs about 27 MB to start, but under bun terminate() lands only when the Worker's code
 * returns to its event loop, so a Worker replaced while its code runs keeps a core busy and keeps everything it has
 * built until that code ends (round 10's tree, the reviewer's amp shape: 8 replaced Workers still kept 8 cores busy 30 s
 * after the last verdict, about 150 MB each at a 2 MB string, 1778 MB private in all; one at a 30 MB entity body about
 * 900 MB). What bounds a Worker's work and memory is the content stage's own caps and budget, read in every loop of it
 * (email-outbound-content.ts, round 11), so that the Worker answers every file itself and is never replaced.
 */
export const OUTBOUND_CONTENT_WORKERS_MAX = 8

/** Round 9: the run of a file past OUTBOUND_CONTENT_WORKERS_MAX. */
const WORKERS_SPENT = 'workers spent'
/** The run of a file still being read at its hard deadline: out of time, which says nothing about the file. */
const OUT_OF_TIME = 'out of time'

/** Round 7: the content Worker's module, beside this file (bun and node with tsx both load a .ts worker by its URL). */
const CONTENT_WORKER = new URL('./email-outbound-content-worker.ts', import.meta.url)
const VERDICT_KINDS: ReadonlySet<string> = new Set(CONTENT_VERDICT_KINDS)
/** A rule name of the secret scanner, as its reply may carry one. */
const RULE_NAME = /^[a-z0-9_]{1,64}$/

type ContentResult = { verdict: ContentVerdict; bytes: Uint8Array }

/**
 * Round 7: the content Worker's reply read strictly, or null when it does not parse (then the file is refused). Round 8:
 * it must carry the job's own id.
 */
function contentReply(message: unknown, id: number, length: number): ContentResult | null {
  if (typeof message !== 'object' || message === null) return null
  const { id: replyId, verdict, buffer, length: got } = message as Record<string, unknown>
  if (replyId !== id) return null
  if (!(buffer instanceof ArrayBuffer) || got !== length || buffer.byteLength < length) return null
  if (typeof verdict !== 'object' || verdict === null) return null
  const { kind, rule } = verdict as Record<string, unknown>
  if (typeof kind !== 'string' || !VERDICT_KINDS.has(kind)) return null
  const bytes = new Uint8Array(buffer, 0, length)
  if (kind === 'secret') return typeof rule === 'string' && RULE_NAME.test(rule) ? { verdict: { kind, rule }, bytes } : null
  return { verdict: { kind } as ContentVerdict, bytes }
}

/** Round 8: one file's content stage, waiting its turn on the long lived Worker. */
interface ContentJob {
  id: number
  owned: ArrayBuffer
  length: number
  message: Record<string, unknown>
  deadlineMs: number
  resolve: (value: ContentResult | null | typeof WORKERS_SPENT | typeof OUT_OF_TIME) => void
}

/**
 * Round 8: ONE long lived content Worker (per Worker module), reused for every file, one job at a time from a queue,
 * each job with its own id. Under bun a Worker's memory is not given back when it ends (round 9, measured with
 * realrep.mjs: about 27 MB for each of this Worker's starts, 133 to 2875 MB over 100; round 8 said 3 MB, about what a
 * Worker that loads nothing costs), so a Worker per file grew the daemon by that much per file. The Worker is replaced
 * only after a hard deadline, an error, an exit, a message error or a reply that does not parse (a wrong id, a kind not
 * on the list, the wrong bytes). Each of those refuses the job it happened to, exactly as one Worker per file did, and
 * the next job gets a fresh Worker. Round 9: a slow file is answered by the Worker's own budget instead, so no input
 * the checks read forces a new Worker; and past OUTBOUND_CONTENT_WORKERS_MAX Workers started, no new one starts and
 * every job is refused (WORKERS_SPENT). The Worker is unref'd, so it never keeps the daemon alive; a job waiting on it
 * is held by its own deadline timer.
 */
class ContentWorkerHost {
  private worker: Worker | null = null
  private current: { job: ContentJob; timer: ReturnType<typeof setTimeout> } | null = null
  private readonly queue: ContentJob[] = []
  private nextId = 1

  constructor(private readonly url: URL) {}

  /** Round 8: how many Workers this host has started (a test reads it: one for many files). */
  started = 0

  run(owned: ArrayBuffer, length: number, message: Record<string, unknown>, deadlineMs: number): Promise<ContentResult | null | typeof WORKERS_SPENT | typeof OUT_OF_TIME> {
    return new Promise((resolve) => {
      const id = this.nextId++
      this.queue.push({ id, owned, length, message: { ...message, id, buffer: owned, length }, deadlineMs, resolve })
      this.pump()
    })
  }

  /** The Worker, started when there is none; null when it cannot start; WORKERS_SPENT past the cap (round 9). */
  private ensure(): Worker | null | typeof WORKERS_SPENT {
    if (this.worker !== null) return this.worker
    if (this.started >= OUTBOUND_CONTENT_WORKERS_MAX) return WORKERS_SPENT
    let worker: Worker
    try {
      // Under node its stdout and stderr are its own streams (never the daemon's), left unread: a stream being read
      // keeps the process alive whatever unref says, and the Worker writes nothing to them (below). Bun ignores the
      // option and hands a Worker the daemon's own stdout (the MCP channel), so the Worker module silences every
      // console method and stdout and stderr write itself, before anything else of it runs
      // (lib/email-outbound-content-quiet.ts).
      worker = new Worker(this.url, { stdout: true, stderr: true })
    } catch {
      return null
    }
    this.started++
    this.worker = worker
    // Events of a Worker already replaced are ignored: only the current one's count.
    worker.on('message', (message: unknown) => {
      if (worker === this.worker) this.onMessage(message)
    })
    const failed = () => {
      if (worker === this.worker) this.fail()
    }
    worker.on('error', failed)
    worker.on('messageerror', failed)
    worker.on('exit', failed)
    // After the listeners: under node a 'message' listener added later refs the Worker again.
    worker.unref()
    return worker
  }

  /** The next job, when none is running. */
  private pump(): void {
    while (this.current === null && this.queue.length > 0) {
      const job = this.queue.shift()!
      const worker = this.ensure()
      if (worker === null || worker === WORKERS_SPENT) {
        job.resolve(worker)
        continue
      }
      const timer = setTimeout(() => this.fail(OUT_OF_TIME), job.deadlineMs)
      this.current = { job, timer }
      try {
        worker.postMessage(job.message, [job.owned])
      } catch {
        this.fail()
      }
    }
  }

  /** The running job's reply: its result, or (a reply that does not parse, or none expected) the Worker replaced. */
  private onMessage(message: unknown): void {
    const current = this.current
    if (current === null) {
      // A message no job asked for: the Worker is not trusted with the next file.
      this.retire()
      return
    }
    const result = contentReply(message, current.job.id, current.job.length)
    if (result === null) {
      this.fail()
      return
    }
    clearTimeout(current.timer)
    this.current = null
    current.job.resolve(result)
    this.pump()
  }

  /** Past the deadline, an error, an exit or a bad reply: the running job is refused and the Worker replaced. */
  private fail(outcome: null | typeof OUT_OF_TIME = null): void {
    this.retire()
    const current = this.current
    if (current !== null) {
      clearTimeout(current.timer)
      this.current = null
      current.job.resolve(outcome)
    }
    this.pump()
  }

  /** The Worker terminated and forgotten; the next job starts a new one. */
  private retire(): void {
    const worker = this.worker
    if (worker === null) return
    this.worker = null
    worker.terminate().catch(() => {})
  }
}

/** Round 8: the long lived host of each Worker module (the real one, or a broken one a test passes). */
const CONTENT_HOSTS = new Map<string, ContentWorkerHost>()

function contentHost(url: URL): ContentWorkerHost {
  let host = CONTENT_HOSTS.get(url.href)
  if (host === undefined) {
    host = new ContentWorkerHost(url)
    CONTENT_HOSTS.set(url.href, host)
  }
  return host
}

/** Round 8: how many content Workers have been started for this module (the real one when left out), for a test. */
export function outboundContentWorkersStarted(url: URL = CONTENT_WORKER): number {
  return CONTENT_HOSTS.get(url.href)?.started ?? 0
}

/**
 * Round 7: the content stage of one file, in a worker thread the main thread never waits on: the bytes are transferred
 * to it (`owned` is the file's own buffer, read by this file, so nothing else holds it), and its verdict comes back with
 * the bytes. Null (refused) when it cannot start, errs, exits, or replies with anything that does not parse. OUT_OF_TIME
 * (refused) when it is still running at the deadline: then it is terminated. Round 8: on the one long lived Worker
 * (ContentWorkerHost), under a deadline that grows with the file (outboundContentDeadlineMs).
 */
function contentInWorker(owned: ArrayBuffer, length: number, type: ContentType, name: string, ctx: OutboundFileCtx): Promise<ContentResult | null | typeof WORKERS_SPENT | typeof OUT_OF_TIME> {
  const secrets = (ctx.secrets ?? []).filter((secret): secret is string => typeof secret === 'string')
  // Round 9: the backstop, after the Worker's own budget (which the Worker sizes from the file and its words, or a
  // test fixes with ctx.officeReadMs).
  const message: Record<string, unknown> = { type, name, secrets }
  let deadlineMs = outboundContentHardDeadlineMs(type, length)
  if (typeof ctx.officeReadMs === 'number') {
    message.budgetMs = ctx.officeReadMs
    // A fixed budget keeps the rule that the hard deadline ends 3 s after the Worker's own budget.
    deadlineMs = Math.max(deadlineMs, ctx.officeReadMs + 3000)
  }
  return contentHost(ctx.contentWorker ?? CONTENT_WORKER).run(owned, length, message, deadlineMs)
}

/**
 * Round 9: what a file past OUTBOUND_CONTENT_WORKERS_MAX is told. Round 10: one sentence, with no "never" (a restart
 * lets the file go), saying that nothing was found in it.
 */
const outboundSafetyStop = (path: string): string =>
  `${shown(path)} is not attached for now: too many files could not be checked since this agent started, so no text, Word or Excel file is attached until the agent is restarted (a safety stop; nothing was found in this file).`

/**
 * The file's check ran out of time, by the Worker's budget or the hard deadline. Still refused, with no "never": it may
 * go on another try, when it is checked to the end. It says nothing about what the check looks for.
 */
const outboundOutOfTime = (path: string): string =>
  `${shown(path)} took too long to check, so it is not attached this time. Try again in a few minutes.`

/** Round 7: the sentence for what the content stage found, or null when the file may go. */
function contentSentence(verdict: ContentVerdict, path: string): string | null {
  const name = shown(path)
  switch (verdict.kind) {
    case 'ok':
      return null
    case 'unsafe':
      return `${name} could not be read safely, so it is never attached.`
    case 'over_budget':
      return outboundOutOfTime(path)
    case 'unread':
      return `${name} could not be read to check it for a password or key, so it is not attached.`
    case 'table':
      return `${name} has a password column, so it looks like a password export and is never attached. ${OUTBOUND_NO_WAY_AROUND}`
    case 'private_key':
      return `${name} holds a private key, so it is never attached. ${OUTBOUND_NO_WAY_AROUND}`
    case 'cookie':
      return `${name} is a browser cookie file, which signs in as you, so it is never attached. ${OUTBOUND_NO_WAY_AROUND}`
    case 'own_credential':
      return `${name} holds this agent's own credential, so it is never attached. ${OUTBOUND_NO_WAY_AROUND}`
    case 'recovery_key':
      return `${name} holds a recovery key, so it is never attached. ${OUTBOUND_NO_WAY_AROUND}`
    case 'recovery_phrase':
      return `${name} holds a wallet recovery phrase, so it is never attached. ${OUTBOUND_NO_WAY_AROUND}`
    case 'secret':
      return `${name} holds a secret (it looks like ${verdict.rule}), so it is never attached. ${OUTBOUND_NO_WAY_AROUND}`
    case 'written':
      return `${name} has a password or key written in it, so it is never attached. ${OUTBOUND_NO_WAY_AROUND}`
  }
}

function baseName(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/')
  return parts[parts.length - 1] ?? ''
}

/** A number the system gave (a device or file number, a birth time): one left out, or a zero, is unknown. */
const known = (v: unknown): boolean => v !== undefined && v !== null && String(v) !== '0'

/** A time the system gave: one left out is unknown (a zero is a time, the start of 1970). */
const givenTime = (v: unknown): boolean => v !== undefined && v !== null

/** Both sides gave the value and it is the same; an unknown value is never a match. */
const bothSame = (given: (v: unknown) => boolean, x: unknown, y: unknown): boolean => given(x) && given(y) && String(x) === String(y)

/**
 * The same file. A device or file number that both sides gave and that differs means another file. With both numbers
 * known on both sides and equal, it is the same file. Otherwise at least one number is unknown, and the size, the
 * modified time and the change time in ns must all be given and equal, and the birth time too where both sides give
 * one (Linux gives a zero when it has none). Reading a file changes none of these, so an unchanged file on a drive
 * that reports no file number still goes; the access time is not compared, as reading changes it.
 */
function sameFileAs(a: ReadStat, b: ReadStat): boolean {
  for (const key of ['dev', 'ino'] as const) {
    if (known(a[key]) && known(b[key]) && String(a[key]) !== String(b[key])) return false
  }
  if (bothSame(known, a.dev, b.dev) && bothSame(known, a.ino, b.ino)) return true
  if (a.size !== b.size) return false
  if (!bothSame(givenTime, a.mtimeNs, b.mtimeNs) || !bothSame(givenTime, a.ctimeNs, b.ctimeNs)) return false
  return !(known(a.birthtimeNs) && known(b.birthtimeNs)) || String(a.birthtimeNs) === String(b.birthtimeNs)
}

/**
 * Final pre push fix: after the open, the path the agent gave is resolved AGAIN and must still pass steps 1 and 2 and
 * name the very file the handle holds. A parent folder swapped for a junction after the first realpath leads both the
 * lstat and the open into the new place, so the handle check agrees with itself; this second look does not.
 */
async function stillLeadsTo(fs: OutboundFs, path: string, ctx: OutboundFileCtx, opened: ReadStat, realCtx: OutboundFileCtx): Promise<boolean> {
  let again: string
  try {
    const given = expandHome(path, ctx.home ?? homedir())
    again = await localReal(fs, given, await fs.realpath(given), ctx)
  } catch {
    return false
  }
  if (lexical(again, realCtx).kind !== 'ok') return false
  let seen: ReadStat
  try {
    seen = readStat(await fs.lstat(again, FILE_NUMBERS_AS_BIGINT))
  } catch {
    return false
  }
  return seen.isFile() && sameFileAs(seen, opened)
}

/**
 * A Windows home can contain an 8.3 name or a junction that realpath expands. Resolve the home only after the given
 * file passed the lexical checks, and only when that file started below it but its real path no longer does. The
 * real home must still contain the real file: a link outside the home gets no exemption from the word rules.
 */
async function resolvedHomeCtx(fs: OutboundFs, givenForm: string, real: string, ctx: OutboundFileCtx): Promise<OutboundFileCtx> {
  const form = homeForm(real)
  if (form === null) return ctx
  for (const home of homesOf(ctx)) {
    const h = homeForm(home)
    if (h === null || !givenForm.startsWith(`${h}/`) || form.startsWith(`${h}/`)) continue
    try {
      const resolved = plainLocal(await fs.realpath(home as string))
      const resolvedForm = homeForm(resolved)
      if (resolvedForm !== null && form.startsWith(`${resolvedForm}/`)) return { ...ctx, home: resolved }
    } catch {
      // An unreadable home changes no rule: the real file is checked against the original context.
    }
  }
  return ctx
}

/** One file, all four steps: the file with its bytes, or the one sentence that says why not. */
export async function readOutboundFile(path: unknown, ctx: OutboundFileCtx = {}): Promise<OutboundRead> {
  if (typeof path !== 'string') return { ok: false, error: lexicalSentence('empty', '', false) }
  // Steps 1 and 2: nothing below runs for a refused spelling.
  const given = lexical(path, ctx)
  if (given.kind !== 'ok') return { ok: false, error: lexicalSentence(given.kind, path, false) }
  const fs = fsOf(ctx)
  // The type is read off the name the agent gave; the name shown is the real file's (below).
  const givenName = baseName(path)
  const notFound = `${shown(path)} could not be found or read, so it is not attached.`
  // Step 3: every link resolved, then steps 1 and 2 again on where it really is.
  let real: string
  try {
    const expanded = expandHome(path, ctx.home ?? homedir())
    real = await localReal(fs, expanded, await fs.realpath(expanded), ctx)
  } catch {
    return { ok: false, error: notFound }
  }
  const realCtx = await resolvedHomeCtx(fs, given.form, real, ctx)
  const resolved = lexical(real, realCtx)
  if (resolved.kind !== 'ok') return { ok: false, error: lexicalSentence(resolved.kind, path, true) }
  // Final pre push fix: the name the owner's card and the recipient show is the name of the file really read (a link
  // named invoice.pdf to passport.pdf shows passport.pdf; a short 8.3 or other cased spelling shows the real name).
  const name = baseName(real)
  // Step 4: a regular file, its size, its type by name and then by its bytes.
  let stat: ReadStat
  try {
    stat = readStat(await fs.lstat(real, FILE_NUMBERS_AS_BIGINT))
  } catch {
    return { ok: false, error: notFound }
  }
  if (!stat.isFile()) return { ok: false, error: `${shown(path)} is not a regular file, so it is not attached.` }
  const tooBig = (size: number) =>
    `${shown(path)} is ${megabytes(size)} MB; one email can carry at most ${AGENT_EMAIL_OUTBOUND_MAX_BYTES / MB} MB of files, so it is not attached.`
  if (stat.size > AGENT_EMAIL_OUTBOUND_MAX_BYTES) return { ok: false, error: tooBig(stat.size) }
  if (stat.size === 0) return { ok: false, error: `${shown(path)} is empty, so it is not attached.` }
  const ext = /\.([^./\\]+)$/.exec(givenName)?.[1]?.toLowerCase() ?? ''
  const type = Object.hasOwn(TYPE_OF_EXTENSION, ext) ? TYPE_OF_EXTENSION[ext]! : null
  if (type === null) return { ok: false, error: `${shown(path)} is not a type that can be attached; ${SAFE_LIST_WORDS}.` }
  // Round 5: the type is the link's name, so the real file's own name must say the same type (a notes.txt link to
  // x.conf is a .conf file, whatever the link is called).
  const realExt = /\.([^./\\]+)$/.exec(name)?.[1]?.toLowerCase() ?? ''
  if (!Object.hasOwn(TYPE_OF_EXTENSION, realExt) || TYPE_OF_EXTENSION[realExt] !== type) {
    return { ok: false, error: `${shown(path)} is a link to a file that cannot be attached; ${SAFE_LIST_WORDS}.` }
  }
  let bytes: Uint8Array
  let handle: OutboundHandle
  try {
    handle = await fs.open(real, 'r')
  } catch {
    return { ok: false, error: notFound }
  }
  try {
    // The handle must be the file just checked: a swap between the stat and the open is refused.
    const opened = readStat(await handle.stat(FILE_NUMBERS_AS_BIGINT))
    const changed = `${shown(path)} changed while HOAI read it, so it is not attached.`
    // Compared by device and file number where the system gives both (a zero is none), else by size and times (sameFileAs).
    const sameFile = sameFileAs(stat, opened)
    if (!opened.isFile() || !sameFile) {
      return { ok: false, error: changed }
    }
    // Final pre push fix: and the path, resolved again, still leads to this very file through no refused place.
    if (!(await stillLeadsTo(fs, path, ctx, opened, realCtx))) return { ok: false, error: changed }
    if (opened.size > AGENT_EMAIL_OUTBOUND_MAX_BYTES) return { ok: false, error: tooBig(opened.size) }
    // One byte past the cap, so a file that grew after the stat is caught too.
    const buffer = new Uint8Array(Math.min(opened.size, AGENT_EMAIL_OUTBOUND_MAX_BYTES) + 1)
    let read = 0
    while (read < buffer.length) {
      const { bytesRead } = await handle.read(buffer, read, buffer.length - read, read)
      if (bytesRead === 0) break
      read += bytesRead
    }
    if (read > AGENT_EMAIL_OUTBOUND_MAX_BYTES) return { ok: false, error: tooBig(read) }
    if (read === 0) return { ok: false, error: `${shown(path)} is empty, so it is not attached.` }
    bytes = buffer.subarray(0, read)
  } catch {
    return { ok: false, error: notFound }
  } finally {
    await handle.close().catch(() => {})
  }
  if (!isType(bytes, type)) {
    return { ok: false, error: `${shown(path)} is not really a ${TYPE_LABEL[type]} file (its contents say otherwise), so it is not attached.` }
  }
  // Round 7: the content stage (a text file's header and whole text, a Word or Excel file's rows and words, and every
  // check on them) runs in the content Worker under a hard deadline; the steps above stay on this thread. A picture
  // or a PDF has no words read here.
  if (type === 'text' || type === 'docx' || type === 'xlsx') {
    // `bytes` is a view, at offset 0, of the buffer allocated above for this read alone: it is transferred, not copied.
    const checked = await contentInWorker(bytes.buffer as ArrayBuffer, bytes.length, type, name, ctx)
    if (checked === WORKERS_SPENT) return { ok: false, error: outboundSafetyStop(path) }
    if (checked === OUT_OF_TIME) return { ok: false, error: outboundOutOfTime(path) }
    if (checked === null) return { ok: false, error: `${shown(path)} could not be read safely, so it is never attached.` }
    bytes = checked.bytes
    const why = contentSentence(checked.verdict, path)
    if (why !== null) return { ok: false, error: why }
  }
  return { ok: true, file: { path, realPath: real, name, type, mime: TYPE_MIME[type], size: bytes.length, bytes } }
}

/** Why this one file is never attached (rule 4, rule 3's local half), or null when it may go. */
export async function outboundFileRefusal(path: unknown, ctx: OutboundFileCtx = {}): Promise<string | null> {
  const read = await readOutboundFile(path, ctx)
  return read.ok ? null : read.error
}

/** Every file of one email: the count first (no file system call), then each file, no file twice, and the total. */
export async function readOutboundFiles(paths: readonly unknown[], ctx: OutboundFileCtx = {}): Promise<OutboundReadAll> {
  if (!Array.isArray(paths) || paths.length === 0) return { ok: false, error: 'An email with files names at least one file.' }
  if (paths.length > AGENT_EMAIL_OUTBOUND_MAX_FILES) {
    return { ok: false, error: `At most ${AGENT_EMAIL_OUTBOUND_MAX_FILES} files can go with one email; this one names ${paths.length}.` }
  }
  // Every spelling is checked before the first file is touched.
  for (const path of paths) {
    const why = outboundFileLexicalRefusal(path, ctx)
    if (why) return { ok: false, error: why }
  }
  const files: OutboundFile[] = []
  const seen = new Set<string>()
  let total = 0
  for (const path of paths) {
    const read = await readOutboundFile(path, ctx)
    if (!read.ok) return read
    const key = /^[a-z]:[\\/]/i.test(read.file.realPath) ? read.file.realPath.toLowerCase() : read.file.realPath
    if (seen.has(key)) return { ok: false, error: `${shown(read.file.path)} is named twice; each file goes with an email once.` }
    seen.add(key)
    total += read.file.size
    if (total > AGENT_EMAIL_OUTBOUND_MAX_BYTES) {
      return { ok: false, error: `These files come to ${megabytes(total)} MB together; one email can carry at most ${AGENT_EMAIL_OUTBOUND_MAX_BYTES / MB} MB of files.` }
    }
    files.push(read.file)
  }
  return { ok: true, files }
}

// ── no path leaves the machine in a floor check or a card (G9) ───────────────

/** email_send and email_draft under any install prefix, or bare. */
const EMAIL_TOOL_NAME = /^(?:mcp__(?:.*_)?bgos__)?email_(?:send|draft)$/

/** A `"path": "..."` value, closed or cut off at the end of the preview. */
const PATH_VALUE = /("path"\s*:\s*)"(?:[^"\\]|\\.)*(?:"|$)/g
/** The `"files":` key itself, never the word inside an escaped string. */
const FILES_KEY = /(^|[^\\])"files"\s*:/

/**
 * The CLI's preview of an email tool call with every file path taken out:
 * `files` becomes a count ("2 files"). Sent to the floor check, written on a
 * card and its push in place of the preview. A preview the CLI cut in the
 * middle (a long value keeps its head and tail with a line break between) is
 * read the way the email card reads it (parsePreviewObject), so the list is
 * replaced whatever shape its entries take. A preview that still does not
 * read keeps only what comes before its `files` key: every later byte may be
 * a path. Any other tool, or an email with no files, is returned exactly as
 * it was.
 */
export function hideEmailFilePaths(toolName: string, inputPreview: string): string
export function hideEmailFilePaths(toolName: string, inputPreview: string | undefined): string | undefined
export function hideEmailFilePaths(toolName: string, inputPreview: string | undefined): string | undefined {
  if (typeof inputPreview !== 'string' || !EMAIL_TOOL_NAME.test(String(toolName ?? ''))) return inputPreview
  if (!/"files"/.test(inputPreview)) return inputPreview
  const record = parsePreviewObject(inputPreview)
  if (record) {
    if (!Object.hasOwn(record, 'files')) return inputPreview
    return JSON.stringify({ ...record, files: emailFilesCountWords(record.files) })
  }
  const key = FILES_KEY.exec(inputPreview)
  const head = key ? inputPreview.slice(0, key.index + key[1]!.length) : inputPreview
  const kept = head.replace(PATH_VALUE, '$1"(a file path, hidden)"')
  return key ? `${kept}"files": "(file paths hidden)"}` : kept
}

/** "1 file", "2 files": how many files a call names, in words. */
export function emailFilesCountWords(files: unknown): string {
  const n = Array.isArray(files) ? files.length : 1
  return `${n} file${n === 1 ? '' : 's'}`
}
