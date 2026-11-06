// A disposable PictoChat session: no account, permanent ID, or server storage.
// This module deliberately contains no network calls or persistence.
export const ROOM_ID_PATTERN = /^[0-9a-f]{32}$/;
export const MAX_NAME_LENGTH = 20;
export const MAX_TEXT_LENGTH = 2000;
export const MAX_STROKE_POINTS = 1200;
export function randomRoomId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}
export function sanitizeNickname(value) {
  if (typeof value !== "string") return "Gast";
  const cleaned = Array.from(value.normalize("NFC"))
    .filter(ch => !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(ch))
    .slice(0, MAX_NAME_LENGTH).join("").trim();
  return cleaned || "Gast";
}
export function emptyDraft() {
  return { v: 1, text: "", strokes: [] };
}
export function validateDraft(data) {
  if (!data || data.v !== 1 || typeof data.text !== "string" ||
      Array.from(data.text).length > MAX_TEXT_LENGTH || !Array.isArray(data.strokes)) return false;
  let points = 0;
  for (const stroke of data.strokes) {
    if (!Array.isArray(stroke)) return false;
    for (const p of stroke) {
      if (++points > MAX_STROKE_POINTS || !Array.isArray(p) || p.length !== 2 ||
          !p.every(Number.isInteger) || p[0] < 0 || p[0] > 512 ||
          p[1] < 0 || p[1] > 170) return false;
    }
  }
  return true;
}
export function ensureEphemeralSession(roomId) {
  if (!ROOM_ID_PATTERN.test(roomId)) throw new Error("Invalid temporary room ID");
  return { roomId, createdAt: Date.now(), persistent: false };
}
