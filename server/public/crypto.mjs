// Experimental pre-shared-key encryption. Not a replacement for MLS.
// Client keys never go to the relay. No member identity or forward secrecy.
export const MAX_WIRE_BYTES = 16 * 1024;
const IV_BYTES = 12;
const MIN_PACKET_BYTES = 1 + IV_BYTES + 16;
const VERSION = 2;
const encoder = new TextEncoder();

export function parseKeyHex(value) {
  if (!/^[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error("Encryption key must have 64 hexadecimal characters");
  }
  return Uint8Array.from(value.match(/../g), pair => Number.parseInt(pair, 16));
}

export async function importRoomKey(hex) {
  return globalThis.crypto.subtle.importKey(
    "raw", parseKeyHex(hex), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]
  );
}

function associatedData(room) {
  if (!/^[0-9a-f]{32}$/.test(room)) throw new Error("Invalid room ID");
  return encoder.encode("pictochat-signed-v2:" + room);
}

export async function encryptPacket(key, room, plaintext) {
  if (!(plaintext instanceof Uint8Array) || plaintext.length === 0 ||
      plaintext.length + MIN_PACKET_BYTES > MAX_WIRE_BYTES) {
    throw new Error("Payload too large or empty");
  }
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = new Uint8Array(await globalThis.crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: associatedData(room), tagLength: 128 },
    key, plaintext
  ));
  const packet = new Uint8Array(1 + IV_BYTES + ciphertext.length);
  packet[0] = VERSION;
  packet.set(iv, 1);
  packet.set(ciphertext, 1 + IV_BYTES);
  return packet;
}

export async function decryptPacket(key, room, input, replayGuard) {
  const packet = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (packet.length < MIN_PACKET_BYTES || packet.length > MAX_WIRE_BYTES ||
      packet[0] !== VERSION) throw new Error("Invalid encrypted packet");
  const iv = packet.slice(1, 1 + IV_BYTES);
  const payload = packet.slice(1 + IV_BYTES);
  // Check duplicates after authentication: corrupted packets must not poison state.
  const plaintext = new Uint8Array(await globalThis.crypto.subtle.decrypt(
    { name: "AES-GCM", iv, additionalData: associatedData(room), tagLength: 128 },
    key, payload
  ));
  if (replayGuard && !replayGuard.accept(iv)) throw new Error("Repeated packet");
  return plaintext;
}

// Best-effort, bounded per-client replay protection for active sessions.
// Not a substitute for per-sender ratchets or persistent replay state.
export class ReplayGuard {
  constructor(limit = 2048) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 8192) {
      throw new Error("Invalid replay window");
    }
    this.limit = limit;
    this.seen = new Set();
  }

  accept(iv) {
    const id = Array.from(iv, byte => byte.toString(16).padStart(2, "0")).join("");
    if (this.seen.has(id)) return false;
    this.seen.add(id);
    if (this.seen.size > this.limit) this.seen.delete(this.seen.values().next().value);
    return true;
  }
}
