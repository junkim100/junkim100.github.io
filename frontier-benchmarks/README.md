# Frontier Benchmark Observatory

This directory contains the static, score-free Observatory and its reviewable data contract.

## Canonical inputs

- `data/catalog.yaml` holds labs, lineages, models, release candidates, releases, benchmarks, sources, occurrences, coverage, and quarantine records.
- `data/definitions.yaml` holds the reporting-status definitions consumed by compilation.
- `schema/*.schema.json` contains the JSON Schema draft 2020-12 contracts applied to the parsed YAML documents.

Derived reporting statuses never appear in canonical source data. `scripts/compile.py` validates both inputs, computes lineage-scoped statuses, and writes one deterministic UTF-8 generated artifact.

## Reproduce

From this directory, with a currently supported Python 3 release:

```sh
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python scripts/compile.py
.venv/bin/python -m unittest discover -s tests -v
node tests/ui/test-ui.mjs
node tests/ui/test-data-routes.mjs
node tests/ui/test-timeline-geometry.mjs
```

The compiler accepts `--check` to verify that the committed generated artifact is current without rewriting it. The tests include a byte-for-byte double-build check.

## Static interface

- `index.html` is the Benchmark Trends landing page. It retains the fixed corpus overview and renders publication-date lanes for 1 to 6 selected canonical benchmarks.
- `timeline.html` is the viewport-bounded Releases chronology.
- `ledger.html` and `history.html` are paginated data views.
- `about.html` states the review window, first-party source boundary, score-free purpose, and absence caveat.
- `definitions.html` is a compatibility redirect to About.

`shell.mjs` owns shared theme behavior. `trends.mjs` owns the benchmark picker, URL selection state, release matching, benchmark lanes, shared release highlighting, and allowlisted Source links. `timeline.mjs` renders the six-lab release chronology, keeps every release focusable, restores horizontal position through history state, and exposes every selected release occurrence through allowlisted Source links. `data-routes.mjs` renders the Ledger and History tables. `core.mjs` contains shared data and searchable-combobox helpers.

## Durable view state

Benchmark Trends state uses one repeated `benchmark` query parameter for each ordered selection, plus optional `category`, `lab`, `from`, `to`, and `zoom` keys. Unknown and duplicate identifiers are removed, selections are limited to six, and order is canonicalized by normalized benchmark name and canonical ID. Merged and quarantined identities are dropped. A state with no valid identifier uses Terminal-Bench 2.0 when it remains canonical, otherwise the first live canonical benchmark. Category filters discovery only. Lab and date filters constrain visible markers. The search query remains local to the picker and is never written to the URL. Both Trends and Releases persist the ISO date at the viewport center in history state and initialize at the newest/rightmost edge. Local UI fixture mode preserves `fixture=ui` only on localhost or `127.0.0.1`.

The pure Trends helpers have stable return shapes: `rankBenchmarks` returns ordered benchmark records; `sanitizeBenchmarkIds` and `parseBenchmarkState` return canonical identifier arrays; `serializeBenchmarkState` returns a leading-question-mark query string; `transitionBenchmarkSelection` returns an identifier array and transition outcome; `releaseMatches` returns publication-ordered `{ release, benchmarkIds, occurrences }` records; and `laneOccurrences` returns every exact occurrence for one selected benchmark lane.

Timeline state accepts known category, lab, and release identifiers; corpus-window `from` and `to` dates in start-before-end order; zoom levels `1`, `2`, or `4`; and search text bounded to 160 characters. A default visit starts at the latest release. Explicit date, zoom, selected release, or restored horizontal history state takes precedence.

Ledger and History state includes search, lab, status, date range, sort, direction, page, and page size. History also accepts an exact benchmark identifier. Search updates after a 150ms debounce, every finite filter applies immediately, and page sizes are restricted to 25, 50, or 100 with 50 as the default.

Unknown identifiers, unsupported sort or direction values, impossible or out-of-window dates, inverted date ranges, invalid pages, and unsupported page sizes are removed from the canonical URL and fall back to finite defaults. A valid query with no matches remains a valid zero-result view.

The compact timeline host is fixed to 560px at viewport widths of 768px and above, and 460px below that breakpoint. The fallback timeline route consumes the available viewport without ordinary document scrolling.
