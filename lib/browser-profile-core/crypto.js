"use strict";

// Main/host-only primitives. Enrollment, freshness, grant revocation, writer
// authority and filesystem durability belong to their respective coordinators.
const crypto = require("node:crypto");
const { types } = require("node:util");
const MAX_PLAINTEXT_BYTES = 16 * 1024 * 1024;
const MAX_PACKET_BYTES = 24 * 1024 * 1024;
const MAX_WIRE_BYTES = 32 * 1024 * 1024;
const MAX_KEY_RECORD_BYTES = 8192;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const HASH = /^[a-f0-9]{64}$/;
const CONTEXT_KEYS = ["version", "profileId", "actingUserId", "assistantId", "transitionId", "revision",
  "previousManifestHash", "keyEpoch", "source", "destination", "schemaVersion"];
const SOURCE_KEYS = ["endpointId", "bootId", "runtimeId", "sessionId", "writerEpoch"];
const DESTINATION_KEYS = ["endpointId", "bootId", "runtimeId", "sessionId", "grantVersion", "keyFingerprint"];
const IDENTITY_KEYS = ["version", "endpointId", "signingPublicKey", "encryptionPublicKey"];
// Format 2 (S3, D2): one content box, one wrapped key per recipient.
// Version 2 uses S3's grammar so the server hashes and verifies the bytes the
// desktop signed: lowercase UUIDs and its short plain identifiers.
const MAX_CHECKPOINT_RECIPIENTS = 4;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const PLAIN = /^[A-Za-z0-9_-]{1,128}$/;
const RECIPIENT_KEYS = ["endpointId", "grantVersion", "keyFingerprint"];
const RECIPIENT_ENDPOINT_KEYS = ["kind", "ownerUserId", "pairingId", "identity"];
const WRAPPED_KEYS = ["endpointId", "ephemeralPublicKey", "salt", "iv", "ciphertext", "tag"];
const CANDIDATE_KEYS = ["endpointId", "ownerUserId", "kind", "pairingId", "label", "signingPublicKey", "encryptionPublicKey", "keyFingerprint",
  "grantVersion", "enrolledAt", "grantedAt", "formats", "sequence", "signature"];
const FORMATS = ["[1]", "[1,2]"];
const PURPOSES = ["transfer", "return", "agent-retirement"];
const X25519_P = Buffer.from("edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f", "hex");
const fail = () => Object.assign(new Error("profile_sync_crypto_refused"), { code: "profile_sync_crypto_refused" });
// Who may hold a copy is judged from public rows only, so these refusals name
// their reason; every other refusal stays the one uniform code.
const HOLDER_REFUSALS = ["agent-endpoint", "other-owner", "source-endpoint"];
const refuse = reason => Object.assign(fail(), { reason });
const rethrow = error => error?.code === "profile_sync_crypto_refused" && HOLDER_REFUSALS.includes(error.reason) ? refuse(error.reason) : fail();
const positive = value => Number.isSafeInteger(value) && value > 0;
const identifier = value => typeof value === "string" && ID.test(value);
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

function exact(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== keys.length || keys.some(key =>
    !Object.hasOwn(descriptors, key) || !Object.hasOwn(descriptors[key], "value") || !descriptors[key].enumerable)) throw fail();
  return value;
}

function decode(value, max, length) {
  if (typeof value !== "string" || !value.length || value.length > Math.ceil(max * 4 / 3) + 4 ||
      !/^[A-Za-z0-9_-]+$/.test(value)) throw fail();
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length > max || (length !== undefined && bytes.length !== length) || bytes.toString("base64url") !== value) throw fail();
  return bytes;
}

function decodeWire(value) {
  if (typeof value !== "string" || !value.length || value.length > MAX_WIRE_BYTES || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw fail();
  const bytes = Buffer.from(value, "base64");
  if (bytes.length > MAX_PACKET_BYTES || bytes.toString("base64") !== value) throw fail();
  return bytes;
}

// The strict manifest schema uses ASCII strings and safe integers only. This
// deterministic JSON codec is deliberately not a general-purpose JCS library.
function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])]));
  return value;
}
const canonical = value => Buffer.from(JSON.stringify(sorted(value)), "utf8");

// Reads a version without running an accessor, before the exact key check.
function versionOf(value) {
  const descriptor = value && typeof value === "object" ? Object.getOwnPropertyDescriptor(value, "version") : undefined;
  return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
}
const contextKeys = version => version === 2 ? [...CONTEXT_KEYS, "recipients"] : CONTEXT_KEYS;

// A plain array with exactly its index data properties: no accessor, proxy
// trap, hole or extra key can make validation and use see different rows.
function plainList(value, min, max) {
  if (!Array.isArray(value) || types.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length < min || value.length > max ||
      Reflect.ownKeys(value).length !== value.length + 1) throw fail();
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, "value")) throw fail();
    return descriptor.value;
  });
}
function recipientRow(value) {
  exact(value, RECIPIENT_KEYS);
  if (typeof value.endpointId !== "string" || !UUID.test(value.endpointId) || !positive(value.grantVersion) ||
      typeof value.keyFingerprint !== "string" || !HASH.test(value.keyFingerprint)) throw fail();
  return value;
}
const sameRow = (a, b) => RECIPIENT_KEYS.every(key => a[key] === b[key]);

// One to four rows in strictly ascending endpointId order (S3 compares raw
// strings; lowercase UUIDs make that the same order), naming the destination.
function validateRecipients(value) {
  if (!["profileId", "transitionId"].every(key => UUID.test(value[key])) || !PLAIN.test(value.actingUserId) ||
      ![value.source, value.destination].every(party => UUID.test(party.endpointId) && ["bootId", "runtimeId", "sessionId"].every(key => PLAIN.test(party[key])))) throw fail();
  const rows = plainList(value.recipients, 1, MAX_CHECKPOINT_RECIPIENTS).map(recipientRow);
  for (let index = 1; index < rows.length; index++) if (!(rows[index - 1].endpointId < rows[index].endpointId)) throw fail();
  if (!rows.some(row => sameRow(row, value.destination))) throw fail();
}

function validateContext(value) {
  exact(value, contextKeys(versionOf(value)));
  if (![1, 2].includes(value.version) || ![1, 2].includes(value.schemaVersion) ||
      !["profileId", "actingUserId", "transitionId"].every(key => identifier(value[key])) ||
      !["assistantId", "revision", "keyEpoch"].every(key => positive(value[key])) ||
      !(value.previousManifestHash === null || typeof value.previousManifestHash === "string" && HASH.test(value.previousManifestHash))) throw fail();
  exact(value.source, SOURCE_KEYS); exact(value.destination, DESTINATION_KEYS);
  for (const party of [value.source, value.destination]) {
    if (!["endpointId", "bootId", "runtimeId", "sessionId"].every(key => identifier(party[key]))) throw fail();
  }
  if (!positive(value.source.writerEpoch) || !positive(value.destination.grantVersion) ||
      typeof value.destination.keyFingerprint !== "string" || !HASH.test(value.destination.keyFingerprint)) throw fail();
  if (value.version === 2) validateRecipients(value);
  return value;
}
// A realm-local deep copy of validated JSON data that refuses proxies.
// structuredClone would build objects with the host realm's prototypes when
// this module runs inside a vm context (jest), which exact() then refuses.
function copyJson(value) {
  if (types.isProxy(value)) throw fail();
  if (Array.isArray(value)) return value.map(copyJson);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).map(key => [key, copyJson(value[key])]));
  return value;
}
// Refuse a proxy before any trap runs, validate the caller's object strictly
// (data properties only, plain prototype), copy it once in this realm and
// validate the copy: only the copy is used after that.
function checkedCopy(value, validate) {
  if (types.isProxy(value)) throw fail();
  return validate(copyJson(validate(value)));
}
// Only the context copy feeds the manifest, the AAD, the KDF info and the labels.
const snapshot = context => checkedCopy(context, validateContext);
// An endpoint read once: its identity copied, its two key objects taken as
// they are after a proxy check, and the copy validated again.
function endpointCopy(endpoint) {
  if (types.isProxy(endpoint)) throw fail();
  const { identity, signingPrivateKey, encryptionPrivateKey } = validateEndpoint(endpoint);
  if (types.isProxy(signingPrivateKey) || types.isProxy(encryptionPrivateKey)) throw fail();
  return validateEndpoint({ identity: checkedCopy(identity, validateIdentity), signingPrivateKey, encryptionPrivateKey });
}
// The epoch key copied once into a buffer this call owns, and zeroes after.
// Its size and bytes are read through the typed array intrinsics (internal
// slots, no species lookup), so an own `length`, `copy` or `constructor` on
// the caller's Buffer cannot change what is sealed or what is zeroed.
const typedByteLength = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), "byteLength").get;
const typedSet = Uint8Array.prototype.set;
function contentKeyCopy(value) {
  if (types.isProxy(value)) throw fail();
  const { epoch, key } = validateContentKey(value);
  if (typedByteLength.call(key) !== 32) throw fail();
  const copy = Buffer.alloc(32);
  typedSet.call(copy, key);
  return { epoch, key: copy };
}

function contextOf(manifest) {
  return Object.fromEntries(contextKeys(manifest.version).map(key => [key, manifest[key]]));
}

function validateManifest(value) {
  exact(value, [...contextKeys(versionOf(value)), "ciphertextHash", "ciphertextBytes"]);
  validateContext(contextOf(value));
  if (typeof value.ciphertextHash !== "string" || !HASH.test(value.ciphertextHash) ||
      !positive(value.ciphertextBytes) || value.ciphertextBytes > MAX_PACKET_BYTES) throw fail();
  return value;
}

function publicKey(encoded, type) {
  const key = crypto.createPublicKey({ key: decode(encoded, 44, 44), format: "der", type: "spki" });
  if (key.asymmetricKeyType !== type || key.export({ format: "der", type: "spki" }).toString("base64url") !== encoded) throw fail();
  return key;
}

function validateIdentity(value) {
  exact(value, IDENTITY_KEYS);
  if (value.version !== 1 || !identifier(value.endpointId)) throw fail();
  publicKey(value.signingPublicKey, "ed25519"); publicKey(value.encryptionPublicKey, "x25519");
  return value;
}

function identityFingerprint(identity) { validateIdentity(identity); return hash(canonical(identity)); }
function canonicalManifest(manifest) { return canonical(validateManifest(manifest)); }
function manifestHash(manifest) { return hash(canonicalManifest(manifest)); }

function validateEndpoint(endpoint) {
  exact(endpoint, ["identity", "signingPrivateKey", "encryptionPrivateKey"]);
  validateIdentity(endpoint.identity);
  for (const [field, publicField, type] of [["signingPrivateKey", "signingPublicKey", "ed25519"], ["encryptionPrivateKey", "encryptionPublicKey", "x25519"]]) {
    const key = endpoint[field];
    if (!(key instanceof crypto.KeyObject) || key.type !== "private" || key.asymmetricKeyType !== type ||
        crypto.createPublicKey(key).export({ format: "der", type: "spki" }).toString("base64url") !== endpoint.identity[publicField]) throw fail();
  }
  return endpoint;
}

function createEndpointIdentity(endpointId) {
  if (!identifier(endpointId)) throw fail();
  const signing = crypto.generateKeyPairSync("ed25519"), encryption = crypto.generateKeyPairSync("x25519");
  return { identity: Object.freeze({ version: 1, endpointId,
    signingPublicKey: signing.publicKey.export({ format: "der", type: "spki" }).toString("base64url"),
    encryptionPublicKey: encryption.publicKey.export({ format: "der", type: "spki" }).toString("base64url") }),
  signingPrivateKey: signing.privateKey, encryptionPrivateKey: encryption.privateKey };
}

function createContentKeyEpoch(epoch) {
  if (!positive(epoch)) throw fail();
  return { epoch, key: crypto.randomBytes(32) };
}
function validateContentKey(value) {
  exact(value, ["epoch", "key"]);
  if (!positive(value.epoch) || !Buffer.isBuffer(value.key) || value.key.length !== 32) throw fail();
  return value;
}
function rotateContentKeyEpoch(previous, nextEpoch) {
  validateContentKey(previous);
  if (!positive(nextEpoch) || nextEpoch <= previous.epoch) throw fail();
  return createContentKeyEpoch(nextEpoch);
}

// Version 1 bytes are unchanged; version 2 never shares a prefix with them.
function aad(context, kind) {
  return Buffer.concat([Buffer.from(`HOAI-PROFILE-SYNC-v${context.version}:${kind}\0`), canonical(context)]);
}
function encrypt(key, plaintext, associated) {
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(associated);
  return { iv: iv.toString("base64url"), ciphertext: Buffer.concat([cipher.update(plaintext), cipher.final()]).toString("base64url"), tag: cipher.getAuthTag().toString("base64url") };
}
function decrypt(key, envelope, associated, max, length) {
  exact(envelope, ["iv", "ciphertext", "tag"]);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, decode(envelope.iv, 12, 12));
  decipher.setAAD(associated); decipher.setAuthTag(decode(envelope.tag, 16, 16));
  let update, final;
  try {
    update = decipher.update(decode(envelope.ciphertext, max, length));
    final = decipher.final();
    return Buffer.concat([update, final]);
  } finally { update?.fill(0); final?.fill(0); }
}
function wrappingKey(privateKey, peer, salt, context, label = "key-derivation") {
  const shared = crypto.diffieHellman({ privateKey, publicKey: publicKey(peer, "x25519") });
  try {
    // A small order peer gives all zeros. Refuse it here: Electron's main
    // process runs BoringSSL, not the OpenSSL check the tests run under.
    if (shared.length !== 32 || crypto.timingSafeEqual(shared, Buffer.alloc(32))) throw fail();
    // Electron bounds HKDF info; hash the complete domain-separated context.
    return Buffer.from(crypto.hkdfSync("sha256", shared, salt, crypto.createHash("sha256").update(aad(context, label)).digest(), 32));
  } finally { shared.fill(0); }
}
// X25519 ignores bit 255 and reduces u mod p (RFC 7748), and the ephemeral key
// is not in the KDF info, so a version 2 envelope admits only the canonical
// encoding of u. That does not make the key unique: adding a small order point
// gives another canonical u with the same shared secret. Harmless here, since
// the packet bytes are signed and the AEAD binds the context, but no part of
// the design may rely on one envelope having one ephemeral encoding.
function ephemeralKey(encoded) {
  publicKey(encoded, "x25519");
  const u = decode(encoded, 44, 44).subarray(12);
  let below = false;
  for (let index = 31; index >= 0; index--) if (u[index] !== X25519_P[index]) { below = u[index] < X25519_P[index]; break; }
  if (u[31] & 0x80 || !below) throw fail();
  return encoded;
}
function signedCheckpoint(packet, context, source) {
  const bytes = canonical(packet);
  if (bytes.length > MAX_PACKET_BYTES) throw fail();
  const manifest = copyJson({ ...context, ciphertextHash: hash(bytes), ciphertextBytes: bytes.length });
  const manifestSignature = crypto.sign(null, canonicalManifest(manifest), source.signingPrivateKey).toString("base64url");
  return { manifest, manifestSignature, ciphertext: bytes.toString("base64") };
}
// Who may hold a copy (Data's gate on #2892): only one of the acting
// person's own desktops. S3 admits a desktop only for that person and with no
// pairing (profile-sync.service.ts and the return route); anything else is an
// agent runtime or another person's computer. The computer sealing a copy
// never holds one: it already has the key and would take one of four places.
function holderRefusal({ kind, ownerUserId, pairingId, endpointId }, owner, sourceEndpointId) {
  if (kind !== "desktop" || pairingId !== null) return "agent-endpoint";
  if (ownerUserId !== owner) return "other-owner";
  if (endpointId === sourceEndpointId) return "source-endpoint";
  return null;
}
function holderOf(value) {
  if (types.isProxy(value)) throw fail();
  exact(value, RECIPIENT_ENDPOINT_KEYS);
  if (!["desktop", "agent"].includes(value.kind) || typeof value.ownerUserId !== "string" || !PLAIN.test(value.ownerUserId) ||
      !(value.pairingId === null || positive(value.pairingId))) throw fail();
  return { kind: value.kind, ownerUserId: value.ownerUserId, pairingId: value.pairingId, identity: checkedCopy(value.identity, validateIdentity) };
}
// S8: an ordinary close on one of the person's own desktops saves to that same
// endpoint on a new runtime, and S3 lists the destination, so that desktop is
// a recipient of its own copy as its destination and only as that: the same
// endpoint, the same keys, its destination row. It already holds the key.
const ownClose = context => context.destination.endpointId === context.source.endpointId;
// The recipients as the caller states them, in the list's order: each is one
// of the person's own desktops, pinned by an identity hashing to its row, and
// not the source (except an own close's destination). A list naming any other
// is refused whole, never trimmed, so a caller that skips
// planCheckpointRecipients is still refused here.
function recipientIdentitiesOf(value, rows, context, source) {
  // The source is refused from the signed list itself, whatever the caller states.
  if (!ownClose(context) && rows.some(row => row.endpointId === context.source.endpointId)) throw refuse("source-endpoint");
  return plainList(value, rows.length, rows.length).map((raw, index) => {
    const holder = holderOf(raw), identity = holder.identity;
    if (identity.endpointId !== rows[index].endpointId || identityFingerprint(identity) !== rows[index].keyFingerprint) throw fail();
    const reason = holderRefusal({ ...holder, endpointId: identity.endpointId }, context.actingUserId, context.source.endpointId);
    const self = reason === "source-endpoint" && ownClose(context) && sameRow(rows[index], context.destination) && identityFingerprint(identity) === identityFingerprint(source.identity);
    if (reason && !self) throw refuse(reason);
    if (!self && (identity.encryptionPublicKey === source.identity.encryptionPublicKey || identity.signingPublicKey === source.identity.signingPublicKey)) throw refuse("source-endpoint");
    return identity;
  });
}
// Format 2, exactly S3's wire shape and its test helper's construction
// (backend/src/agent-browser/profile-sync-recipients.test-helper.ts): the
// content once under the epoch key, then per recipient a fresh ephemeral key
// and salt, labels naming that recipient, and the full ordered list in every
// AAD and KDF info. Content is sealed first, as the helper does.
function sealToRecipients({ plaintext, context, source, identities, contentKeyEpoch }) {
  const content = encrypt(contentKeyEpoch.key, plaintext, aad(context, "content"));
  const wrappedKeys = context.recipients.map((row, index) => {
    const ephemeral = crypto.generateKeyPairSync("x25519"), salt = crypto.randomBytes(32);
    let wrapping;
    try {
      wrapping = wrappingKey(ephemeral.privateKey, identities[index].encryptionPublicKey, salt, context, `key-derivation:${row.endpointId}`);
      return { endpointId: row.endpointId, ephemeralPublicKey: ephemeral.publicKey.export({ format: "der", type: "spki" }).toString("base64url"),
        salt: salt.toString("base64url"), ...encrypt(wrapping, contentKeyEpoch.key, aad(context, `wrapped-key:${row.endpointId}`)) };
    } finally { wrapping?.fill(0); }
  });
  return signedCheckpoint({ version: 2, content, wrappedKeys }, context, source);
}

// A version 2 context also needs recipientEndpoints: for every row, in the
// list's order, {kind, ownerUserId, pairingId, identity} as the plan returns
// it in `endpoints`. Version 1 takes none. Every input is checked once and
// only a copy is used after that.
function sealCheckpoint({ plaintext, context: raw, source: rawSource, destinationIdentity: rawDestination, recipientEndpoints, contentKeyEpoch: rawKey }) {
  let wrapping, contentKeyEpoch;
  try {
    const context = snapshot(raw), source = endpointCopy(rawSource), destinationIdentity = checkedCopy(rawDestination, validateIdentity);
    contentKeyEpoch = contentKeyCopy(rawKey);
    if (!Buffer.isBuffer(plaintext) || !plaintext.length || plaintext.length > MAX_PLAINTEXT_BYTES ||
        source.identity.endpointId !== context.source.endpointId || destinationIdentity.endpointId !== context.destination.endpointId ||
        identityFingerprint(destinationIdentity) !== context.destination.keyFingerprint || contentKeyEpoch.epoch !== context.keyEpoch) throw fail();
    if (context.version === 2) {
      return sealToRecipients({ plaintext, context, source, identities: recipientIdentitiesOf(recipientEndpoints, context.recipients, context, source), contentKeyEpoch });
    }
    if (recipientEndpoints !== undefined) throw fail();
    const ephemeral = crypto.generateKeyPairSync("x25519"), salt = crypto.randomBytes(32);
    wrapping = wrappingKey(ephemeral.privateKey, destinationIdentity.encryptionPublicKey, salt, context);
    const packet = { version: 1, content: encrypt(contentKeyEpoch.key, plaintext, aad(context, "content")),
      wrappedKey: { ephemeralPublicKey: ephemeral.publicKey.export({ format: "der", type: "spki" }).toString("base64url"),
        salt: salt.toString("base64url"), ...encrypt(wrapping, contentKeyEpoch.key, aad(context, "wrapped-key")) } };
    return signedCheckpoint(packet, context, source);
  } catch (error) { throw rethrow(error); }
  finally { wrapping?.fill(0); contentKeyEpoch?.key.fill(0); }
}

function verifyManifest({ manifest: raw, manifestSignature, sourceIdentity: rawSource, expectedContext: rawContext }) {
  try {
    // Checked and signed bytes come from one realm local copy of a manifest
    // that was itself strictly valid; the identity and context likewise.
    const manifest = checkedCopy(raw, validateManifest), sourceIdentity = checkedCopy(rawSource, validateIdentity), expectedContext = snapshot(rawContext);
    if (manifest.source.endpointId !== sourceIdentity.endpointId || !canonical(contextOf(manifest)).equals(canonical(expectedContext))) return false;
    return crypto.verify(null, canonicalManifest(manifest), publicKey(sourceIdentity.signingPublicKey, "ed25519"), decode(manifestSignature, 64, 64));
  } catch { return false; }
}

// `destination` is the opening endpoint. Version 1 opens only on the sealed
// destination. Version 2 opens on any listed computer whose endpoint, key and
// stated grantVersion equal its row; expectedContext stays the signed context.
function openCheckpoint({ checkpoint, expectedContext, sourceIdentity, destination: rawDestination, grantVersion }) {
  let wrapping, key, plaintext;
  try {
    exact(checkpoint, ["manifest", "manifestSignature", "ciphertext"]);
    const destination = endpointCopy(rawDestination);
    const context = snapshot(expectedContext), manifest = checkedCopy(checkpoint.manifest, validateManifest), { manifestSignature, ciphertext } = checkpoint;
    const fingerprint = identityFingerprint(destination.identity);
    if (!verifyManifest({ manifest, manifestSignature, sourceIdentity, expectedContext: context })) throw fail();
    const index = context.version === 2 ? context.recipients.findIndex(row => row.endpointId === destination.identity.endpointId) : -1;
    if (context.version === 1 ? destination.identity.endpointId !== context.destination.endpointId || fingerprint !== context.destination.keyFingerprint ||
          grantVersion !== undefined && grantVersion !== context.destination.grantVersion
        : index < 0 || context.recipients[index].keyFingerprint !== fingerprint || context.recipients[index].grantVersion !== grantVersion) throw fail();
    const bytes = decodeWire(ciphertext);
    if (bytes.length !== manifest.ciphertextBytes || hash(bytes) !== manifest.ciphertextHash) throw fail();
    const packet = JSON.parse(bytes.toString("utf8"));
    let box, label = "";
    if (context.version === 1) {
      exact(packet, ["version", "content", "wrappedKey"]);
      if (packet.version !== 1) throw fail();
      box = exact(packet.wrappedKey, ["ephemeralPublicKey", "salt", "iv", "ciphertext", "tag"]);
    } else {
      exact(packet, ["version", "content", "wrappedKeys"]);
      if (packet.version !== 2) throw fail();
      const boxes = plainList(packet.wrappedKeys, context.recipients.length, context.recipients.length);
      // Every envelope is held to S3's shape, not only the opener's own, so the
      // opener and the journal give one verdict on the same bytes.
      boxes.forEach((value, at) => {
        exact(value, WRAPPED_KEYS);
        if (value.endpointId !== context.recipients[at].endpointId) throw fail();
        ephemeralKey(value.ephemeralPublicKey); decode(value.salt, 32, 32); decode(value.iv, 12, 12); decode(value.ciphertext, 32, 32); decode(value.tag, 16, 16);
      });
      box = boxes[index]; label = `:${box.endpointId}`;
    }
    wrapping = wrappingKey(destination.encryptionPrivateKey, box.ephemeralPublicKey, decode(box.salt, 32, 32), context, `key-derivation${label}`);
    key = decrypt(wrapping, { iv: box.iv, ciphertext: box.ciphertext, tag: box.tag }, aad(context, `wrapped-key${label}`), 32, 32);
    plaintext = decrypt(key, packet.content, aad(context, "content"), MAX_PLAINTEXT_BYTES);
    return { plaintext, contentKeyEpoch: { epoch: manifest.keyEpoch, key } };
  } catch { key?.fill(0); plaintext?.fill(0); throw fail(); }
  finally { wrapping?.fill(0); }
}

// S3's signed statement of the checkpoint formats an endpoint opens:
// exactly [1] or [1,2], with a sequence that only grows.
function formatsOf(value) {
  const formats = plainList(value, 1, 2);
  if (!FORMATS.includes(JSON.stringify(formats))) throw fail();
  return formats;
}
function checkpointFormatsDocument({ endpointId, ownerUserId, pairingId, keyFingerprint, formats, sequence }) {
  if (typeof endpointId !== "string" || !UUID.test(endpointId) || typeof ownerUserId !== "string" || !/^[\x20-\x7e]{1,256}$/.test(ownerUserId) ||
      !(pairingId === null || positive(pairingId)) || typeof keyFingerprint !== "string" || !HASH.test(keyFingerprint) || !positive(sequence)) throw fail();
  return { version: 1, kind: "endpoint-checkpoint-formats", endpointId, ownerUserId, pairingId, keyFingerprint, formats: formatsOf(formats), sequence };
}
function signCheckpointFormats({ endpoint, ownerUserId, pairingId, formats, sequence }) {
  try {
    validateEndpoint(endpoint);
    const document = checkpointFormatsDocument({ endpointId: endpoint.identity.endpointId, ownerUserId, pairingId, keyFingerprint: identityFingerprint(endpoint.identity), formats, sequence });
    return { formats: document.formats, sequence, signature: crypto.sign(null, canonical(document), endpoint.signingPrivateKey).toString("base64url") };
  } catch { throw fail(); }
}
// Checked against the identity the caller pinned, never the server's word.
function verifyCheckpointFormats({ identity, ownerUserId, pairingId, formats, sequence, signature }) {
  try {
    validateIdentity(identity);
    const document = checkpointFormatsDocument({ endpointId: identity.endpointId, ownerUserId, pairingId, keyFingerprint: identityFingerprint(identity), formats, sequence });
    return crypto.verify(null, canonical(document), publicKey(identity.signingPublicKey, "ed25519"), decode(signature, 64, 64));
  } catch { return false; }
}

// One row of S3's GET checkpoint-recipients, as a candidate the sealer judges.
function candidateOf(value) {
  exact(value, CANDIDATE_KEYS);
  if (typeof value.endpointId !== "string" || !UUID.test(value.endpointId) || typeof value.keyFingerprint !== "string" || !HASH.test(value.keyFingerprint) ||
      !positive(value.grantVersion) || typeof value.signingPublicKey !== "string" || typeof value.encryptionPublicKey !== "string" ||
      !(value.sequence === null || positive(value.sequence)) || !(value.signature === null || typeof value.signature === "string") ||
      !["desktop", "agent"].includes(value.kind) || typeof value.ownerUserId !== "string" || !(value.pairingId === null || positive(value.pairingId))) throw fail();
  const identity = Object.freeze({ version: 1, endpointId: value.endpointId, signingPublicKey: value.signingPublicKey, encryptionPublicKey: value.encryptionPublicKey });
  let keysMatch = false;
  try { keysMatch = identityFingerprint(identity) === value.keyFingerprint; } catch { keysMatch = false; }
  return { row: { endpointId: value.endpointId, grantVersion: value.grantVersion, keyFingerprint: value.keyFingerprint }, identity, keysMatch,
    holder: { kind: value.kind, ownerUserId: value.ownerUserId, pairingId: value.pairingId },
    formats: formatsOf(value.formats), statement: { identity, ownerUserId: value.ownerUserId, pairingId: value.pairingId, formats: value.formats, sequence: value.sequence, signature: value.signature } };
}
const tripleKey = row => `${row.endpointId}|${row.keyFingerprint}|${row.grantVersion}`;

// The sealer's rule (S3 spec, "Adding a recipient"): the server's list is a
// candidate list. A computer is a recipient only when the caller has shown it
// ("Added <name>") or the person pinned it, by its exact (endpointId,
// keyFingerprint, grantVersion) in `known`, its published keys hash to that
// fingerprint, and its own signed statement says it opens format 2. The
// destination is judged first, so no version 1 fallback reaches a computer
// nobody was shown. Only an ordinary transfer can be version 2; returns and
// agent retirement stay version 1. `candidates` is every page of the list.
// Only the acting person's (`ownerUserId`) own desktops may hold a version 2
// copy, never an agent runtime, another person's computer or the computer
// sealing it (`sourceEndpointId`). On a transfer, a `known` entry naming one
// of those (by endpoint id, whatever its triple) refuses the whole plan by
// name rather than being left out; a row the server lists but `known` does
// not name is only left out ("not-shown"), and a `known` entry the server
// does not list has no kind or owner to judge and gets nothing. The
// destination keeps S3's own rule per purpose: a return goes only to the
// person's own desktop (refused by name otherwise); a transfer to an agent
// with background use or to the same computer on another runtime, and an
// agent retirement to its own endpoint, stay version 1 to the destination
// alone; another person's computer is never a transfer destination.
// A version 2 plan's `endpoints` is what sealCheckpoint takes as
// recipientEndpoints; a version 1 plan has none.
function planCheckpointRecipients({ purpose, ownerUserId, sourceEndpointId, destination, candidates, known }) {
  try {
    if (!PURPOSES.includes(purpose) || typeof ownerUserId !== "string" || !PLAIN.test(ownerUserId) || typeof sourceEndpointId !== "string" || !UUID.test(sourceEndpointId)) throw fail();
    const target = { ...recipientRow(destination) }, knownRows = plainList(known, 1, 1024).map(row => recipientRow(row));
    const shown = new Set(knownRows.map(tripleKey)), knownIds = new Set(knownRows.map(row => row.endpointId));
    const rows = plainList(candidates, 1, 1024).map(candidateOf).sort((a, b) => a.row.endpointId < b.row.endpointId ? -1 : a.row.endpointId > b.row.endpointId ? 1 : 0);
    for (let index = 1; index < rows.length; index++) if (rows[index - 1].row.endpointId === rows[index].row.endpointId) throw fail();
    const found = rows.find(candidate => candidate.row.endpointId === target.endpointId);
    if (!found || !sameRow(found.row, target) || !found.keysMatch || !shown.has(tripleKey(target))) throw fail();
    const others = rows.filter(candidate => candidate !== found);
    const holderReason = candidate => holderRefusal({ ...candidate.holder, endpointId: candidate.row.endpointId }, ownerUserId, sourceEndpointId);
    // S8: an own desktop's ordinary close (the destination is the closing
    // endpoint itself) is that desktop holding its own copy, not a refusal.
    const ownDestination = holderReason(found);
    const destinationReason = purpose === "transfer" && ownDestination === "source-endpoint" ? null : ownDestination;
    if (purpose === "return" && destinationReason || purpose === "transfer" && destinationReason === "other-owner") throw refuse(destinationReason);
    if (purpose === "transfer") {
      if (target.endpointId !== sourceEndpointId && knownIds.has(sourceEndpointId)) throw refuse("source-endpoint");
      for (const candidate of others) {
        const reason = knownIds.has(candidate.row.endpointId) && holderReason(candidate);
        if (reason) throw refuse(reason);
      }
    }
    const opens2 = candidate => candidate.formats.includes(2) && verifyCheckpointFormats(candidate.statement);
    if (purpose !== "transfer" || destinationReason || !opens2(found)) {
      const reason = purpose !== "transfer" ? "version-1-purpose" : destinationReason ? "destination-not-own-desktop" : "destination-format-1-only";
      return { version: 1, recipients: [], identities: [found.identity], omitted: others.map(candidate => ({ endpointId: candidate.row.endpointId, reason })) };
    }
    const endpointOf = candidate => ({ ...candidate.holder, identity: candidate.identity });
    const chosen = [found], omitted = [];
    for (const candidate of others) {
      const reason = !candidate.keysMatch ? "key-mismatch" : !shown.has(tripleKey(candidate.row)) ? "not-shown" : !candidate.formats.includes(2) ? "format-1-only"
        : !verifyCheckpointFormats(candidate.statement) ? "statement-invalid" : chosen.length >= MAX_CHECKPOINT_RECIPIENTS ? "over-limit" : null;
      if (reason) omitted.push({ endpointId: candidate.row.endpointId, reason }); else chosen.push(candidate);
    }
    chosen.sort((a, b) => a.row.endpointId < b.row.endpointId ? -1 : 1);
    return { version: 2, recipients: chosen.map(candidate => ({ ...candidate.row })), identities: chosen.map(candidate => candidate.identity), endpoints: chosen.map(endpointOf), omitted };
  } catch (error) { throw rethrow(error); }
}

function assertSecureStorage(safeStorage, platform) {
  if (!safeStorage || safeStorage.isEncryptionAvailable?.() !== true ||
      typeof safeStorage.encryptString !== "function" || typeof safeStorage.decryptString !== "function") throw fail();
  const backend = safeStorage.getSelectedStorageBackend?.();
  if (backend === "basic_text" || platform === "linux" && !["gnome_libsecret", "kwallet", "kwallet5", "kwallet6"].includes(backend)) throw fail();
}

// Return only an encrypted record; callers own private-directory/atomic IO.
function protectEndpointKeys({ endpoint, safeStorage, platform = process.platform }) {
  let signing, encryption;
  try {
    assertSecureStorage(safeStorage, platform); validateEndpoint(endpoint);
    signing = endpoint.signingPrivateKey.export({ format: "der", type: "pkcs8" });
    encryption = endpoint.encryptionPrivateKey.export({ format: "der", type: "pkcs8" });
    const body = JSON.stringify({ version: 1, identity: endpoint.identity, signingPrivateKey: signing.toString("base64url"), encryptionPrivateKey: encryption.toString("base64url") });
    const protectedBytes = safeStorage.encryptString(body);
    if (!Buffer.isBuffer(protectedBytes) || !protectedBytes.length || protectedBytes.length > MAX_KEY_RECORD_BYTES) throw fail();
    return { version: 1, identityFingerprint: identityFingerprint(endpoint.identity), ciphertext: protectedBytes.toString("base64url") };
  } catch { throw fail(); }
  finally { signing?.fill(0); encryption?.fill(0); }
}

function restoreEndpointKeys({ record, pinnedIdentity, safeStorage, platform = process.platform }) {
  let signing, encryption;
  try {
    assertSecureStorage(safeStorage, platform); validateIdentity(pinnedIdentity);
    exact(record, ["version", "identityFingerprint", "ciphertext"]);
    if (record.version !== 1 || record.identityFingerprint !== identityFingerprint(pinnedIdentity)) throw fail();
    const body = safeStorage.decryptString(decode(record.ciphertext, MAX_KEY_RECORD_BYTES));
    if (typeof body !== "string" || Buffer.byteLength(body) > MAX_KEY_RECORD_BYTES) throw fail();
    const data = JSON.parse(body);
    exact(data, ["version", "identity", "signingPrivateKey", "encryptionPrivateKey"]);
    if (data.version !== 1 || identityFingerprint(data.identity) !== identityFingerprint(pinnedIdentity)) throw fail();
    signing = decode(data.signingPrivateKey, 48, 48); encryption = decode(data.encryptionPrivateKey, 48, 48);
    const endpoint = { identity: Object.freeze({ ...pinnedIdentity }),
      signingPrivateKey: crypto.createPrivateKey({ key: signing, format: "der", type: "pkcs8" }),
      encryptionPrivateKey: crypto.createPrivateKey({ key: encryption, format: "der", type: "pkcs8" }) };
    return validateEndpoint(endpoint);
  } catch { throw fail(); }
  finally { signing?.fill(0); encryption?.fill(0); }
}

module.exports = { MAX_PLAINTEXT_BYTES, MAX_PACKET_BYTES, MAX_WIRE_BYTES, MAX_CHECKPOINT_RECIPIENTS, createEndpointIdentity, identityFingerprint,
  createContentKeyEpoch, rotateContentKeyEpoch, canonicalManifest, manifestHash, verifyManifest,
  sealCheckpoint, openCheckpoint, checkpointFormatsDocument, signCheckpointFormats, verifyCheckpointFormats, planCheckpointRecipients,
  protectEndpointKeys, restoreEndpointKeys };
