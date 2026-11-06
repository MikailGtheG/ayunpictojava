// End-to-end transport integration: REAL WebSocket clients through the Rust process.
// Uses Node's browser-compatible WebSocket and the exact browser crypto module.
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, webcrypto } from "node:crypto";
import { importRoomKey, encryptPacket, decryptPacket, ReplayGuard } from "../public/crypto.mjs";
import { createSessionIdentity, signMessage, verifyMessage, parseTrustedFingerprints } from "../public/identity.mjs";

if (!globalThis.crypto) globalThis.crypto = webcrypto;
const ROOT = process.env.PICTOCHAT_RELAY_SECRET;
if (!ROOT || !/^[0-9a-fA-F]{64}$/.test(ROOT)) {
  throw new Error("Set PICTOCHAT_RELAY_SECRET to a 32-byte hexadecimal test secret");
}
const ROOM_A = "0123456789abcdef0123456789abcdef";
const ROOM_B = "ffffffffffffffffffffffffffffffff";
const KEY = "01".repeat(32);
const WRONG_KEY = "02".repeat(32);
const HOST = "ws://127.0.0.1:8787";
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function admission(room) {
  return createHmac("sha256", Buffer.from(ROOT, "hex"))
    .update("pictochat-room-capability-v1:")
    .update(room)
    .digest("hex");
}
function openSocket(room, token) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(HOST + "/ws/" + room, ["picto.v1", "auth." + token]);
    socket.binaryType = "arraybuffer";
    const timer = setTimeout(() => { socket.close(); reject(new Error("WebSocket connection timed out")); }, 4000);
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      assert.equal(socket.protocol, "picto.v1");
      resolve(socket);
    }, { once: true });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("WebSocket handshake rejected"));
    }, { once: true });
  });
}
function nextBinary(socket) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error("No WebSocket packet received")); }, 4000);
    const cleanup = () => { clearTimeout(timer); socket.removeEventListener("message", onMessage); socket.removeEventListener("close", onClose); };
    const onMessage = event => { cleanup(); resolve(new Uint8Array(event.data)); };
    const onClose = () => { cleanup(); reject(new Error("Closed before packet arrived")); };
    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", onClose);
  });
}
async function mustReject(room, token) {
  await assert.rejects(openSocket(room, token), /WebSocket handshake rejected/);
}

test("wrong admission token never opens a WebSocket", async () => {
  await mustReject(ROOM_A, "00".repeat(32));
  await mustReject(ROOM_A, admission(ROOM_B));
});

test("encrypted Unicode text and sketch cross Rust relay without plaintext", async () => {
  const connections = [];
  try {
    const alice = await openSocket(ROOM_A, admission(ROOM_A));
    connections.push(alice);
    const bob = await openSocket(ROOM_A, admission(ROOM_A));
    connections.push(bob);
    const rootKey = await importRoomKey(KEY);
    const message = {
      v: 1,
      text: "Hallo ÄÖÜ ß – Merhaba ğışç 😊",
      strokes: [[[10,20],[11,22],[15,30]]]
    };
    const aliceIdentity = await createSessionIdentity();
    const trusted = parseTrustedFingerprints(aliceIdentity.fingerprint);
    const signed = await signMessage(aliceIdentity, ROOM_A, message);
    const plaintext = encoder.encode(JSON.stringify(signed));
    const ciphertext = await encryptPacket(rootKey, ROOM_A, plaintext);
    assert.equal(ciphertext[0], 2);
    assert.equal(Buffer.from(ciphertext).includes(Buffer.from(plaintext)), false);

    const pending = nextBinary(bob);
    alice.send(ciphertext);
    const onWire = await pending;
    assert.deepEqual(onWire, ciphertext);
    assert.equal(Buffer.from(onWire).includes(Buffer.from(plaintext)), false);

    const wrong = await importRoomKey(WRONG_KEY);
    await assert.rejects(decryptPacket(wrong, ROOM_A, onWire));
    const guard = new ReplayGuard();
    const restored = await decryptPacket(rootKey, ROOM_A, onWire, guard);
    const receivedSigned = JSON.parse(decoder.decode(restored));
    assert.deepEqual((await verifyMessage(receivedSigned, ROOM_A, trusted)).body, message);
    await assert.rejects(decryptPacket(rootKey, ROOM_A, onWire, guard), /Repeated packet/);
  } finally {
    for (const socket of connections) socket.close();
  }
});

test("room A cannot decrypt the authenticated ciphertext from room B", async () => {
  const key = await importRoomKey(KEY);
  const packet = await encryptPacket(key, ROOM_A, encoder.encode("room A only"));
  await assert.rejects(decryptPacket(key, ROOM_B, packet));
});

test("shared chat key alone cannot impersonate a pinned device", async () => {
  const connections = [];
  try {
    const attackerSocket = await openSocket(ROOM_A, admission(ROOM_A));
    connections.push(attackerSocket);
    const receiverSocket = await openSocket(ROOM_A, admission(ROOM_A));
    connections.push(receiverSocket);
    const pinned = await createSessionIdentity();
    const attacker = await createSessionIdentity();
    const trusted = parseTrustedFingerprints(pinned.fingerprint);
    const groupKey = await importRoomKey(KEY);
    const impersonated = await signMessage(attacker, ROOM_A, {
      v: 1, text: "I claim to be your trusted device", strokes: []
    });
    const packet = await encryptPacket(groupKey, ROOM_A, encoder.encode(JSON.stringify(impersonated)));
    const incoming = nextBinary(receiverSocket);
    attackerSocket.send(packet);
    const received = await incoming;
    const clear = JSON.parse(decoder.decode(await decryptPacket(groupKey, ROOM_A, received)));
    await assert.rejects(verifyMessage(clear, ROOM_A, trusted), /Untrusted sender fingerprint/);
  } finally {
    for (const socket of connections) socket.close();
  }
});

test("legacy plaintext packets cause the sending WebSocket to close", async () => {
  const alice = await openSocket(ROOM_A, admission(ROOM_A));
  try {
    const closed = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Plaintext socket was not closed")), 4000);
      alice.addEventListener("close", () => { clearTimeout(timer); resolve(); }, { once: true });
    });
    alice.send(JSON.stringify({ v: 1, text: "unprotected", strokes: [] }));
    await closed;
  } finally {
    alice.close();
  }
});

test("cross-room ciphertext cannot be decrypted with the same key in another room", async () => {
  const connections = [];
  try {
    const sender = await openSocket(ROOM_B, admission(ROOM_B));
    connections.push(sender);
    const recipient = await openSocket(ROOM_B, admission(ROOM_B));
    connections.push(recipient);
    const key = await importRoomKey(KEY);
    const packet = await encryptPacket(key, ROOM_B, encoder.encode("Only room B"));
    const incoming = nextBinary(recipient);
    sender.send(packet);
    const received = await incoming;
    assert.equal(decoder.decode(await decryptPacket(key, ROOM_B, received)), "Only room B");
    await assert.rejects(decryptPacket(key, ROOM_A, received));
  } finally {
    for (const socket of connections) socket.close();
  }
});

test("opaque MLS v3 control frames route intact; malformed kinds close sender", async () => {
  const connections = [];
  try {
    const sender = await openSocket(ROOM_A, admission(ROOM_A));
    connections.push(sender);
    const peer = await openSocket(ROOM_A, admission(ROOM_A));
    connections.push(peer);
    for (const kind of [1, 2, 3, 4]) {
      const payload = Uint8Array.from([3, kind, 0x7f, 0x01, 0x45, 0xfa]);
      const incoming = nextBinary(peer);
      sender.send(payload);
      const got = await incoming;
      assert.deepEqual(got, payload, "Relay must not parse, rewrite or decrypt MLS payload");
    }
    const closed = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Invalid MLS kind not rejected")), 4000);
      sender.addEventListener("close", () => { clearTimeout(timer); resolve(); }, { once: true });
    });
    sender.send(Uint8Array.from([3, 0, 99]));
    await closed;
  } finally {
    for (const socket of connections) socket.close();
  }
});

test("stateless temporary room API issues a usable admission token",async()=>{
 const response=await fetch("http://127.0.0.1:8787/new-room",{method:"POST"});
 assert.equal(response.status,200);
 assert.equal(response.headers.get("cache-control"),"no-store");
 const invitation=await response.json();
 assert.match(invitation.roomId,/^ee[0-9a-f]{30}$/);
 assert.match(invitation.token,/^[0-9a-f]{64}$/);
 assert.ok(invitation.expiresAt>Math.floor(Date.now()/1000));
 const ws=await openSocket(invitation.roomId,invitation.token);
 assert.equal(ws.readyState,WebSocket.OPEN);
 ws.close();
 await mustReject(invitation.roomId,"00".repeat(32));
});

test("first packet is delivered immediately after subscriber handshake", async () => {
  // Each iteration reproduces the former race between HTTP 101 and room.subscribe().
  for (let i = 0; i < 8; i++) {
    const sender = await openSocket(ROOM_A, admission(ROOM_A));
    const receiver = await openSocket(ROOM_A, admission(ROOM_A));
    try {
      const frame = Uint8Array.from([3, 1, i + 1]);
      const delivery = nextBinary(receiver);
      sender.send(frame); // No artificial delay; delivery must work right after upgrade.
      const received = await delivery;
      assert.deepEqual(received, frame);
    } finally {
      await Promise.all([sender, receiver].map(socket => new Promise(resolve => {
        if (socket.readyState === WebSocket.CLOSED) return resolve();
        socket.addEventListener("close", resolve, { once: true });
        socket.close();
      })));
    }
  }
});
