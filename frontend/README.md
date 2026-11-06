# PictoRust – TypeScript pixel interface

This is a **localhost-only development client**, not a production secure messenger.

## Current implementation

- The actual interactive browser code is authored in `frontend/src/app.ts` and shipped as `server/public/app.mjs`. A CI regression test checks they are identical except for the typed DOM selector. Cryptography and session utilities are separate ES modules.
- `frontend/src/session.ts` is TypeScript source and is also shipped as `server/public/session.mjs`. Both are checked for byte parity in CI.
- **Original UI restored from the main fork.** The client uses the actual repository resources at `src/main/resources/www/images/background.png`, `drawui.png`, `intro_bg.png`, `room_a.png` through `room_e.png`, `logo.png`, `body-bg.png`, and `nds.ttf` at their native **256×384 logical pixel** proportions. The default QWERTY keyboard and SEND/pen tool artwork are provided by the *original* `drawui.png` sprite, with transparent HTML input hitboxes to preserve browser accessibility. A separate optional DE/TR keyboard mode extends Unicode input without repainting the historical QWERTY UI. The original PIXI renderer itself is not yet wired to the encrypted protocol; visually exact per-pixel behavior still needs screenshot comparison and review.
- Unicode works in text messages and in the touch keyboard, including German and Turkish special characters.
- No account, permanent device identity, localStorage, sessionStorage, indexedDB, or server-side chat database. Browser keys and DOM messages are discarded on leaving; this does not guarantee secure memory wiping.
- POST `/new-room` issues a six-hour bearer invitation via the loopback Rust relay. The room ID and token must be shared securely. These authorizations can be reused within their lifetime; a room's in-memory message buffer disappears after all connections end.
- The current browser wire protocol is experimental signed AES-256-GCM v2, **not OpenMLS v3**. OpenMLS is implemented and tested in a separate native Rust client, not yet compiled for or integrated into this browser.

## Checks

The Rust relay CI runs `tsc --project frontend/tsconfig.json`, browser crypto/identity/UI/temporary-room tests, and encrypted two-client WebSocket integration tests. `tsconfig.json` currently uses incremental checking rather than strict mode; broad DOM and crypto helper types must still be refined.

## Original plan – unresolved release gates

1. Integrate MLS crypto into the endpoint, preferably via reviewed Rust/WASM build, without ever sending decryption secrets to the relay. KeyPackage/Welcome/Commit validation and authentic group membership are not yet in the production-facing browser.
2. Authenticate **ephemeral** users per room only; do not add permanent accounts, persistent user IDs or account recovery. Define expiration, revocation and authenticated reconnect.
3. Replace provisional browser code delivery with a verifiable build/release pipeline and TLS before any non-loopback connections.
4. Implement deterministic PDF export tests (including Unicode and drawings), stylus/mobile visual acceptance, keyboard accessibility and final DS design QA.
5. Run threat-model-driven security and performance testing and an independent audit. Never merge until these release criteria are passed.

The project intentionally optimizes for **ephemeral private rooms**, not long-lived social messaging.
