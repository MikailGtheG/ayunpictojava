# Milestone: Signed, fingerprint-pinned device sessions

Status: **experimental; not released or MLS-compatible**.

The browser generates a fresh P-256 ECDSA keypair when the page loads. The private signing key is non-extractable and stays in browser memory. The SHA-256 fingerprint of the raw public key is displayed. The user must compare this fingerprint **outside of PictoChat** and manually enter each permitted partner's 64-hex-digit fingerprint. There is **no** automatic trust-on-first-use.

Outgoing text and drawings are signed with the session key, binding the message and room ID, and the signed envelope is then encrypted using the existing AES-256-GCM shared room key. Recipients first decrypt and then verify the signature and fingerprint before rendering the message. Unknown signatures, modified content, swapped public keys, and cross-room signatures fail validation. The Rust relay continues to forward opaque encrypted packets.

**Limitations and threat model:** Keypairs currently expire on page reload. Fingerprints must be reverified for each new session; a copied display name alone proves nothing. This supplies explicit session-key continuity within the current page, **not** durable account identity or authentication to an organization. The same server serves browser JavaScript, so a malicious server that changes the delivered code can still compromise keys. Replay protection is bounded and disappears on reconnect. Shared AES keys do not provide forward secrecy, independently revocable membership, post-compromise security, or MLS group epochs. The application is not approved for confidential communication.

Before production release: retain deliberately **ephemeral, per-session** identities only; authenticate them within a room via verified invitations and MLS membership. Implement membership revocation and safe fresh rejoining (not persistent account recovery), audited MLS-based membership and key lifecycle, TLS and verifiable client delivery, stronger replay protection, and independent security assessment. Permanent accounts or device identities are explicitly out of scope. Leave PR #1 as a draft until these release gates are met.
