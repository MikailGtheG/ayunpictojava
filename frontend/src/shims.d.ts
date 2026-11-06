// Transitional types for existing Web Crypto helper modules.
// The next migration step converts these helpers to native TypeScript.
declare module "*.mjs" {
  export const importRoomKey: any;
  export const encryptPacket: any;
  export const decryptPacket: any;
  export const ReplayGuard: any;
  export const createSessionIdentity: any;
  export const signMessage: any;
  export const verifyMessage: any;
  export const parseTrustedFingerprints: any;
  export const randomRoomId: any;
  export const sanitizeNickname: any;
  export const validateDraft: any;
  export const preparePictoRustPrint: any;
}
