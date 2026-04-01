# Observability Layer

The observability layer lives entirely under `src/observability/` and is composed of four modules: `types.ts`, `recorder.ts`, `logger.ts`, `metrics.ts`, and `report.ts`. Together they handle structured event logging, run persistence, cost estimation, convergence detection, and HTML report generation.

---

## Architecture Overview

```
agent.ts
  └─ Recorder  ──► run.ndjson  (streaming per-event log)
  └─ Logger    ──► stdout + Recorder
  └─ metrics   ──► cost / convergence math
  └─ report    ──► report.html  (final HTML dashboard)
```

A `Recorder` is created at the start of every run and owns the two output files. A `Logger` wraps the recorder and adds console output. Both are passed all the way through the generation pipeline so every phase can emit typed, timestamped log lines.

---

## Modules

### `types.ts` — Shared Types

Defines all data shapes used across the layer.

**Phase data interfaces**

| Interface | Phase | Fields |
|---|---|---|
| `FetchData` | `fetch` | `url`, `htmlBytes`, `truncated` |
| `GenerateData` | `generate` | `model`, `tokensIn`, `tokensOut`, `durationMs`, `outputFile` |
| `ScreenshotData` | `screenshot` | `target`, `imageBytes`, `durationMs` |
| `DiffData` | `diff` | `iteration`, `overallScore`, `diffPixels`, `totalPixels` |
| `CaptionData` | `caption` | `iteration`, `tokensIn`, `tokensOut`, `discrepancies[]` |
| `FixData` | `fix` | `iteration`, `model`, `tokensIn`, `tokensOut`, `durationMs`, `htmlSizeDelta` |

**`LogLine`** is a discriminated union over all six phase shapes, each carrying a `phase` string tag and a Unix `timestamp` in milliseconds.

**`IterationRecord`** captures the per-iteration outcome written into `run.json`:

| Field | Type | Description |
|---|---|---|
| `iteration` | `number` | 1-based iteration index |
| `overallScore` | `number` | Pixelmatch fidelity score (0–1) |
| `severity` | `Severity` | `"high"` / `"medium"` / `"low"` |
| `diffPixels` | `number` | Number of mismatched pixels |
| `totalPixels` | `number` | Total pixels compared |
| `discrepancyCount` | `number` | Issues identified by Claude's caption pass |

**`RunRecord`** is the top-level document written to `run.json` at the end of a run:

| Field | Type | Description |
|---|---|---|
| `runId` | `string` | Timestamp + URL slug, e.g. `1775030305827-stripe-com-payments` |
| `url` | `string` | Source URL |
| `startedAt` | `number` | Unix ms timestamp |
| `completedAt` | `number` | Unix ms timestamp |
| `iterations` | `IterationRecord[]` | One record per fix iteration |
| `estimatedCostUsd` | `number` | Total cost for the experimental pipeline |
| `baseline?` | `BaselineComparison` | Present only when `--baseline` flag is set |

**`BaselineComparison`** holds the side-by-side data for experimental vs. baseline when `--baseline` is requested:

| Field | Description |
|---|---|
| `baselineScore` | Final fidelity score for the baseline run |
| `baselineCostUsd` | Estimated cost for the baseline run |
| `baselineDurationMs` | Wall-clock time for the baseline run |
| `baselineThumbnail` | Base64 PNG of the baseline final screenshot |
| `mainScore` | Final fidelity score for the experimental run |
| `mainCostUsd` | Estimated cost for the experimental run |
| `mainDurationMs` | Wall-clock time for the experimental run |
| `mainThumbnail` | Base64 PNG of the experimental run final screenshot |

---

### `recorder.ts` — Persistent Storage

`Recorder` owns both output files for a run and provides the two-phase write contract:

- **`write(line: LogLine)`** — serializes a log line as JSON and appends it to `run.ndjson` immediately via a streaming write handle. This makes `run.ndjson` readable even mid-run.
- **`finalize(record: RunRecord)`** — closes the NDJSON stream, then writes the full structured `RunRecord` to `run.json` as pretty-printed JSON.

**Output files**

| File | Format | Purpose |
|---|---|---|
| `run.ndjson` | Newline-delimited JSON | Streaming append-log; one `LogLine` per line |
| `run.json` | Pretty-printed JSON | Finalized `RunRecord`; written once at completion |

Both files are placed in a run-specific directory under `output/<runId>/`.

---

### `logger.ts` — Console + Record Bridge

`Logger` wraps `Recorder` and adds human-readable stdout output alongside the machine-readable record.

```ts
log(line: LogLine): void
```
- Writes the log line to the recorder (NDJSON file).
- Prints `[<phase>] <data as JSON>` to stdout with the phase tag dimmed via ANSI escape codes (`\x1b[2m`).

```ts
finalize(record: RunRecord): void
```
- Delegates directly to `recorder.finalize(record)`.

**Usage in the pipeline** — `logger.log()` is called six times per iteration in `agent.ts`:

1. After `enrichContext()` completes → `fetch` phase
2. After source `screenshotPage()` → `screenshot` phase
3. After initial generation (`claude-sonnet-4-6`) → `generate` phase
4. After each `screenshotPage()` of the generated output → `screenshot` phase
5. After `scorePage()` → `diff` phase
6. After `captionPage()` → `caption` phase
7. After the fix runner completes → `fix` phase

---

### `metrics.ts` — Cost & Convergence Math

Two pure utility functions; no state.

#### `estimateCost(model, tokensIn, tokensOut): number`

Returns an estimated USD cost based on a hard-coded pricing table:

| Model | Input (per M tokens) | Output (per M tokens) |
|---|---|---|
| `claude-sonnet-4-6` | $3.00 | $15.00 |
| `claude-haiku-4-5` | $0.80 | $4.00 |

Unknown models fall back to experimental model pricing. The formula is:

$$\text{cost} = \frac{\text{tokensIn}}{10^6} \times p_\text{input} + \frac{\text{tokensOut}}{10^6} \times p_\text{output}$$

#### `checkConvergence(prevScore, currScore, threshold): boolean`

Returns `true` when the absolute delta between two consecutive iteration scores is below `threshold`:

$$\left| \text{currScore} - \text{prevScore} \right| < \text{threshold}$$

The default threshold is `0.02`, configurable via `--threshold` on the CLI.

---

### `report.ts` — HTML Dashboard Generator

`generateReport(runDir, record, sourceThumbnail?)` assembles a standalone HTML report and writes it to `<runDir>/report.html`. It returns the path to the written file and prints it to stdout.

The report is a single self-contained HTML file with no external dependencies — all styles are inline and thumbnail images are embedded as base64 data URIs.

#### Report Sections

**Run Metadata**

A two-column grid showing:
- URL (linked)
- Start time and completion time (formatted as `YYYY-MM-DD HH:MM:SS UTC`)
- Total wall-clock duration (formatted as `Xm Ys` or `X.Xs` or `Xms`)
- Number of iterations

**Summary KPIs**

Three large-numeral KPI cards side by side:
- **Final Score** — the `overallScore` from the last `IterationRecord`, color-coded green (>0.85), amber (0.6–0.85), or red (<0.6)
- **Est. Cost** — total `estimatedCostUsd` formatted to 3 decimal places
- **Duration** — total wall-clock time

**Iterations Table**

One row per `IterationRecord` with columns:
- `#` — iteration number
- **Score** — a proportional color bar (green/amber/red based on severity) alongside the numeric score to 3 decimal places
- **Severity** — color-coded text label
- **Diff Pixels** — raw mismatched pixel count with locale-formatted thousands separator
- **Discrepancies** — count of issues returned by the caption pass

**Performance Comparison** _(baseline runs only)_

Three overlapping bar charts, one per metric, comparing experimental vs. baseline:
- **Fidelity Score** (higher is better) — both values on a single track; the lower bar rendered at 80% opacity in front
- **Processing Time** (lower is better)
- **Est. Cost** (lower is better)

Each metric row shows the % delta badge (green if experimental wins, red if baseline wins) and labeled swatches identifying experimental (blue `#3b82f6`) vs. baseline (purple `#8b5cf6`).

**Baseline Comparison** _(baseline runs only)_

Side-by-side cards for the source website, the experimental run, and the baseline run. Each card shows:
- Score, cost, and duration as large numerals
- A scrollable embedded screenshot (base64 PNG, max 400px tall)
- The winning card (by score) is highlighted with a green border and green background tint

Below the cards, a delta summary strip shows score delta and cost delta, each color-coded by whether main or baseline won.

#### Helper Functions

| Function | Purpose |
|---|---|
| `escapeHtml(s)` | Prevents XSS in run IDs, URLs, and other user-originated strings inserted into HTML |
| `formatDuration(ms)` | Human-readable duration: `ms` → `X.Xs` → `Xm Ys` |
| `formatDate(ts)` | ISO-8601 timestamp stripped to `YYYY-MM-DD HH:MM:SS UTC` |
| `severityColor(severity)` | Returns a hex color: high=`#ef4444`, medium=`#f59e0b`, low=`#22c55e` |
| `scoreBarWidth(score)` | Maps a 0–1 score to an integer 0–100 for CSS `width:%` |
| `buildIterationRows(record)` | Renders the `<tr>` rows for the iteration table |
| `buildComparisonSection(record, sourceThumbnail?)` | Renders the three-card baseline comparison section |
| `buildMetricsComparison(record)` | Renders the three overlapping metric bar charts |

---

## Metrics Tracked

The following metrics are captured and persisted across the lifecycle of a run:

| Metric | Source | Where Recorded |
|---|---|---|
| Source URL | CLI arg | `RunRecord.url` |
| Run start / end timestamps | `Date.now()` | `RunRecord.startedAt/completedAt` |
| HTML payload size (bytes) | `enrichContext()` | `FetchData.htmlBytes` |
| HTML truncation flag | `enrichContext()` | `FetchData.truncated` |
| Source screenshot size (bytes) | `screenshotPage()` | `ScreenshotData.imageBytes` |
| Generation model | hardcoded `claude-sonnet-4-6` | `GenerateData.model` |
| Token counts per API call | SDK `usage.*` | `GenerateData`, `CaptionData`, `FixData` |
| Generation wall-clock time | `Date.now()` delta | `GenerateData.durationMs` |
| Fix wall-clock time per iteration | `Date.now()` delta | `FixData.durationMs` |
| HTML size delta after fix | `fs.statSync()` diff | `FixData.htmlSizeDelta` |
| Fidelity score per iteration | pixelmatch | `DiffData.overallScore`, `IterationRecord.overallScore` |
| Diff pixels and total pixels | pixelmatch | `DiffData`, `IterationRecord` |
| Severity band per iteration | `severityBand(score)` | `IterationRecord.severity` |
| Discrepancy list and counts | Claude caption | `CaptionData.discrepancies`, `IterationRecord.discrepancyCount` |
| Total estimated cost (main) | `estimateCost()` | `RunRecord.estimatedCostUsd` |
| Baseline score, cost, duration | `runBaseline()` return | `BaselineComparison` |
| Experimental vs. baseline score/cost/duration deltas | computed in `report.ts` | Rendered in `report.html` |

---

## Output File Layout

For each run, the following files are written under `output/<runId>/`:

```
output/<runId>/
├── run.ndjson              # Streaming per-event log (one LogLine per line)
├── run.json                # Finalized RunRecord (written at completion)
├── report.html             # Self-contained HTML dashboard
├── main/
│   └── <page-slug>.html    # Final generated page (experimental pipeline)
└── baseline/               # Only present with --baseline
    └── <page-slug>.html    # Baseline page
```

---

## Severity Bands

Severity is computed by `severityBand()` in `src/diff/score.ts` and referenced throughout the observability layer:

| Severity | Score Range | Meaning |
|---|---|---|
| `"high"` | < 0.60 | Significant visual divergence; fix loop continues regardless of convergence |
| `"medium"` | 0.60 – 0.85 | Moderate divergence; convergence check applies |
| `"low"` | > 0.85 | High fidelity; pipeline halts early |

The pipeline will stop without captioning if severity reaches `"low"`. It will also stop if the absolute score delta between two consecutive iterations falls below `threshold` (default `0.02`) and severity is not `"high"`.
