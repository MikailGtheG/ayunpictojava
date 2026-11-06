# PictoChat modernization: security and architecture plan

## Current state (NOT a secure messenger)
This legacy Java server handles plaintext chat messages. Some optional external integrations can access messages, and the browser stores user preferences. The Unicode fixes in this branch do **not** establish end-to-end encryption. Do not advertise this implementation as confidential.

## Target properties
- Self-hostable single-origin application; no external assets, telemetry, CAPTCHA, bots, or content moderation APIs.
- End-to-end encrypted text **and** drawing payloads; authenticated participants and authenticated room membership.
- Forward secrecy / post-compromise security subject to independently reviewed group messaging protocol (evaluate MLS/OpenMLS; do not invent custom encryption).
- No server-side history database, messages in volatile memory only for active delivery, and explicit TTLs for pending frames.
- No content logs or third-party request forwarding. Document residual metadata, backups, proxies, crash dumps, browser caches and client screenshots.
- Optional, explicitly user-initiated client-side PDF export; exported files remain user-owned and are inherently persistent.
- Unicode-first keyboard and drawing interface; Unicode font fallback must be tested visually.

## Proposed component boundaries
- `frontend/`: TypeScript UI, canvas strokes, typed protocol schema, client-side crypto and PDF export.
- `server/`: Rust/Tokio/Axum relay, limits, rooms and transport. Server cannot access room plaintext once E2EE is implemented.
- `protocol/`: versioned, length-delimited message schema, membership/key lifecycle and replay protection.
- `tests/`: browser integration, multi-party crypto lifecycle, load/property/fuzz tests and no-persistence assertions.
- `legacy/`: original Java implementation retained temporarily for comparison; no compatibility downgrade to plaintext.

## Required release gates
1. Working Unicode and drawings on desktop, mobile and touchscreen.
2. Comprehensive room membership and ciphertext-forwarding tests.
3. Verify server has no message content logging, persistence or access to decryption keys.
4. Adversarial tests for replay, spoofed room joining, cross-origin websocket requests, malformed frames and flooding.
5. Browser-generated PDF preserves Unicode and drawings without contacting the relay or third-party service.
6. Independent security review; threat model and limitations documented.

## Non-goals / explicit warnings
- A malicious or compromised participant can still copy, photograph or export content.
- E2EE does not hide IP addresses, connection timing or room participation from the relay.
- No-storage is not the same as zero RAM copies; memory erasure cannot be guaranteed in a managed browser.
- Client-side PDF export intentionally creates a user-controlled persistent record.
