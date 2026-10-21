import { spawn } from 'node:child_process'
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto'
import { accessSync, constants } from 'node:fs'

// Privileged host only. The caller persists only the returned encrypted record.
// A configured Secret Service (Linux) or the login Keychain (macOS) protects its
// wrapping key. This cannot attest the keyring's disk encryption or protect
// against its administrator or same user.
// API references: freedesktop Secret Service ReadAlias/Collection.Locked;
// GNOME libsecret secret-tool store reads piped stdin, never a secret argv;
// security(1) -i reads its add-generic-password line from piped stdin;
// SecKeychainSetUserInteractionAllowed and SecKeychainGetStatus.
const LIMIT = 8192
const EXTRAS_LIMIT = 16 * 1024 * 1024
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/
const HASH = /^[a-f0-9]{64}$/
const BINDING = ['profileId', 'actingUserId', 'assistantId', 'endpointId', 'keyFingerprint', 'grantVersion', 'keyEpoch', 'backgroundUse']
const SERVICE = 'org.freedesktop.secrets'
const INTERFACE = 'org.freedesktop.Secret'
const ROOT = '/org/freedesktop/secrets'
const PREFIX = ['call', '--session', '--dest', SERVICE, '--object-path']
const LIBSECRET = 'libsecret-v1', KEYCHAIN = 'macos-keychain-v1', SECURITY = '/usr/bin/security', OSASCRIPT = '/usr/bin/osascript'
const ITEMS = { endpoint: ['hoai-browser-profile-sync-v1', 'HOAI browser endpoint key'], extras: ['hoai-browser-portable-extras-v1', 'HOAI browser portable extras'] }
// Absolute and normalized, with nothing to quote inside one `security -i` line.
const KEYCHAIN_PATH = /^(?:\/[A-Za-z0-9_@+-][A-Za-z0-9._@+-]*)+\.keychain(?:-db)?$/
// No HOME: security then reads the account's own home, so a caller cannot point
// it at another login keychain. No loader, token, display or bus either.
const KEYCHAIN_ENVIRONMENT = Object.freeze({ PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' })
// Status only, with user interaction disabled first. SecKeychainGetStatus never
// asks for the password, whereas security's own item commands on a locked
// keychain raise an unlock dialog that stays on screen after the helper is killed.
const KEYCHAIN_STATUS = "ObjC.import('Security'); function run(argv) { if (argv.length !== 1 || $.SecKeychainSetUserInteractionAllowed(false) !== 0) return 'error'; " +
  "const keychain = Ref(), status = Ref(); if ($.SecKeychainOpen(argv[0], keychain) !== 0) return 'error'; const result = $.SecKeychainGetStatus(keychain[0], status); " +
  "if (result === -25294) return 'absent'; if (result !== 0) return 'error'; return (status[0] & 1) === 1 ? 'unlocked' : 'locked' }"
const fail = code => Object.assign(new Error(code), { code })
const helperPresent = path => { try { accessSync(path, constants.X_OK); return true } catch { return false } }
function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw fail('profile_key_refused')
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Reflect.ownKeys(descriptors).length !== keys.length || keys.some(key => !Object.hasOwn(descriptors, key) || !Object.hasOwn(descriptors[key], 'value') || !descriptors[key].enumerable)) throw fail('profile_key_refused')
}
function bindingOf(value) {
  exact(value, BINDING)
  if (typeof value.profileId !== 'string' || !UUID.test(value.profileId) || typeof value.endpointId !== 'string' || !UUID.test(value.endpointId) || typeof value.actingUserId !== 'string' || !ID.test(value.actingUserId) ||
      !['assistantId', 'grantVersion', 'keyEpoch'].every(key => Number.isSafeInteger(value[key]) && value[key] > 0) || typeof value.keyFingerprint !== 'string' || !HASH.test(value.keyFingerprint)) throw fail('profile_key_refused')
  if (value.backgroundUse !== true) throw fail('profile_key_background_grant_required')
  return Object.freeze(Object.fromEntries(BINDING.map(key => [key, value[key]])))
}
const scopeOf = binding => createHash('sha256').update(JSON.stringify(binding)).digest('hex')

// Do not merge this result into the host or Chromium environment. This Unix
// bus is a private key-service capability. No PATH, loader, SSH, token, display
// or caller supplied command options are inherited by these fixed helpers.
export function keyHelperEnvironment(environment = {}) {
  const address = environment.DBUS_SESSION_BUS_ADDRESS
  if (typeof address !== 'string' || address.length > 2048 || !/^unix:(?:path|abstract)=[A-Za-z0-9_./%+-]+(?:,guid=[a-fA-F0-9]{32})?$/.test(address)) throw fail('profile_key_setup_required')
  return Object.freeze({ PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', DBUS_SESSION_BUS_ADDRESS: address })
}

// Bounded asynchronous subprocesses. Neither helper output nor native error
// text escapes this module. In particular secret-tool lookup and security
// find-generic-password stdout is secret data.
/**
 * @param {string} executable
 * @param {string[]} args
 * @param {{environment?:Record<string,string>,input?:Buffer,timeoutMs?:number,maxBytes?:number,signal?:AbortSignal}} [options]
 * @returns {Promise<{code:number|null,output:Buffer}>}
 */
export function runKeyHelper(executable, args, { environment, input = Buffer.alloc(0), timeoutMs = 3000, maxBytes = LIMIT, signal } = {}) {
  return new Promise((resolve, reject) => {
    let child, timer, settled = false, outcome = null, size = 0
    const chunks = []
    const discard = () => { for (const chunk of chunks.splice(0)) chunk.fill(0) }
    const finish = (error, result) => {
      if (settled) return
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', cancel)
      if (error) { discard(); reject(error) } else resolve(result)
    }
    const stop = code => {
      if (settled || outcome) return
      outcome = fail(code); clearTimeout(timer); signal?.removeEventListener('abort', cancel); discard()
      // A stop request is not physical completion. Keep this same promise
      // pending until the original ChildProcess and its pipes close.
      try { if (Number.isSafeInteger(child?.pid) && child.pid > 0) child.kill('SIGKILL') } catch {}
    }
    const cancel = () => stop('profile_key_context_changed')
    if (signal?.aborted) return finish(fail('profile_key_context_changed'))
    try { child = spawn(executable, args, { shell: false, env: environment, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }) }
    catch { return finish(fail('profile_key_setup_required')) }
    child.once('error', () => stop('profile_key_setup_required'))
    child.once('close', code => {
      if (settled) { discard(); return }
      if (outcome) { finish(outcome); return }
      const output = Buffer.concat(chunks)
      discard(); finish(null, { code, output })
    })
    if (!child.stdout?.on || !child.stderr?.on || !child.stdin?.on || !child.stdin?.end) {
      stop('profile_key_setup_required'); return
    }
    child.stdout.on('data', chunk => {
      if (settled || outcome) { chunk.fill(0); return }
      size += chunk.length
      if (size > maxBytes) { chunk.fill(0); stop('profile_key_refused'); return }
      chunks.push(chunk)
    })
    child.stderr.on('data', chunk => chunk.fill(0))
    child.stdin.on('error', () => {})
    signal?.addEventListener('abort', cancel, { once: true })
    timer = setTimeout(() => stop('profile_key_unlock_required'), timeoutMs)
    if (signal?.aborted) cancel()
    try { child.stdin.end(outcome ? undefined : input) } catch { stop('profile_key_setup_required') }
  })
}

function cipherAdapter(key, binding, recordId, { extras = false, backend = 'gnome_libsecret' } = {}) {
  const limit = extras ? EXTRAS_LIMIT : LIMIT
  const aad = Buffer.from(`${extras ? 'HOAI-PORTABLE-EXTRAS-v1' : 'HOAI-PROFILE-KEY-v1'}\0${JSON.stringify(binding)}\0${recordId}`)
  return {
    isEncryptionAvailable: () => true,
    // Adapter tag for the verified OS key store path, not Electron availability.
    getSelectedStorageBackend: () => backend,
    encryptString(text) {
      if (extras && (typeof text !== 'string' || Buffer.byteLength(text) > limit)) throw fail('profile_key_refused')
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv)
      cipher.setAAD(aad)
      return Buffer.concat([iv, cipher.update(text, 'utf8'), cipher.final(), cipher.getAuthTag()])
    },
    decryptString(bytes) {
      if (!Buffer.isBuffer(bytes) || bytes.length < 28 || bytes.length > limit + (extras ? 28 : 0)) throw fail('profile_key_refused')
      const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12))
      cipher.setAAD(aad); cipher.setAuthTag(bytes.subarray(-16))
      let update, final, plaintext
      try {
        update = cipher.update(bytes.subarray(12, -16)); final = cipher.final()
        plaintext = Buffer.concat([update, final])
        return plaintext.toString('utf8')
      } finally { update?.fill(0); final?.fill(0); plaintext?.fill(0) }
    },
  }
}

export class BrowserProfileSyncKeyStore {
  // keychain: an explicit Keychain file for tests; by default the login keychain.
  constructor({ endpointCrypto, environment = {}, platform = process.platform, run = runKeyHelper, hasHelper = helperPresent, timeoutMs = 3000, keychain = /** @type {string | undefined} */ (undefined) }) {
    if (!endpointCrypto || ['identityFingerprint', 'protectEndpointKeys', 'restoreEndpointKeys'].some(name => typeof endpointCrypto[name] !== 'function') || typeof run !== 'function' || typeof hasHelper !== 'function' ||
        keychain !== undefined && (typeof keychain !== 'string' || keychain.length > 1024 || !KEYCHAIN_PATH.test(keychain))) throw new TypeError('profile_key_dependencies_required')
    Object.assign(this, { endpointCrypto, platform, run, hasHelper, keychain, provider: platform === 'darwin' ? KEYCHAIN : LIBSECRET })
    this.environment = Object.freeze({ DBUS_SESSION_BUS_ADDRESS: environment.DBUS_SESSION_BUS_ADDRESS })
    this.timeoutMs = Math.max(1, Math.min(10000, timeoutMs))
  }
  async _authority(assertCurrent) {
    if (typeof assertCurrent !== 'function') throw fail('profile_key_context_changed')
    try { if (await assertCurrent() === false) throw fail('profile_key_context_changed') } catch { throw fail('profile_key_context_changed') }
  }
  _environment() { return this.provider === KEYCHAIN ? KEYCHAIN_ENVIRONMENT : keyHelperEnvironment(this.environment) }
  get _platform() { return this.provider === KEYCHAIN ? 'darwin' : 'linux' }
  _adapter(key, binding, recordId, extras = false) { return cipherAdapter(key, binding, recordId, { extras, backend: this.provider === KEYCHAIN ? 'macos_keychain' : 'gnome_libsecret' }) }
  async _call(executable, args, assertCurrent, input = Buffer.alloc(0), signal) {
    await this._authority(assertCurrent)
    let result
    try { result = await this.run(executable, args, { environment: this._environment(), input, timeoutMs: this.timeoutMs, maxBytes: LIMIT, signal }) }
    catch (error) { throw fail(['profile_key_setup_required', 'profile_key_unlock_required', 'profile_key_context_changed', 'profile_key_refused'].includes(error.code) ? error.code : 'profile_key_setup_required') }
    if (!result || !Buffer.isBuffer(result.output) || result.output.length > LIMIT || !(result.code === null || Number.isInteger(result.code))) { result?.output?.fill?.(0); throw fail('profile_key_refused') }
    try { await this._authority(assertCurrent); return result } catch (error) { result?.output?.fill(0); throw error }
  }
  async _ready(assertCurrent, signal) {
    if (this.platform === 'darwin') return this._keychainReady(assertCurrent, signal)
    if (this.platform !== 'linux') throw fail('profile_key_manual_unlock_required')
    if (!this.hasHelper('/usr/bin/gdbus') || !this.hasHelper('/usr/bin/secret-tool')) throw fail('profile_key_setup_required')
    const alias = await this._call('/usr/bin/gdbus', [...PREFIX, ROOT, '--method', `${INTERFACE}.Service.ReadAlias`, 'default'], assertCurrent, undefined, signal)
    let collection
    try {
      if (alias.code !== 0) throw fail('profile_key_setup_required')
      const match = /^\(objectpath '(\/org\/freedesktop\/secrets\/collection\/[A-Za-z0-9_]+)',\)\s*$/.exec(alias.output.toString('utf8'))
      if (!match || match[1] === `${ROOT}/collection/session`) throw fail('profile_key_setup_required')
      collection = match[1]
    } finally { alias.output.fill(0) }
    const locked = await this._call('/usr/bin/gdbus', [...PREFIX, collection, '--method', 'org.freedesktop.DBus.Properties.Get', `${INTERFACE}.Collection`, 'Locked'], assertCurrent, undefined, signal)
    try {
      if (locked.code !== 0) throw fail('profile_key_setup_required')
      if (/^\(<true>,\)\s*$/.test(locked.output.toString('utf8'))) throw fail('profile_key_unlock_required')
      if (!/^\(<false>,\)\s*$/.test(locked.output.toString('utf8'))) throw fail('profile_key_setup_required')
    } finally { locked.output.fill(0) }
    return collection
  }
  // Refuses a locked keychain before any item command could raise its unlock
  // dialog, and a missing one because add-generic-password silently writes to
  // the default keychain when the named file does not exist. A keychain that
  // locks after this probe still refuses: its item command waits on the dialog
  // until the helper timeout (unlock_required), or exits 36 without a display.
  async _keychainReady(assertCurrent, signal) {
    if (!this.hasHelper(SECURITY) || !this.hasHelper(OSASCRIPT)) throw fail('profile_key_setup_required')
    let keychain = this.keychain
    if (!keychain) {
      const login = await this._call(SECURITY, ['login-keychain'], assertCurrent, undefined, signal)
      try {
        const match = login.code === 0 && /^\s*"([^"]+)"\s*$/.exec(login.output.toString('utf8'))
        if (!match || match[1].length > 1024 || !KEYCHAIN_PATH.test(match[1])) throw fail('profile_key_setup_required')
        keychain = match[1]
      } finally { login.output.fill(0) }
    }
    const status = await this._call(OSASCRIPT, ['-l', 'JavaScript', '-e', KEYCHAIN_STATUS, keychain], assertCurrent, undefined, signal)
    try {
      if (status.code !== 0) throw fail('profile_key_setup_required')
      if (status.output.toString('utf8') === 'locked\n') throw fail('profile_key_unlock_required')
      if (status.output.toString('utf8') !== 'unlocked\n') throw fail('profile_key_setup_required')
    } finally { status.output.fill(0) }
    return keychain
  }
  // One OS item per record: Secret Service attributes, or a Keychain generic
  // password whose account binds the same scope and record id. Every Keychain
  // command names its keychain, and the key travels only on stdin.
  _item(command, location, purpose, binding, recordId, secret) {
    const [application, label] = ITEMS[purpose]
    if (this.provider === LIBSECRET) {
      const exact = ['application', application, 'scope', scopeOf(binding), 'record', recordId]
      return command === 'store' ? ['/usr/bin/secret-tool', ['store', `--label=${label}`, `--collection=${location}`, ...exact], Buffer.from(secret)] : ['/usr/bin/secret-tool', [command, ...exact]]
    }
    const account = `${scopeOf(binding)}.${recordId}`
    if (command === 'store') return [SECURITY, ['-i'], Buffer.from(`add-generic-password -a ${account} -s ${application} -l "${label}" -w ${secret} "${location}"\n`)]
    return [SECURITY, command === 'lookup' ? ['find-generic-password', '-a', account, '-s', application, '-w', location] : ['delete-generic-password', '-a', account, '-s', application, location]]
  }
  // security find-generic-password -w ends the password with one newline.
  _secret(output) {
    const value = output.toString('utf8'), text = value.slice(0, 43)
    if (!(this.provider === KEYCHAIN ? /^[A-Za-z0-9_-]{43}\n$/ : /^[A-Za-z0-9_-]{43}$/).test(value)) throw fail('profile_key_refused')
    const key = Buffer.from(text, 'base64url')
    if (key.length !== 32 || key.toString('base64url') !== text) { key.fill(0); throw fail('profile_key_refused') }
    return key
  }
  // Failed-write and discard cleanup of this exact new item only.
  async _cleanup(location, purpose, binding, recordId) {
    const [executable, args] = this._item('clear', location, purpose, binding, recordId)
    return this.run(executable, args, { environment: this._environment(), timeoutMs: this.timeoutMs, maxBytes: LIMIT })
  }
  /** @param {{binding:any,assertCurrent:()=>unknown,signal?:AbortSignal}} options */
  async status({ binding, assertCurrent, signal }) {
    try { bindingOf(binding); await this._ready(assertCurrent, signal); return { state: 'ready', provider: this.provider } }
    catch (error) {
      const states = { profile_key_setup_required: 'setup_required', profile_key_unlock_required: 'unlock_required', profile_key_manual_unlock_required: 'manual_unlock_required', profile_key_background_grant_required: 'background_grant_required' }
      return { state: states[error.code] || 'refused', reason: states[error.code] ? error.code : 'profile_key_refused' }
    }
  }
  /** @param {{binding:any,endpoint:any,assertCurrent:()=>unknown,signal?:AbortSignal}} options */
  async protect({ binding: raw, endpoint, assertCurrent, signal }) {
    const binding = bindingOf(raw), recordId = randomUUID(), key = randomBytes(32)
    let attempted = false, location
    try {
      if (endpoint?.identity?.endpointId !== binding.endpointId || this.endpointCrypto.identityFingerprint(endpoint.identity) !== binding.keyFingerprint) throw fail('profile_key_refused')
      location = await this._ready(assertCurrent, signal)
      const keys = this.endpointCrypto.protectEndpointKeys({ endpoint, safeStorage: this._adapter(key, binding, recordId), platform: this._platform })
      const record = { version: 1, provider: this.provider, recordId, binding, keys }
      this._record(record, binding)
      const [executable, args, input] = this._item('store', location, 'endpoint', binding, recordId, key.toString('base64url'))
      try {
        attempted = true
        const result = await this._call(executable, args, assertCurrent, input, signal)
        try { if (result.code !== 0) throw fail('profile_key_unlock_required') } finally { result.output.fill(0) }
      } finally { input.fill(0) }
      return record
    } catch (error) {
      // Only this newly generated record id is eligible for failed-write cleanup.
      if (attempted) await this._cleanup(location, 'endpoint', binding, recordId).then(value => value.output.fill(0), () => {})
      throw fail(['profile_key_setup_required', 'profile_key_unlock_required', 'profile_key_manual_unlock_required', 'profile_key_context_changed'].includes(error.code) ? error.code : 'profile_key_refused')
    } finally { key.fill(0) }
  }
  _record(record, binding) {
    exact(record, ['version', 'provider', 'recordId', 'binding', 'keys'])
    exact(record.keys, ['version', 'identityFingerprint', 'ciphertext'])
    if (record.version !== 1 || record.provider !== this.provider || typeof record.recordId !== 'string' || !UUID.test(record.recordId) || JSON.stringify(bindingOf(record.binding)) !== JSON.stringify(binding) ||
        record.keys.version !== 1 || record.keys.identityFingerprint !== binding.keyFingerprint || typeof record.keys.ciphertext !== 'string' || !record.keys.ciphertext.length || record.keys.ciphertext.length > Math.ceil(LIMIT * 4 / 3) + 4 || !/^[A-Za-z0-9_-]+$/.test(record.keys.ciphertext)) throw fail('profile_key_refused')
  }
  /** @param {{record:any,binding:any,pinnedIdentity:any,assertCurrent:()=>unknown,signal?:AbortSignal}} options */
  async restore({ record, binding: raw, pinnedIdentity, assertCurrent, signal }) {
    const binding = bindingOf(raw)
    this._record(record, binding)
    if (pinnedIdentity?.endpointId !== binding.endpointId || this.endpointCrypto.identityFingerprint(pinnedIdentity) !== binding.keyFingerprint) throw fail('profile_key_refused')
    const location = await this._ready(assertCurrent, signal), [executable, args] = this._item('lookup', location, 'endpoint', binding, record.recordId)
    const result = await this._call(executable, args, assertCurrent, undefined, signal)
    let key
    try {
      if (result.code !== 0) { await this._ready(assertCurrent, signal); throw fail('profile_key_setup_required') }
      key = this._secret(result.output)
      const endpoint = this.endpointCrypto.restoreEndpointKeys({ record: record.keys, pinnedIdentity, safeStorage: this._adapter(key, binding, record.recordId), platform: this._platform })
      await this._authority(assertCurrent)
      return endpoint
    } catch (error) { throw fail(['profile_key_setup_required', 'profile_key_unlock_required', 'profile_key_context_changed'].includes(error.code) ? error.code : 'profile_key_refused') }
    finally { key?.fill(0); result.output.fill(0) }
  }
  /** @param {{record:any,binding:any,assertRevoked:()=>unknown,signal?:AbortSignal}} options */
  async remove({ record, binding: raw, assertRevoked, signal }) {
    const binding = bindingOf(raw)
    this._record(record, binding)
    const location = await this._ready(assertRevoked, signal), [executable, args] = this._item('clear', location, 'endpoint', binding, record.recordId)
    const result = await this._call(executable, args, assertRevoked, undefined, signal)
    try { if (result.code !== 0) throw fail('profile_key_unlock_required'); return { removed: true } }
    finally { result.output.fill(0) }
  }

  // Async OS unlock is completed before a browser runtime is admitted. The
  // returned cryptographic capability is private host memory and can never
  // grant runtime authority. Saved counters are accepted only if exactly equal
  // to a separately verified current binding. No prior-epoch fallback exists.
  /** @param {{binding:any,pinnedIdentity:any,record?:any,createNew?:boolean,assertCurrent:()=>unknown,signal?:AbortSignal}} options */
  async preloadPortableExtrasProtector({ binding: raw, pinnedIdentity, record, createNew = false, assertCurrent, signal }) {
    const binding = bindingOf(raw)
    if (pinnedIdentity?.endpointId !== binding.endpointId || this.endpointCrypto.identityFingerprint(pinnedIdentity) !== binding.keyFingerprint ||
        typeof createNew !== 'boolean' || (createNew ? record !== undefined : record === undefined)) throw fail('profile_key_refused')
    if (!createNew) {
      exact(record, ['version', 'provider', 'purpose', 'recordId', 'binding'])
      if (record.version !== 1 || record.provider !== this.provider || record.purpose !== 'portable-extras-v1' || typeof record.recordId !== 'string' || !UUID.test(record.recordId) || JSON.stringify(bindingOf(record.binding)) !== JSON.stringify(binding)) throw fail('profile_key_refused')
    }
    const recordId = createNew ? randomUUID() : record.recordId
    const metadata = Object.freeze({ version: 1, provider: this.provider, purpose: 'portable-extras-v1', recordId, binding })
    let key, attempted = false, transferred = false, location
    const current = () => {
      if (signal?.aborted || typeof assertCurrent !== 'function') throw fail('profile_key_context_changed')
      const value = assertCurrent()
      if (value?.then) { void Promise.resolve(value).catch(() => {}); throw fail('profile_key_context_changed') }
      if (value === false) throw fail('profile_key_context_changed')
    }
    try {
      current(); location = await this._ready(assertCurrent, signal); current()
      if (createNew) {
        key = randomBytes(32); const [executable, args, input] = this._item('store', location, 'extras', binding, recordId, key.toString('base64url'))
        try {
          attempted = true
          const result = await this._call(executable, args, assertCurrent, input, signal)
          try { if (result.code !== 0) throw fail('profile_key_unlock_required') } finally { result.output.fill(0) }
        } finally { input.fill(0) }
      } else {
        const [executable, args] = this._item('lookup', location, 'extras', binding, recordId), result = await this._call(executable, args, assertCurrent, undefined, signal)
        try {
          if (result.code !== 0) { await this._ready(assertCurrent, signal); throw fail('profile_key_setup_required') }
          key = this._secret(result.output)
        } finally { result.output.fill(0) }
      }
      current(); const adapter = this._adapter(key, binding, recordId, true); let disposed = false
      const check = () => { if (disposed) throw fail('profile_key_context_changed'); current() }
      const protector = Object.freeze({ record: metadata,
        encryptString: text => { check(); const bytes = adapter.encryptString(text); try { check(); return bytes } catch (error) { bytes.fill(0); throw error } },
        decryptString: bytes => { check(); const text = adapter.decryptString(bytes); check(); return text },
        dispose: () => { disposed = true; key.fill(0) },
        // Only the host's failed explicit create path uses this capability.
        // Disposal is mandatory first. Its immutable exact record attributes
        // cannot delete an older endpoint key or another profile's record.
        discardCreatedRecord: async () => {
          if (!createNew || !disposed) throw fail('profile_key_refused')
          let result
          try {
            result = await this._cleanup(location, 'extras', binding, recordId)
            if (!result || !Buffer.isBuffer(result.output) || result.output.length > LIMIT || result.code !== 0) throw fail('profile_key_cleanup_required')
            return Object.freeze({ removed: true })
          } catch { throw fail('profile_key_cleanup_required') } finally { result?.output?.fill?.(0) }
        },
      })
      transferred = true; return protector
    } catch (error) {
      key?.fill(0)
      if (attempted) await this._cleanup(location, 'extras', binding, recordId).then(value => value.output.fill(0), () => {})
      throw fail(['profile_key_setup_required', 'profile_key_unlock_required', 'profile_key_manual_unlock_required', 'profile_key_context_changed'].includes(error.code) ? error.code : 'profile_key_refused')
    } finally { if (!transferred) key?.fill(0) }
  }
}
