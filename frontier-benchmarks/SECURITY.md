# Security notes

## Scope

The Frontier Benchmark Observatory is a static GitHub Pages site. It has no server-side application, authentication, account data, form submission endpoint, database, payment flow, or secret store.

## Controls in this directory

- Each route declares a local-only meta Content Security Policy. Scripts, styles, fonts, images, and data requests are restricted to the site origin, with inline style permission limited to layout properties applied by the timeline renderer.
- Query state is parsed from an explicit allowlist. Category, lab, benchmark, release, zoom, page size, sort, direction, and date values are checked against finite choices or the loaded corpus. Search text is trimmed and length-bounded.
- Corpus and query-derived display values are created through DOM text APIs, not HTML parsing APIs.
- First-party Source links are rechecked before rendering. Each link must use HTTPS without user information and match the source lab's official-domain allowlist.
- External Source links use `rel="noopener noreferrer"`.
- The compiler applies the same first-party domain rule before producing the generated artifact.

## Deliberate boundaries

SQL injection defenses, encryption-key management, CAPTCHA, and application-layer rate limiting do not apply because this static site has no SQL database, key workflow, challenge endpoint, authenticated action, or request-processing application server. This document describes the scoped controls above and does not claim penetration-test coverage, OWASP compliance, or protection against every client, hosting, or supply-chain risk.

## Reporting a concern

Open a private security advisory or contact the repository owner with the affected URL or file path, a minimal reproduction, and the expected versus observed behavior. Do not include credentials, access tokens, or private data in an issue.
