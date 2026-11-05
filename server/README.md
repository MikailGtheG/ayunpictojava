# Experimental Rust relay — NOT READY FOR PRIVATE CHAT

This is an isolated, **room-capability-gated prototype with experimental client-side AES-256-GCM**. It is not a replacement for a reviewed secure messenger and must not be deployed publicly.

- Binds only to `127.0.0.1:8787`.
- Serves a **development-only** browser client at `http://127.0.0.1:8787/` with Unicode text, canvas sketches and local print-to-PDF. The browser encrypts outgoing text and strokes with the standard Web Crypto API (AES-256-GCM), using a separate manually shared 256-bit chat key that is never sent to the relay.
- Browser UI uses no third-party assets, stores no chat in localStorage, and adds a strict local-only CSP, no-store cache policy, and no-referrer header. Do not use it for confidential data.
- Accepts only binary envelopes of 29–16384 bytes with version byte `1` (12-byte IV and >=16-byte GCM tag); drops oversized, plaintext-shaped and text messages. This is **structural validation**, not proof that a frame is real ciphertext.
- Room IDs are exactly 32 lowercase hex digits. Each room additionally requires a 256-bit HMAC-SHA256 bearer capability; possession of this token permits joining, but does not prove individual identity.
- At most 256 active rooms. Inactive rooms are reclaimed at the next join.
- Each room accepts at most 16 concurrent WebSocket sessions; over-capacity handshakes receive HTTP 503. Slots are released when a session ends.
- At most 128 concurrent upgraded WebSocket sessions (extra handshakes receive HTTP 503).
- Each connection has a fixed one-second quota of 20 binary messages. Exceeding the quota terminates that connection. This is a basic abuse guard, not fairness across IPs or identities.
- Browser WebSocket origins are restricted to `http://127.0.0.1:8787` and `http://localhost:8787`. Non-browser clients can omit the Origin header, so this is **not authentication**.
- Retains recent frames only in a bounded `tokio::broadcast` buffer while subscribers hold a room. Once all room handles are dropped, the room and its buffer are freed.
- Does not store chats to disk, use a database, or include external service integrations.
- HMAC room capabilities provide basic admission, **not** individual identities or forward secrecy. For honest participants using the browser and an independently shared strong chat key, the relay receives AES-GCM ciphertext rather than text or drawings. However, the server cannot verify that a client actually encrypted its payload, and a hostile participant with the shared key can impersonate others. Browser replay detection is bounded and resets upon reconnect. No per-IP fairness or MLS group-key management yet.

From `server/`, generate an independent 32-byte root secret using `openssl rand -hex 32`, then export it as `PICTOCHAT_RELAY_SECRET` (never commit it). Generate an admission token with `cargo run -- invite 0123456789abcdef0123456789abcdef`. A client connects to `ws://127.0.0.1:8787/ws/<room-id>` with WebSocket subprotocol values `["picto.v1", "auth.<token>"]`; the server echoes only `picto.v1`. Rotate the root secret to revoke all tokens; individual revocation is not yet supported. **Only use test data until E2EE exists.**

Generate a **separate** random 256-bit chat key with `openssl rand -hex 32`; do NOT use the relay root secret or room admission token as the chat key. Start `cargo run` from this directory, visit `http://127.0.0.1:8787/` in two local browser tabs and enter the same room ID, invite token **and separate chat key** in each. Never send the chat key over PictoChat. Send drawings or text; use the print button and select a local PDF printer to export the visible conversation. This manual browser interaction has not been certified by automation; the CI tests cover the underlying two-peer transport and a source check for external resources.

Run `cargo test` and `cargo run` from this directory. Do not expose the development port through a reverse proxy, container network mapping or firewall.

Next gate: specify the authenticated encrypted session protocol and replace broadcast-to-self / replayable delivery semantics with explicit sender identity, membership, and replay protection, then add integration tests before allowing non-loopback binds.
