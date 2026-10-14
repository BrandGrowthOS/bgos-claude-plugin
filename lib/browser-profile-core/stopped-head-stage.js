"use strict";
const { verify } = require("node:crypto");
const { exactAuthority, sameAuthority, canonical } = require("./coordinator-client");
const { identityFingerprint, verifyManifest, manifestHash } = require("./crypto");
const capabilities = new WeakMap(), fail = () => Object.assign(new Error("profile_stopped_head_stage_refused"), { code: "profile_stopped_head_stage_refused" });
const DOCUMENT_FIELDS = ["version", "kind", "profileId", "actingUserId", "assistantId", "transitionId", "expectedTransitionId", "manifestHash", "expectedRevision", "expectedWriterEpoch", "expectedKeyEpoch", "destination"];
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const equal = (a, b) => canonical(a).equals(canonical(b));
const destinationOf = value => Object.fromEntries(["endpointId", "bootId", "runtimeId", "sessionId", "grantVersion", "keyFingerprint"].map(key => [key, value[key]]));
function current(callback) {
  const value = callback();
  if (value?.then) { void Promise.resolve(value).catch(() => {}); throw fail(); }
  if (value === false) throw fail();
}
function frozen(value) { if (value && typeof value === "object") { for (const item of Object.values(value)) frozen(item); Object.freeze(value); } return value; }

// Main-only, one-use admission for the same enrolled endpoint after a verified
// stopped head was readdressed to this new process. A signed request alone is
// advisory; the caller supplies its freshly acknowledged HOAI response and a
// synchronous owner/epoch capability. Neither is accepted through renderer IPC.
function createStoppedHeadStageAuthorization({ authority: rawAuthority, document, signature, response, checkpoint, sourceIdentity, destination, assertCurrent }) {
  const authority = exactAuthority(rawAuthority);
  if (typeof assertCurrent !== "function") throw fail();
  current(assertCurrent);
  document = frozen(structuredClone(document)); response = frozen(structuredClone(response));
  const profile = response.profile, transition = response.transition, context = response.originalContext, hash = manifestHash(checkpoint?.manifest);
  const target = destinationOf(authority);
  if (!document || Object.keys(document).length !== DOCUMENT_FIELDS.length || DOCUMENT_FIELDS.some(key => !Object.hasOwn(document, key)) || document.version !== 1 || document.kind !== "stopped-head-readdress" ||
      !UUID.test(document.transitionId) || !UUID.test(document.expectedTransitionId) || document.transitionId === document.expectedTransitionId ||
      document.profileId !== authority.profileId || document.actingUserId !== authority.actingUserId || document.assistantId !== authority.assistantId ||
      !equal(document.destination, target) || document.manifestHash !== hash || document.expectedRevision !== authority.revision ||
      document.expectedKeyEpoch !== authority.contentKeyEpoch || document.expectedWriterEpoch + 1 !== authority.writerEpoch ||
      profile?.id !== authority.profileId || profile.actingUserId !== authority.actingUserId || profile.assistantId !== authority.assistantId || profile.writerState !== "stopped" ||
      profile.headManifestHash !== hash || profile.revision !== authority.revision || profile.contentKeyEpoch !== authority.contentKeyEpoch || profile.writerEpoch !== document.expectedWriterEpoch ||
      transition?.id !== document.transitionId || transition.profileId !== authority.profileId || transition.kind !== "stopped_head_readdress" || transition.phase !== "checkpoint_committed" ||
      transition.supersedesTransitionId !== document.expectedTransitionId || transition.capsuleTransitionId !== context?.transitionId || transition.capsuleTransitionId === transition.id || transition.supersededByTransitionId !== null ||
      transition.manifestHash !== hash || transition.sourceRevision + 1 !== authority.revision || transition.contentKeyEpoch !== authority.contentKeyEpoch ||
      !equal(transition.destination, target) || !equal(transition.source, context.source) || transition.sourceManifestHash !== context.previousManifestHash ||
      context.profileId !== authority.profileId || context.actingUserId !== authority.actingUserId || context.assistantId !== authority.assistantId || context.revision !== authority.revision || context.keyEpoch !== authority.contentKeyEpoch ||
      context.source.writerEpoch !== document.expectedWriterEpoch || context.destination.endpointId !== authority.endpointId || context.destination.keyFingerprint !== authority.keyFingerprint || context.destination.grantVersion !== authority.grantVersion ||
      ["endpointId", "bootId", "runtimeId", "sessionId"].some(key => profile[key] !== context.source[key]) ||
      ["bootId", "runtimeId", "sessionId"].some(key => context.destination[key] === target[key]) ||
      destination?.identity?.endpointId !== authority.endpointId || identityFingerprint(destination.identity) !== authority.keyFingerprint ||
      sourceIdentity?.endpointId !== context.source.endpointId || !verifyManifest({ ...checkpoint, sourceIdentity, expectedContext: context }) ||
      typeof signature !== "string" || !/^[A-Za-z0-9_-]{86}$/.test(signature) || !verify(null, canonical(document), { key: Buffer.from(destination.identity.signingPublicKey, "base64url"), type: "spki", format: "der" }, Buffer.from(signature, "base64url"))) throw fail();
  current(assertCurrent);
  const capability = Object.freeze({ kind: "stopped-head-readdress-stage" });
  capabilities.set(capability, { authority, context, hash, sourcePin: identityFingerprint(sourceIdentity), destinationPin: authority.keyFingerprint,
    transitionId: transition.id, assertCurrent, binding: frozen({ document, signature }) });
  return capability;
}
function consumeStoppedHeadStageAuthorization(authorization, { authority, checkpoint, originalContext, sourceIdentity, destination }) {
  const entry = capabilities.get(authorization); if (!entry) throw fail(); capabilities.delete(authorization);
  current(entry.assertCurrent);
  if (!sameAuthority(authority, entry.authority) || !equal(originalContext, entry.context) || manifestHash(checkpoint?.manifest) !== entry.hash ||
      identityFingerprint(sourceIdentity) !== entry.sourcePin || identityFingerprint(destination?.identity) !== entry.destinationPin) throw fail();
  return Object.freeze({ transitionId: entry.transitionId, binding: entry.binding, assertCurrent: () => current(entry.assertCurrent) });
}
module.exports = { createStoppedHeadStageAuthorization, consumeStoppedHeadStageAuthorization };
