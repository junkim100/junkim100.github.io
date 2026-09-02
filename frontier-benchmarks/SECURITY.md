# Security notes

## Scope

The Frontier Benchmark Observatory is a static GitHub Pages site. It has no server-side application, authentication, account data, form submission endpoint, database, payment flow, or secret store.

## Controls in this directory

- Each interactive route declares the same route-compatible meta Content Security Policy. It permits local scripts only, has no wildcard source, no `unsafe-eval`, and no inline-script permission. The explicitly scoped Google Fonts style and font hosts support the existing typography, while inline styles remain limited to DOM-managed visual layout properties.
- Query state is parsed from an explicit allowlist. Category, lab, release, and date values are checked against the loaded corpus and its publication window; search text is trimmed and length-bounded. Unknown state is removed while unrelated local fixture parameters are retained.
- Corpus and query-derived display values are created through DOM text APIs, not HTML parsing APIs. Rendered first-party evidence links are rechecked for HTTPS, no userinfo, and the source lab's official-domain allowlist before insertion.
- The compiler applies the same first-party domain rule and requires each canonical source URL to be an absolute HTTPS URL without userinfo before generating JSON or CSV.
- External evidence links use `rel="noopener noreferrer"`.
- Dependabot checks the Python dependency directory weekly. A fresh `pip-audit` is part of this change's verification evidence.

## Deliberate boundaries

SQL injection defenses, AES key management, CAPTCHA, and application-layer rate limiting do not apply because this static site has no SQL database, encryption-key workflow, challenge endpoint, authenticated action, or request-processing application server. This document describes the scoped controls above and does not claim penetration-test coverage, OWASP compliance, or protection against every client, hosting, or supply-chain risk.

## Reporting a concern

Open a private security advisory or contact the repository owner with the affected URL or file path, a minimal reproduction, and the expected versus observed behavior. Do not include credentials, access tokens, or private data in an issue.
