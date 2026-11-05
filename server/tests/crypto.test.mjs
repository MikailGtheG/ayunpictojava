import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import {
  importRoomKey, encryptPacket, decryptPacket, ReplayGuard, MAX_WIRE_BYTES, parseKeyHex
} from "../public/crypto.mjs";

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const ROOM = "0123456789abcdef0123456789abcdef";
const OTHER_ROOM = "ffffffffffffffffffffffffffffffff";
const KEY = "01".repeat(32);
const WRONG_KEY = "02".repeat(32);
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

test("AES-GCM preserves Unicode and does not expose plaintext on the wire", async () => {
  const key = await importRoomKey(KEY);
  assert.equal(key.extractable, false);
  const plain = encoder.encode("Ä Ö Ü ß ğ ı ş 😊 ✏️");
  const packet = await encryptPacket(key, ROOM, plain);
  assert.equal(packet[0], 2);
  assert.ok(packet.length <= MAX_WIRE_BYTES);
  assert.equal(Buffer.from(packet).includes(Buffer.from(plain)), false);
  const restored = await decryptPacket(key, ROOM, packet, new ReplayGuard());
  assert.equal(decoder.decode(restored), "Ä Ö Ü ß ğ ı ş 😊 ✏️");
});

test("wrong key, wrong room, tampering and replay all fail", async () => {
  const key = await importRoomKey(KEY);
  const wrong = await importRoomKey(WRONG_KEY);
  const packet = await encryptPacket(key, ROOM, encoder.encode("hello"));
  await assert.rejects(decryptPacket(wrong, ROOM, packet));
  await assert.rejects(decryptPacket(key, OTHER_ROOM, packet));
  const forged = packet.slice();
  forged[forged.length - 1] ^= 1;
  await assert.rejects(decryptPacket(key, ROOM, forged));
  const replay = new ReplayGuard();
  await decryptPacket(key, ROOM, packet, replay);
  await assert.rejects(decryptPacket(key, ROOM, packet, replay), /Repeated packet/);
});

test("rejects malformed keys, frames and oversized messages", async () => {
  assert.throws(() => parseKeyHex("test"));
  assert.throws(() => parseKeyHex("gg".repeat(32)));
  const key = await importRoomKey(KEY);
  await assert.rejects(encryptPacket(key, ROOM, new Uint8Array(0)));
  await assert.rejects(encryptPacket(key, ROOM, new Uint8Array(MAX_WIRE_BYTES)));
  await assert.rejects(decryptPacket(key, ROOM, new Uint8Array([1, 2])));
  const packet = await encryptPacket(key, ROOM, encoder.encode("test"));
  packet[0] = 9;
  await assert.rejects(decryptPacket(key, ROOM, packet));
});

test("replay guard memory is bounded", () => {
  const guard = new ReplayGuard(2);
  const iv = n => new Uint8Array(12).fill(n);
  assert.ok(guard.accept(iv(1)));
  assert.ok(guard.accept(iv(2)));
  assert.equal(guard.accept(iv(2)), false);
  assert.ok(guard.accept(iv(3)));
  assert.ok(guard.accept(iv(1))); // oldest nonce was evicted
  assert.equal(guard.seen.size, 2);
});
