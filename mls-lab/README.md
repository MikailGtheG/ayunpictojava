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

Run locally using `cargo test` in `mls-lab/`. The dedicated GitHub workflow exercises this crate independently from Java and the existing Rust relay.

## Separation and security limits

**No changes to the current browser's cryptography have been made by this MLS laboratory.** The browser still uses experimental AES-256-GCM with an independently shared key plus ephemeral P-256 signatures; it does **not** negotiate MLS epochs. The current relay still expects the signed-envelope v2 format, not MLS messages.

Production prerequisites:

1. Pick the actual **client** MLS implementation (the secrecy boundary must stay on the endpoint). Rust native, WASM and JS interop must be assessed rather than putting MLS decryption keys into the relay.
2. Define exact validated key-package publication, fingerprint/credential authentication, Welcome/Commit delivery and group epoch synchronization.
3. Because the app intentionally avoids server-side message retention, decide how an offline member obtains missed commits and how the client recovers from a stale epoch without persisting chat content. An optional, explicitly bounded encrypted control-message mailbox may be necessary, or reconnecting clients may have to rejoin.
4. Handle conflicts, member removal/revocation, malicious administrators, key-package replay and account recovery.
5. Commit `Cargo.lock`, pin transitive dependencies, add dependency and security auditing, stronger adversarial tests, and a protected release process.
6. Independently security-review all code before claiming secure private communication.

A passing MLS unit test establishes this narrow proof only, **not end-to-end security of the shipping browser application**.
