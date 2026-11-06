# PictoRust contribution policy

This is a **maintainer-controlled fork** of
[ayunami2000/ayunpictojava](https://github.com/ayunami2000/ayunpictojava).
Credit upstream work in all releases and keep the original Git history.

## Development authority

Only repository collaborators explicitly granted write/maintain/admin access by
the owner can push branches to this repository. The intended development policy
is to accept changes only from the owner and authorized maintainers.

Unsolicited public pull requests are not part of the supported development
process. The existence of a public repository does not authorize strangers to
push to it, but it does let them submit pull requests or create their own forks.

## Merge gates

- Changes go through pull requests, never unreviewed `master` pushes.
- Review browser screenshots, PDF print raster and real text/drawing flows.
- Require successful Rust relay, legacy, MLS lab and Chromium visual jobs.
- Do not merge experimental browser cryptography as production E2EE.
- Include before/after screenshots, test descriptions and remaining risks.
- No secrets, room tokens, fingerprints or user content in screenshots.

## Recommended GitHub settings (owner must enable)

1. **Settings → Collaborators / Access**: remove any untrusted write members.
2. **Settings → Rules → Rulesets** (or Branches): protect `master`.
   Require pull requests, successful CI checks, code owner reviews when
   applicable, and resolved conversations; block force pushes and deletions.
3. Restrict bypass permissions to the owner. Do not lock the branch if
   normal PR merges must remain possible.
4. **Settings → Actions → General**: review workflow permissions and restrict
   third-party workflow execution to trusted sources.
5. If the source itself must be private, note that public GitHub forks share
   upstream visibility and cannot simply be made private on their own. A
   separate private repository is required, retaining attribution and
   verifying code/asset redistribution rights first.

A CODEOWNERS file is included, but **is not itself access control**. Repository
settings above cannot be asserted as active until confirmed in GitHub.
