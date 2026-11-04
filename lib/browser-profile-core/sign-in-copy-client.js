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
  /** Reads the copies addressed to this endpoint. `consume` is one shot: a computer taking a copy back. */
  read({ scope, endpoint, grantVersion, consume = false }) {
    const document = {
      version: 1, kind: "sign-in-copy-read", requestId: crypto.randomUUID(), profileId: scope.profileId, actingUserId: scope.actingUserId, assistantId: scope.assistantId,
      endpointId: endpoint.identity.endpointId, keyFingerprint: identityFingerprint(endpoint.identity), grantVersion, expiresAt: Date.now() + 30_000, consume,
    };
    const signature = crypto.sign(null, canonical(document), endpoint.signingPrivateKey).toString("base64url");
    return this._post(`profiles/${scope.profileId}/sign-in-copies/read`, { ...document, signature });
  }
}

module.exports = { SignInCopyClient };
