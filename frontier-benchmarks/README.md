# Frontier Benchmark Observatory

This directory contains the static, score-free Observatory and its reviewable data contract.

## Canonical inputs

- `data/catalog.yaml` holds labs, lineages, models, release candidates, releases, benchmarks, sources, occurrences, coverage, and quarantine records.
- `data/definitions.yaml` holds the reporting-status definitions consumed by compilation.
- `data/audit-overlay.json` preserves scoped dispositions and unresolved limitations from the reconciled audit, keyed to ledger and catalog identities. It is not blanket semantic approval.
- `schema/*.schema.json` contains the JSON Schema draft 2020-12 contracts applied to the parsed YAML documents.

Derived reporting statuses never appear in canonical source data. `scripts/compile.py` validates both inputs, computes lineage-scoped statuses, and writes one deterministic UTF-8 generated artifact.

## Reproduce

From this directory, with a currently supported Python 3 release:

```sh
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python scripts/compile.py --check
.venv/bin/python -m unittest discover -s tests -v
node tests/ui/test-ui.mjs
node tests/ui/test-data-routes.mjs
node tests/ui/test-workspace-core.mjs
node tests/ui/test-workspace-chronology.mjs
node tests/ui/test-workspace-routes.mjs
node tests/ui/test-workspace-geometry.mjs
node --check core.mjs
node --check trends.mjs
node --check timeline.mjs
node --check data-routes.mjs
node --check shell.mjs
```

The compiler emits `public/observatory.json` deterministically from the canonical inputs. `--check` verifies the committed artifact without rewriting it, and the Python suite includes a byte-for-byte double-build check.

`tests/ui/test-timeline-geometry.mjs` launches local Chrome and is not authorized for this cloud-only verification workflow. Replay applicable rendered geometry assertions in the authorized isolated cloud browser rather than running that script locally.

`test-workspace-geometry.mjs` is a pure synthetic-coordinate regression and launches no browser. It does not establish actual rendered focus, layout, touch behavior, or visual chronology preservation.

## Static interface

- `index.html` is the Benchmarks workspace with canonical discovery, one-to-six benchmark selection, reporting-date lanes, and occurrence evidence.
- `timeline.html` is the Releases chronology with release-date positioning and pinned release detail.
- `ledger.html` is the complete release ledger with retained and withheld occurrence counts.
- `history.html` is reporting history with canonical OR filters, an explicit historical/withheld identity audit mode, coverage disclosures, and occurrence evidence.
- `about.html` retains useful static interpretation boundaries and loads generated audit limitations and all reporting definitions.
- `definitions.html` is a JavaScript compatibility document that maps known status links to stable About fragments and retains a manual fallback.

`core.mjs` owns canonical identity mapping, retained-occurrence policy, source destination validation, source disclosure, v2 route state, route transfer, history payloads, and cancelable search. `trends.mjs`, `timeline.mjs`, and `data-routes.mjs` consume those shared contracts. `shell.mjs` owns storage-tolerant theme behavior, common-only header route transfer, landing compatibility, scope-change announcements, Definitions compatibility, and generated About content.

All interactive routes fetch `public/observatory.json`; no public fixture query selects alternate data. CSP, score-free rendering, exact stored source destinations, and explicit coverage uncertainty remain part of the interface contract.

## Durable view state

Canonical interactive URLs carry `v=2`. Common context is repeated `benchmark` plus `lab`, `from`, `to`, `zoom`, `center`, and `release`. Header navigation retains only that common context so route-specific search and table controls cannot leak between meanings.

Benchmarks accepts local discovery `search` and `category`. Releases accepts benchmark and alias query `q` plus `category`. Repeated benchmark identities are explicitly mapped, deduplicated, ordered, and bounded by the shared decoder. A center is an ISO UTC instant, while release and reporting dates remain distinct.

Ledger and Reporting history accept `q`, `status`, finite route sort keys, `asc` or `desc`, page sizes 25, 50, or 100, and positive pages. Reporting history additionally accepts repeated benchmark keys as an OR filter and `audit=all`. Table writes preserve common chronological context, and copied table links preserve the full table-specific state.

Invalid finite values, impossible or out-of-window dates, inverted ranges, and unknown identities are canonicalized with a visible explanation. Page numbers clamp to the filtered result range with an explicit status. Back, Reset, route leave, and finite actions cancel pending table searches so an older callback cannot overwrite a newer state.

The default History projection excludes quarantined benchmark identity rows, not entire occurrence records: 3,062 rows contain 1,800 occurrence links. `audit=all` exposes 3,104 stable status rows and all 1,826 occurrence links, including 26 links on historical identity rows. These counts are exercised by `tests/ui/test-data-routes.mjs` against the committed generated corpus. The benchmark and release inspectors use the retained canonical mapping independently of that default History projection.

Discovery publication-window supplements preserve date intervals rather than inventing exact days. A publisher month wholly inside the corpus window, a dated exact-byte author-repository publication, and an explicitly matched report edition can establish window membership without establishing a model release date. `UNRESOLVED` retains null interval bounds; a current download or copyright year alone does not settle historical publication. Discovery evidence remains separate from catalog identity and does not approve whole records or historical index completeness.

The selected residual review retains all 281 occurrence identities and their source evidence, but none may supply positive reporting while its whole-record model, benchmark/version, setup or chronology association remains unapproved. This includes 29 formerly inherited `verified` rows now marked `needs_review`; the other selected rows retain their existing `needs_review` or `quarantined` state. Their release coverage remains incomplete, so withholding is not evidence of non-reporting. This bounded hold does not renew the rest of the corpus or close the 148 historical-index obligations. The exact-edition publication dates for discovery IDs `inventory:url_43df9cadd55a0cc26d0c` and `inventory:url_c1a3f9dd955eb86068ce` remain unknown, with null interval bounds and no inferred publication-window assertion. Original source and acceptance denominators remain unchanged.
