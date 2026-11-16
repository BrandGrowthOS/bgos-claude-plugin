"use strict";
// The sealed sign-in copies' wire: one POST to send, one signed POST to read. A
// person's computer speaks with its bearer, a machine with its pairing. Bytes in
// a copy are sealed before they reach here, and nothing here logs a body.
// Main or daemon only. No em or en dashes.
const crypto = require("node:crypto");
const { canonical } = require("./coordinator-client");
const { identityFingerprint } = require("./crypto");

const fail = (code = "profile_sign_in_copy_request_refused", statusCode) => Object.assign(new Error(code), { code, statusCode });
const MAX_RESPONSE_BYTES = 200 * 1024 * 1024;

class SignInCopyClient {
  /** `headers()` answers the credential headers for the principal, fresh per request. */
  constructor({ endpoint, headers, fetchImpl = globalThis.fetch, timeoutMs = 60_000 }) {
    const url = new URL(endpoint);
    if (url.username || url.password || url.search || url.hash || !(url.protocol === "https:" || (url.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname))) || typeof headers !== "function" || typeof fetchImpl !== "function") throw TypeError("profile_sign_in_copy_client_invalid");
    Object.assign(this, { origin: url.origin, headers, fetchImpl, timeoutMs });
  }
  async _post(route, body) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(new URL(`/api/v1/browser/profile-sync/${route}`, this.origin).href, {
        method: "POST", redirect: "error", signal: controller.signal, body: JSON.stringify(body),
        headers: { ...(await this.headers()), "Content-Type": "application/json", Accept: "application/json", "Accept-Encoding": "identity" },
      });
      const text = await response.text();
      if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw fail();
      if (response.status < 200 || response.status >= 300) throw fail("profile_sign_in_copy_request_refused", response.status);
      return JSON.parse(text);
    } finally { clearTimeout(timer); }
  }
  upload(profileId, copy, sites) { return this._post(`profiles/${profileId}/sign-in-copies`, { copy, sites }); }
  /** Reads the copies addressed to this endpoint. `consumeThrough`: a computer that took a copy back drops it and older. */
  read({ scope, endpoint, grantVersion, consumeThrough = null }) {
    const document = {
      version: 1, kind: "sign-in-copy-read", requestId: crypto.randomUUID(), profileId: scope.profileId, actingUserId: scope.actingUserId, assistantId: scope.assistantId,
      endpointId: endpoint.identity.endpointId, keyFingerprint: identityFingerprint(endpoint.identity), grantVersion, expiresAt: Date.now() + 30_000, consumeThrough,
    };
    const signature = crypto.sign(null, canonical(document), endpoint.signingPrivateKey).toString("base64url");
    return this._post(`profiles/${scope.profileId}/sign-in-copies/read`, { ...document, signature });
  }
}

/** The last copy a computer took back, per profile: numbers, in a private file. Only ever goes up. */
class SignInSequenceFile {
  constructor(file, fs = require("node:fs")) { Object.assign(this, { file, fs }); }
  _all() { try { const value = JSON.parse(this.fs.readFileSync(this.file, "utf8")); return value && typeof value === "object" ? value : {}; } catch { return {}; } }
  read(profileId) { const value = this._all()[profileId]; return Number.isSafeInteger(value) && value > 0 ? value : 0; }
  write(profileId, sequence) {
    const all = this._all();
    if (!Number.isSafeInteger(sequence) || sequence <= (all[profileId] ?? 0)) return;
    all[profileId] = sequence;
    const temporary = `${this.file}.${process.pid}.tmp`;
    this.fs.writeFileSync(temporary, JSON.stringify(all), { mode: 0o600 });
    this.fs.renameSync(temporary, this.file);
  }
}

module.exports = { SignInCopyClient, SignInSequenceFile };
