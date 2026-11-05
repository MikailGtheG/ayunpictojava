import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import {
  createSessionIdentity, signMessage, verifyMessage, parseTrustedFingerprints
} from "../public/identity.mjs";

if (!globalThis.crypto) globalThis.crypto = webcrypto;
const ROOM = "0123456789abcdef0123456789abcdef";
const OTHER = "ffffffffffffffffffffffffffffffff";

test("trusted signature authenticates sender message, room and fingerprint", async () => {
  const alice = await createSessionIdentity();
  const bob = await createSessionIdentity();
  assert.notEqual(alice.fingerprint, bob.fingerprint);
  assert.equal(alice.fingerprint.length, 64);
  assert.equal(alice.privateKey.extractable, false);
  const trust = parseTrustedFingerprints(alice.fingerprint);
  const body = { v: 1, text: "ÄÖÜ ß ğışç 😊", strokes: [[[3, 4], [7, 8]]] };
  const signed = await signMessage(alice, ROOM, body);
  assert.equal(signed.sig.length, 128);
  const result = await verifyMessage(signed, ROOM, trust);
  assert.deepEqual(result.body, body);
  assert.equal(result.fingerprint, alice.fingerprint);
  await assert.rejects(verifyMessage(signed, ROOM, parseTrustedFingerprints(bob.fingerprint)), /Untrusted/);
  await assert.rejects(verifyMessage(signed, OTHER, trust), /signature/);
});

test("tampered message, forged signature and sender swap are rejected", async () => {
  const alice = await createSessionIdentity();
  const bob = await createSessionIdentity();
  const trust = parseTrustedFingerprints(alice.fingerprint + ", " + bob.fingerprint);
  const original = await signMessage(alice, ROOM, { text: "safe" });
  await assert.rejects(verifyMessage({ ...original, body: { text: "modified" } }, ROOM, trust));
  await assert.rejects(verifyMessage({ ...original, pub: bob.publicHex }, ROOM, trust));
  await assert.rejects(verifyMessage({ ...original, sig: "00".repeat(64) }, ROOM, trust));
});

test("deny unknown and malformed fingerprints; never auto-trust", async () => {
  assert.throws(() => parseTrustedFingerprints(""));
  assert.throws(() => parseTrustedFingerprints("gg".repeat(32)));
  assert.throws(() => parseTrustedFingerprints("a".repeat(64) + " " + "b".repeat(63)));
  const alice = await createSessionIdentity();
  const signed = await signMessage(alice, ROOM, { text: "test" });
  await assert.rejects(verifyMessage(signed, ROOM, new Set()), /Untrusted/);
  await assert.rejects(verifyMessage({ ...signed, sig: "abcd" }, ROOM, new Set()));
});
