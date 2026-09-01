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

The included catalog is deliberately synthetic and score-free. It proves the contract and compiler behavior but is not the curated six-lab corpus.

## Static interface

`index.html`, `definitions.html`, `styles.css`, `core.mjs`, and `app.mjs` consume only `public/observatory.json`. Serve the repository root over HTTP and open `/frontier-benchmarks/`; no build step or runtime service is required.

Focused interface-contract checks use a deterministic six-lab fixture without changing the generated production artifact:

```sh
node tests/ui/test-ui.mjs
```

For browser checks on localhost only, append `?fixture=ui`. The interface then imports `tests/ui/fixture.mjs`, which covers six lab lines, dense release collisions, aliases, categories, incomplete coverage, quarantine, and long text.
