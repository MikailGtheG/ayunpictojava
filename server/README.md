# Experimental Rust relay — NOT READY FOR PRIVATE CHAT

This is an isolated, **room-capability-gated but unencrypted** transport prototype. It is not a replacement for the Java application and must not be deployed publicly.

- Binds only to `127.0.0.1:8787`.
- Accepts binary messages of 1–16384 bytes, drops oversized and text messages.
- Room IDs are exactly 32 lowercase hex digits. Each room additionally requires a 256-bit HMAC-SHA256 bearer capability; possession of this token permits joining, but does not prove individual identity.
- At most 256 active rooms. Inactive rooms are reclaimed at the next join.
- Each room accepts at most 16 concurrent WebSocket sessions; over-capacity handshakes receive HTTP 503. Slots are released when a session ends.
- At most 128 concurrent upgraded WebSocket sessions (extra handshakes receive HTTP 503).
- Each connection has a fixed one-second quota of 20 binary messages. Exceeding the quota terminates that connection. This is a basic abuse guard, not fairness across IPs or identities.
- Browser WebSocket origins are restricted to `http://127.0.0.1:8787` and `http://localhost:8787`. Non-browser clients can omit the Origin header, so this is **not authentication**.
- Retains recent frames only in a bounded `tokio::broadcast` buffer while subscribers hold a room. Once all room handles are dropped, the room and its buffer are freed.
- Does not store chats to disk, use a database, or include external service integrations.
- HMAC room capabilities provide basic admission, **not** individual identities, forward secrecy, or end-to-end privacy. The relay knows all room capabilities and can read all payloads. No per-IP fairness or replay protection yet.

From `server/`, generate an independent 32-byte root secret using `openssl rand -hex 32`, then export it as `PICTOCHAT_RELAY_SECRET` (never commit it). Generate an admission token with `cargo run -- invite 0123456789abcdef0123456789abcdef`. A client connects to `ws://127.0.0.1:8787/ws/<room-id>` with WebSocket subprotocol values `["picto.v1", "auth.<token>"]`; the server echoes only `picto.v1`. Rotate the root secret to revoke all tokens; individual revocation is not yet supported. **Only use test data until E2EE exists.**

Run `cargo test` and `cargo run` from this directory. Do not expose the development port through a reverse proxy, container network mapping or firewall.

Next gate: specify the authenticated encrypted session protocol and replace broadcast-to-self / replayable delivery semantics with explicit sender identity, membership, and replay protection, then add integration tests before allowing non-loopback binds.
