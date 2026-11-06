# OpenMLS group-key lifecycle laboratory (isolated)

This is **not the PictoChat production cryptography stack**. It is a separate Rust crate proving an MLS library can manage multi-device group membership without inventing new cryptographic ratchets.

## Demonstration

- OpenMLS `0.9.2`, `openmls_rust_crypto 0.6.0`, and `openmls_basic_credential 0.6.0`.
- Different provider instances model separate end-user key stores.
- A first member creates a group; a second member publishes a KeyPackage.
- The first member sends a Welcome after an Add commit.
- The second member processes Welcome and obtains the same group epoch.
- A text/sketch-like UTF-8 message is MLS-encrypted by the first member, authenticated and decrypted by the second member.
- The first member removes the second via an MLS commit, advancing the group's epoch.
- After applying the removal, the evicted member's group becomes inactive; creating a new group message is rejected.

The same test crate now has **two separate integration tiers**:
- `tests/relay_integration.rs` sends real MLS Welcome, application, and removal-Commit bytes through `pictochat_relay::Rooms`, the exact in-memory broadcast mechanism used by our Rust WebSocket server.
- `tests/websocket.rs` connects two true WebSocket peers to the loopback server. It transmits actual OpenMLS-produced Welcome, application ciphertext, and removal Commit messages, and verifies the removed device loses the ability to send. This test is ignored during ordinary `cargo test` and explicitly executed by the MLS GitHub Actions workflow after starting the relay.

Run `cargo test` in `mls-lab/`. For the live WebSocket integration, start the server with `PICTOCHAT_RELAY_SECRET` and run `cargo test --test websocket -- --ignored` in the lab. Only use local, non-sensitive development data.

## Separation and security limits

**No changes to the current browser's cryptography have been made by this MLS laboratory.** The browser still uses experimental AES-256-GCM with an independently shared key plus ephemeral P-256 signatures; it does **not** negotiate MLS epochs. The relay now **also** accepts the opaque MLS transport framing v3, while leaving browser protocol v2 untouched. It does not parse or validate OpenMLS protocol contents. This is a transport test, not a deployed browser MLS client.

Production prerequisites:

1. Pick the actual **client** MLS implementation (the secrecy boundary must stay on the endpoint). Rust native, WASM and JS interop must be assessed rather than putting MLS decryption keys into the relay.
2. Define exact validated key-package publication, fingerprint/credential authentication, Welcome/Commit delivery and group epoch synchronization.
3. Because the app intentionally avoids server-side message retention, decide how an offline member obtains missed commits and how the client recovers from a stale epoch without persisting chat content. An optional, explicitly bounded encrypted control-message mailbox may be necessary, or reconnecting clients may have to rejoin.
4. Handle conflicts, member removal/revocation, malicious administrators, key-package replay and account recovery.
5. Commit `Cargo.lock`, pin transitive dependencies, add dependency and security auditing, stronger adversarial tests, and a protected release process.
6. Independently security-review all code before claiming secure private communication.

## MLS transport v3 (experimental)

A WebSocket binary frame has one version byte `0x03`, followed by a one-byte kind and the unchanged TLS-serialized MLS payload:

| Kind | Meaning |
| --- | --- |
| `0x01` | MLS application message |
| `0x02` | MLS membership Commit |
| `0x03` | MLS Welcome |
| `0x04` | MLS KeyPackage |

The relay only enforces an allowed kind and total 3–16384 bytes; there is **no** authenticated MLS group routing or verified membership in the server. All messages still broadcast to currently connected holders of the bearer room capability. MLS validation and secret handling **must** remain on client devices. KeyPackage discovery, specific Welcome targeting, offline recovery, ordering, and durable group identities are not implemented. The v2 browser is not upgraded and may ignore v3 messages.

A passing MLS test proves only these specific integration flows, **not end-to-end security of the shipping browser application**.
