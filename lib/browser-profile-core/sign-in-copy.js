"use strict";
// A sealed copy of an agent's sign-ins, for one receiving endpoint (portable
// browser design, section 6; KC: "agent machine retain the cookies and the login
// ... in a vault"). Same primitives as active backups and checkpoints: X25519 to
// the recipient's own key, HKDF-SHA256, AES-256-GCM, an Ed25519 signature by the
// source. Nothing new, nothing home made.
//
// THE LIMITS THIS FILE HOLDS.
//   - Sealed on the person's device (or on the machine, for a copy going back)
//     to the exact key the sealer pinned. The server carries these bytes and
//     can read no value in them. It does see the plain list of site names sent
//     beside a copy for the shelf, as the design says it may (section 6).
//   - Cookies and site storage only. A saved password never enters a copy: a
//     seal refuses a state holding one and an open refuses a copy holding one.
//   - No site in a blocked category (finance, adult, piracy: policy.js), which is
//     KC's call 3. A seal refuses one; signInStateOf drops them first.
//   - A fresh key per copy, never the profile's content key, so a machine that
//     holds a copy can read nothing else in the profile, even with the server's
//     help.
//   - Every failure is one code with no detail, and no value is in any error.
//
// Pure: no filesystem, network, renderer or browser. The opener's state lives in
// its caller's memory only.
//
// No em or en dashes in this file.
const crypto = require("node:crypto");
const { canonical } = require("./coordinator-client");
const { identityFingerprint } = require("./crypto");
const { encodePortableState, decodePortableState, SCHEMA } = require("./portable-state");

const PURPOSE = "HOAI-SIGN-IN-COPY-v1";
const SIGN_IN_COPY_MAX_BYTES = 16 * 1024 * 1024;
const MANIFEST_FIELDS = ["version", "kind", "profileId", "actingUserId", "assistantId", "sourceEndpointId", "sourceKeyFingerprint", "recipientEndpointId", "recipientKeyFingerprint", "recipientGrantVersion", "sequence", "createdAt", "ciphertextHash", "ciphertextBytes"];
const CONTEXT_FIELDS = MANIFEST_FIELDS.filter(field => field !== "ciphertextHash" && field !== "ciphertextBytes");
const COPY_FIELDS = ["manifest", "manifestSignature", "ciphertext"];
const STATE_FIELDS = ["schema", "cookies", "origins", "passwordVault", "preferences"];
const EMPTY_VAULT = Object.freeze({ v: 1, entries: Object.freeze([]), neverOrigins: Object.freeze([]) });
const DEFAULT_PREFERENCES = Object.freeze({ v: 1, searchEngine: "google" });
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

const fail = () => Object.assign(new Error("profile_sign_in_copy_refused"), { code: "profile_sign_in_copy_refused" });
const sha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const aad = (context, role) => Buffer.concat([Buffer.from(`${PURPOSE}:${role}\0`), canonical(context)]);

function exact(value, fields) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).length !== fields.length) throw fail();
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) throw fail();
  }
}

// The blocked categories are the browser policy's own list. Required here, not at
// the top: a machine that only opens copies never needs it, and the plugin keeps
// the policy under another folder name.
function categoryOf(origin) {
  let policy;
  try { policy = require("../policy"); } catch { policy = require("../browser-host-core/policy.js"); }
  return policy.categoryOf(origin);
}
const hostOfCookie = row => String(row?.domain ?? "").replace(/^\./, "");
const cookieBlocked = row => !hostOfCookie(row) || categoryOf(`https://${hostOfCookie(row)}`) !== null;
const originBlocked = row => typeof row?.origin !== "string" || categoryOf(row.origin) !== null;

/**
 * Does this backup recipient get sign-ins only? Everything does, unless it is the
 * sealer itself or this computer recorded it as one of the person's own computers.
 * The server's word about a row's kind plays no part, so a server cannot hand the
 * saved passwords to a machine by calling it a desktop.
 */
function recipientGetsSignInsOnly(endpointId, sourceEndpointId, pinnedPeers) {
  if (endpointId === sourceEndpointId) return false;
  return (pinnedPeers || []).find(peer => peer.endpointId === endpointId)?.kind !== "desktop";
}

/**
 * May this machine hold a person's sign-ins? KC's limit: no secret in model input or in files the
 * agent can read. A seal does not keep out an agent that shares the host's OS user, so nothing is
 * sealed to such a machine: no copy and no move.
 *
 * Only proof that the host runs as a separate OS user opens this, and that proof does not exist
 * yet. A machine's own word is not one: the agent next to it holds the same key and could sign
 * anything the host could. So nothing in the product writes this field, the pin readers refuse a
 * file that carries it, and today no machine gets a copy. The separate OS user design defines how
 * a computer comes to record it.
 */
function machineProvedSeparateUser(peer) {
  return peer?.kind === "agent" && peer.separateOsUser === true;
}

/** What a machine may hold, from a full portable state. Passwords and blocked sites go. */
function signInStateOf(state) {
  if (!state || !Array.isArray(state.cookies) || !Array.isArray(state.origins)) throw fail();
  return {
    schema: SCHEMA,
    cookies: state.cookies.filter(row => !cookieBlocked(row)),
    origins: state.origins.filter(row => !originBlocked(row)),
    passwordVault: { v: 1, entries: [], neverOrigins: [] },
    preferences: state.preferences || { ...DEFAULT_PREFERENCES },
  };
}

/** The site names a copy holds, for the Browser sign-ins shelf. Never a value. */
function sitesOf(state) {
  const sites = new Set();
  for (const row of state.cookies) sites.add(hostOfCookie(row));
  for (const row of state.origins) {
    try { sites.add(new URL(row.origin).hostname); } catch { /* not a site */ }
  }
  sites.delete("");
  return [...sites].sort().slice(0, 500);
}

function assertSafeState(state) {
  exact(state, STATE_FIELDS);
  if (state.schema !== SCHEMA || !Array.isArray(state.cookies) || !Array.isArray(state.origins)) throw fail();
  const vault = state.passwordVault;
  if (!vault || !Array.isArray(vault.entries) || vault.entries.length !== 0 || !Array.isArray(vault.neverOrigins) || vault.neverOrigins.length !== 0) throw fail();
  if (state.cookies.some(cookieBlocked) || state.origins.some(originBlocked)) throw fail();
}

function assertSource(source) {
  exact(source, ["identity", "signingPrivateKey"].concat(Object.hasOwn(source || {}, "encryptionPrivateKey") ? ["encryptionPrivateKey"] : []));
  if (!(source.signingPrivateKey instanceof crypto.KeyObject) || source.signingPrivateKey.type !== "private" || source.signingPrivateKey.asymmetricKeyType !== "ed25519") throw fail();
  const signing = crypto.createPublicKey(source.signingPrivateKey).export({ type: "spki", format: "der" }).toString("base64url");
  if (signing !== source.identity?.signingPublicKey) throw fail();
}

function publicKeyOf(encoded, type) {
  if (typeof encoded !== "string" || encoded.length > 128) throw fail();
  const key = crypto.createPublicKey({ key: Buffer.from(encoded, "base64url"), format: "der", type: "spki" });
  if (key.asymmetricKeyType !== type) throw fail();
  return key;
}

function encrypt(key, bytes, context, role) {
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad(context, role));
  const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return { iv: iv.toString("base64url"), ciphertext: ciphertext.toString("base64url"), tag: cipher.getAuthTag().toString("base64url") };
}

function decrypt(key, envelope, context, role) {
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(String(envelope?.iv), "base64url"));
  decipher.setAAD(aad(context, role));
  decipher.setAuthTag(Buffer.from(String(envelope?.tag), "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(String(envelope?.ciphertext), "base64url")), decipher.final()]);
}

function wrappingKey(shared, salt, context) {
  return Buffer.from(crypto.hkdfSync("sha256", shared, salt, crypto.createHash("sha256").update(aad(context, "derive-wrap")).digest(), 32));
}

function sealValidated({ state, scope, source, recipient, sequence, createdAt = Date.now() }) {
  let plaintext, key, shared, wrapping;
  try {
    assertSource(source);
    if (!Number.isSafeInteger(sequence) || sequence < 1 || !Number.isSafeInteger(createdAt) || createdAt < 1) throw fail();
    if (!Number.isSafeInteger(recipient?.grantVersion) || recipient.grantVersion < 1 || identityFingerprint(recipient.identity) !== recipient.keyFingerprint) throw fail();
    plaintext = encodePortableState(state);
    if (plaintext.length > SIGN_IN_COPY_MAX_BYTES) throw fail();
    const context = {
      version: 1, kind: "sign-in-copy", profileId: scope.profileId, actingUserId: scope.actingUserId, assistantId: scope.assistantId,
      sourceEndpointId: source.identity.endpointId, sourceKeyFingerprint: identityFingerprint(source.identity),
      recipientEndpointId: recipient.identity.endpointId, recipientKeyFingerprint: recipient.keyFingerprint, recipientGrantVersion: recipient.grantVersion,
      sequence, createdAt,
    };
    key = crypto.randomBytes(32);
    const ephemeral = crypto.generateKeyPairSync("x25519"), salt = crypto.randomBytes(32);
    shared = crypto.diffieHellman({ privateKey: ephemeral.privateKey, publicKey: publicKeyOf(recipient.identity.encryptionPublicKey, "x25519") });
    wrapping = wrappingKey(shared, salt, context);
    const packet = {
      version: 1,
      content: encrypt(key, plaintext, context, "content"),
      wrappedKey: {
        ephemeralPublicKey: ephemeral.publicKey.export({ type: "spki", format: "der" }).toString("base64url"),
        salt: salt.toString("base64url"),
        ...encrypt(wrapping, key, context, "wrapped-key"),
      },
    };
    const bytes = Buffer.from(JSON.stringify(packet));
    const manifest = { ...context, ciphertextHash: sha256(bytes), ciphertextBytes: bytes.length };
    return {
      manifest,
      manifestSignature: crypto.sign(null, canonical(manifest), source.signingPrivateKey).toString("base64url"),
      ciphertext: bytes.toString("base64"),
    };
  } catch { throw fail(); } finally { plaintext?.fill(0); key?.fill(0); shared?.fill(0); wrapping?.fill(0); }
}

/** Seals a machine-safe state to one recipient's key. Refuses anything a machine may not hold. */
function sealSignInCopy(input) {
  try { assertSafeState(input?.state); } catch { throw fail(); }
  return sealValidated(input);
}

/** The shape the server checks: it can read no key, so it checks no key. */
function assertSignInCopyWire(copy) {
  exact(copy, COPY_FIELDS);
  exact(copy.manifest, MANIFEST_FIELDS);
  const m = copy.manifest;
  if (m.version !== 1 || m.kind !== "sign-in-copy" || !UUID.test(String(m.profileId)) || !UUID.test(String(m.sourceEndpointId)) || !UUID.test(String(m.recipientEndpointId)) ||
      !HASH.test(String(m.sourceKeyFingerprint)) || !HASH.test(String(m.recipientKeyFingerprint)) || !HASH.test(String(m.ciphertextHash)) ||
      !Number.isSafeInteger(m.assistantId) || m.assistantId < 1 || !Number.isSafeInteger(m.recipientGrantVersion) || m.recipientGrantVersion < 1 ||
      !Number.isSafeInteger(m.sequence) || m.sequence < 1 || !Number.isSafeInteger(m.createdAt) || m.createdAt < 1 ||
      !Number.isSafeInteger(m.ciphertextBytes) || m.ciphertextBytes < 1 || m.ciphertextBytes > SIGN_IN_COPY_MAX_BYTES * 2 ||
      typeof copy.manifestSignature !== "string" || copy.manifestSignature.length !== 86 || typeof copy.ciphertext !== "string") throw fail();
  return copy;
}

/**
 * Opens a copy addressed to this endpoint from the source this endpoint pinned.
 * `expected` names the exact scope, grant and the last sequence already taken.
 * The state returned is plaintext: it lives in the caller's memory, never a file,
 * a log, a tool result or a model's input.
 */
function openSignInCopy({ copy, sourceIdentity, recipient, expected }) {
  let shared, wrapping, key, plaintext;
  try {
    assertSignInCopyWire(copy);
    const m = copy.manifest, sourceFingerprint = identityFingerprint(sourceIdentity), recipientFingerprint = identityFingerprint(recipient.identity);
    if (m.sourceEndpointId !== sourceIdentity.endpointId || m.sourceKeyFingerprint !== sourceFingerprint) throw fail();
    if (!crypto.verify(null, canonical(m), publicKeyOf(sourceIdentity.signingPublicKey, "ed25519"), Buffer.from(copy.manifestSignature, "base64url"))) throw fail();
    if (m.profileId !== expected.profileId || m.actingUserId !== expected.actingUserId || m.assistantId !== expected.assistantId) throw fail();
    if (m.recipientEndpointId !== expected.recipient.endpointId || m.recipientKeyFingerprint !== expected.recipient.keyFingerprint || m.recipientGrantVersion !== expected.recipient.grantVersion) throw fail();
    if (recipient.identity.endpointId !== m.recipientEndpointId || recipientFingerprint !== m.recipientKeyFingerprint) throw fail();
    if (!Number.isSafeInteger(expected.afterSequence) || m.sequence <= expected.afterSequence) throw fail();
    const encryptionPublic = crypto.createPublicKey(recipient.encryptionPrivateKey).export({ type: "spki", format: "der" }).toString("base64url");
    if (encryptionPublic !== recipient.identity.encryptionPublicKey) throw fail();
    const bytes = Buffer.from(copy.ciphertext, "base64");
    if (bytes.toString("base64") !== copy.ciphertext || bytes.length !== m.ciphertextBytes || sha256(bytes) !== m.ciphertextHash) throw fail();
    const packet = JSON.parse(bytes.toString("utf8"));
    exact(packet, ["version", "content", "wrappedKey"]);
    if (packet.version !== 1) throw fail();
    exact(packet.wrappedKey, ["ephemeralPublicKey", "salt", "iv", "ciphertext", "tag"]);
    const context = Object.fromEntries(CONTEXT_FIELDS.map(field => [field, m[field]]));
    shared = crypto.diffieHellman({ privateKey: recipient.encryptionPrivateKey, publicKey: publicKeyOf(packet.wrappedKey.ephemeralPublicKey, "x25519") });
    wrapping = wrappingKey(shared, Buffer.from(packet.wrappedKey.salt, "base64url"), context);
    key = decrypt(wrapping, packet.wrappedKey, context, "wrapped-key");
    if (key.length !== 32) throw fail();
    plaintext = decrypt(key, packet.content, context, "content");
    const state = decodePortableState(plaintext);
    assertSafeOpened(state);
    return { state, sequence: m.sequence, createdAt: m.createdAt };
  } catch { throw fail(); } finally { shared?.fill(0); wrapping?.fill(0); key?.fill(0); plaintext?.fill(0); }
}

/** A running backup's draft (origin rows still JSON) as the state signInStateOf reads. */
function stateOfDraft(draft) {
  return { cookies: draft.cookies, origins: draft.origins.map(row => JSON.parse(row)), preferences: draft.extras?.preferences };
}

/**
 * Sends a state to each machine in `recipients`, sealed here, each with its own
 * sequence. A machine that refuses or fails is its own failure: nothing here stops
 * the person's browser, and no error carries a value.
 */
async function sendSignInCopies({ client, state, scope, source, recipients, now = Date.now, onResult = () => {} }) {
  const safe = signInStateOf(state), sites = sitesOf(safe), sent = [];
  for (const recipient of recipients) {
    const { signInsOnly: _flag, signInsProved, ...row } = recipient;
    if (signInsProved !== true) continue; // machineProvedSeparateUser, at the seal's own door
    const sequence = now();
    try {
      const copy = sealSignInCopy({ state: safe, scope, source, recipient: row, sequence, createdAt: sequence });
      await client.upload(scope.profileId, copy, sites);
      sent.push(row.identity.endpointId);
      onResult({ endpointId: row.identity.endpointId, ok: true });
    } catch (error) { onResult({ endpointId: row.identity.endpointId, ok: false, code: error?.code || "failed" }); }
  }
  return sent;
}

/**
 * A copy coming back from a machine over a state about to open: each site the copy
 * holds replaces that site, cookies and storage alike, and the rest stays. Saved
 * passwords, preferences and tabs are the computer's own and are never touched.
 */
function mergeSignIns(state, opened) {
  const siteOf = row => hostOfCookie(row).toLowerCase();
  const incomingSites = new Set(opened.cookies.map(siteOf));
  const incoming = new Map(opened.origins.map(row => [row.origin, row]));
  const key = row => `${row.name}\0${row.domain}\0${row.path}`;
  const cookies = new Map();
  for (const row of state.cookies) if (!incomingSites.has(siteOf(row))) cookies.set(key(row), row);
  for (const row of opened.cookies) cookies.set(key(row), row);
  // A machine restores no IndexedDB, so an empty list from it says nothing: this computer's stays.
  const origins = state.origins.map(row => {
    const back = incoming.get(row.origin);
    if (!back) return row;
    incoming.delete(row.origin);
    return { ...back, indexedDB: back.indexedDB?.length ? back.indexedDB : row.indexedDB };
  });
  return { ...state, cookies: [...cookies.values()], origins: [...origins, ...incoming.values()] };
}

// What a site holds, in rows that compare: an expiry moving alone is not a change.
const siteOfOrigin = row => { try { return new URL(row.origin).hostname.toLowerCase(); } catch { return ""; } };
const siteOfCookie = row => hostOfCookie(row).toLowerCase();
function rowsBySite(state) {
  const sites = new Map(), add = (site, row) => { if (site) sites.set(site, [...(sites.get(site) || []), JSON.stringify(row)]); };
  for (const row of state.cookies || []) add(siteOfCookie(row), ["cookie", row.name, row.domain, row.path, row.value]);
  for (const row of state.origins || []) for (const item of row.localStorage || []) add(siteOfOrigin(row), ["storage", row.origin, item.name, item.value]);
  return sites;
}

/** Each site's rows as one digest: this is what is kept to compare, in memory, and it holds no value. */
function siteDigests(state) {
  return new Map([...rowsBySite(state)].map(([site, rows]) => [site, sha256(Buffer.from(JSON.stringify(rows.sort())))]));
}

/** The sites of `state` whose rows differ from `before` (siteDigests), new ones included. */
function changedSites(before, state) {
  return [...siteDigests(state)].filter(([site, digest]) => before.get(site) !== digest).map(([site]) => site).sort();
}

/** The state with these sites' rows alone. */
function onlySites(state, sites) {
  const named = new Set(sites);
  return { ...state, cookies: state.cookies.filter(row => named.has(siteOfCookie(row))), origins: state.origins.filter(row => named.has(siteOfOrigin(row))) };
}

/**
 * Returned copies over a state about to open, only on the person's own yes. Nothing in the rows
 * tells a renewed login from a session under another account, a parent domain's cookie reaches
 * every site below it, and a new site can hold someone else's account, so without that yes the
 * state opens exactly as it was saved.
 */
function applyReturnedSignIns(state, returned, personSaidYes) {
  if (personSaidYes !== true) return state;
  return returned.reduce((merged, opened) => mergeSignIns(merged, opened), state);
}

// Opening holds the passwords line. The blocked list stays the sealer's: a machine
// carrying the plugin's copy of the policy does not re-decide the person's choice.
function assertSafeOpened(state) {
  if (state.passwordVault.entries.length !== 0 || state.passwordVault.neverOrigins.length !== 0) throw fail();
}

module.exports = { machineProvedSeparateUser, recipientGetsSignInsOnly, sealSignInCopy, openSignInCopy, signInStateOf, sitesOf, stateOfDraft, sendSignInCopies, mergeSignIns, siteDigests, changedSites, onlySites, applyReturnedSignIns, assertSignInCopyWire, SIGN_IN_COPY_MAX_BYTES, PURPOSE, __sealUncheckedForTests: sealValidated };
