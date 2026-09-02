# Frontier Benchmark Observatory data foundation

This directory contains the score-free, reviewable data contract for the Observatory route.

## Canonical inputs

- `data/catalog.yaml` holds labs, lineages, models, release candidates, releases, benchmarks, sources, evidence occurrences, coverage, and quarantine records.
- `data/definitions.yaml` is the single canonical source for every reporting-status definition exposed by compiled data or a Definitions page.
- `schema/*.schema.json` are JSON Schema draft 2020-12 contracts applied to the parsed YAML documents.

Derived reporting statuses never appear in canonical source data. `scripts/compile.py` validates both inputs, computes lineage-scoped statuses, and writes deterministic UTF-8 JSON plus RFC 4180 CSV to `public/`.

## Reproduce

From this directory, with a currently supported Python 3 release:

```sh
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python scripts/compile.py
.venv/bin/python -m unittest discover -s tests -v
```

The compiler accepts `--check` to verify that committed artifacts are current without rewriting them. The tests include a byte-for-byte double-build check.

The canonical catalog is the curated score-free six-lab corpus at the `2026-09-01` cutoff. The small synthetic contract catalog used for focused compiler behavior tests lives under `tests/fixtures/`.

## Static interface

The static interface uses a shared responsive shell and direct, no-JavaScript-safe routes:

- `index.html` is the concise overview and compact-timeline host.
- `timeline.html` is the full timeline workspace.
- `ledger.html`, `history.html`, and `evidence.html` are bounded data-view hosts.
- `definitions.html` remains the canonical definitions destination.
- `public/observatory.json` and `public/observatory.csv` remain the stable generated downloads.

`shell.mjs` owns shared theme behavior. `timeline.mjs` is the shared compact and full-route chronology controller: it loads the generated corpus, renders all six lanes and release IDs without occurrence-label expansion, previews a hovered or focused release, pins full release and occurrence context, synchronizes `q`, `category`, `lab`, `from`, `to`, `zoom`, and `release` URL state, and provides the full route browser-fullscreen control. `styles.css` provides shared shell, timeline-host, toolbar, and data-route hooks. `core.mjs` contains pure data helpers and `app.mjs` currently renders canonical definitions and retains the established Observatory render helpers for route-specific modules to reuse or replace. Serve the repository root over HTTP and open `/frontier-benchmarks/`; no build step or runtime service is required.

## Durable view state

Timeline state accepts known category, lab, and release identifiers; corpus-window `from` and `to` dates in start-before-end order; zoom levels `1`, `2`, or `4`; and a text-only query bounded to 160 characters. The default shows all releases at zoom `1` with no pinned release.

Ledger state includes query, lab, coverage status, sort, direction, page, and page size. History adds benchmark and date filters. Evidence adds benchmark, category, release, source-type, date, and `sources` or `occurrences` view state. Data-route queries are bounded to 200 characters, page sizes are restricted to 25, 50, or 100, and the default is the complete unfiltered route at 50 rows per page. The Evidence default is the first-party `sources` view.

Unknown identifiers, unsupported views, invalid sort or direction values, impossible or out-of-window dates, inverted date ranges, invalid pages, and unsupported page sizes are removed from the canonical URL and fall back to those unfiltered defaults. A valid free-text query that happens to match no records remains a valid zero-result view rather than being reset.

Focused interface-contract checks use a deterministic six-lab fixture without changing the generated production artifact:

```sh
node tests/ui/test-ui.mjs
```

For browser checks on localhost only, append `?fixture=ui`. The interface then imports `tests/ui/fixture.mjs`, which covers six lab lines, dense release collisions, aliases, categories, incomplete coverage, quarantine, and long text.

The compact timeline host is fixed to 560px at viewport widths of 768px and above, and 460px below that breakpoint. The full route uses the available viewport. Timeline state preserves unrelated query values such as `fixture=ui`, so fixture checks can use the same filters and pinned release state.
