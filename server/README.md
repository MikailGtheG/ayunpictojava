# Experimental Rust relay — NOT READY FOR PRIVATE CHAT

This is an isolated, **unauthenticated and unencrypted** transport prototype. It is not a replacement for the Java application and must not be deployed publicly.

- Binds only to `127.0.0.1:8787`.
- Accepts binary messages of 1–16384 bytes, drops oversized and text messages.
- Room IDs are exactly 32 lowercase hex digits. This is **not** access control: knowledge of the ID permits joining.
- At most 256 active rooms. Inactive rooms are reclaimed at the next join.
- Each room accepts at most 16 concurrent WebSocket sessions; over-capacity handshakes receive HTTP 503. Slots are released when a session ends.
- At most 128 concurrent upgraded WebSocket sessions (extra handshakes receive HTTP 503).
- Each connection has a fixed one-second quota of 20 binary messages. Exceeding the quota terminates that connection. This is a basic abuse guard, not fairness across IPs or identities.
- Browser WebSocket origins are restricted to `http://127.0.0.1:8787` and `http://localhost:8787`. Non-browser clients can omit the Origin header, so this is **not authentication**.
- Retains recent frames only in a bounded `tokio::broadcast` buffer while subscribers hold a room. Once all room handles are dropped, the room and its buffer are freed.
- Does not store chats to disk, use a database, or include external service integrations.
- No room membership validation, source authentication, cryptography, per-IP fairness, or end-to-end privacy yet.

Run `cargo test` and `cargo run` from this directory. Do not expose the development port through a reverse proxy, container network mapping or firewall.

Next gate: specify the authenticated encrypted session protocol and replace broadcast-to-self / replayable delivery semantics with explicit sender identity, membership, and replay protection, then add integration tests before allowing non-loopback binds.
