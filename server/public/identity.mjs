// Experimental per-session device signatures. Public fingerprints must be
// verified outside PictoChat. NOT account authentication or MLS membership.
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const HEX = /^[0-9a-f]{64}$/;
const KEYHEX = /^[0-9a-f]{130}$/; // uncompressed P-256 point, 65 bytes

function hex(bytes) {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}
function unhex(value) {
  if (typeof value !== "string" || value.length % 2 !== 0 ||
      !/^[0-9a-f]*$/.test(value)) throw new Error("Invalid hexadecimal data");
  return Uint8Array.from(value.match(/../g) || [], pair => Number.parseInt(pair, 16));
}
function signingBytes(room, pub, message) {
  if (!/^[0-9a-f]{32}$/.test(room)) throw new Error("Invalid room");
  return encoder.encode(JSON.stringify(["pictochat-session-signature-v1", room, pub, message]));
}
async function fingerprint(publicRaw) {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", publicRaw)));
}
export async function createSessionIdentity() {
  const keys = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]
  );
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey));
  return Object.freeze({
    privateKey: keys.privateKey,
    publicHex: hex(raw),
    fingerprint: await fingerprint(raw)
  });
}
export function parseTrustedFingerprints(text) {
  const entries = text.split(/[\s,;]+/).filter(Boolean).map(x => x.toLowerCase());
  if (entries.length === 0 || entries.length > 16 ||
      entries.some(x => !HEX.test(x))) throw new Error("At least one verified SHA-256 fingerprint is required (max 16)");
  return new Set(entries);
}
export async function signMessage(identity, room, message) {
  if (!identity || !KEYHEX.test(identity.publicHex)) throw new Error("Missing local identity");
  const bytes = signingBytes(room, identity.publicHex, message);
  const signature = new Uint8Array(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" }, identity.privateKey, bytes
  ));
  return { version: 1, pub: identity.publicHex, body: message, sig: hex(signature) };
}
export async function verifyMessage(signed, room, trusted) {
  if (!signed || signed.version !== 1 || !KEYHEX.test(signed.pub) ||
      typeof signed.sig !== "string" || !/^[0-9a-f]{128}$/.test(signed.sig) ||
      !(trusted instanceof Set)) throw new Error("Malformed signed message");
  const raw = unhex(signed.pub);
  if (raw.length !== 65 || raw[0] !== 4) throw new Error("Invalid public key");
  const fp = await fingerprint(raw);
  // Explicit verification: do not silently trust the first received key.
  if (!trusted.has(fp)) throw new Error("Untrusted sender fingerprint");
  const key = await crypto.subtle.importKey(
    "raw", raw, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]
  );
  const ok = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key, unhex(signed.sig), signingBytes(room, signed.pub, signed.body)
  );
  if (!ok) throw new Error("Invalid sender signature");
  return { body: signed.body, fingerprint: fp };
}
