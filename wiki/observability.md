# Observability

Sources: [`src/observability/`](../src/observability/)

The observability layer covers scoring, cost accounting, event logging, and report generation. All types are centralised in `types.ts`; no operational pipeline module imports from more than one observability file.

---

## Fidelity scoring (`fidelity.ts`)

### `screenshotSectionsBySlug(target, archDoc)`

Opens the target HTML file in a headless Puppeteer browser at 1280×900, locates each section by its `data-section-slug` attribute, and captures a clipped screenshot at its bounding rect. Sections that render to less than **4px** or less than **25% of their source `heightPx`** are skipped and logged as warnings — they are collapsed shells with no scoreable content.

### `computeSectionDiscrepancies(sourceScreenshots, genScreenshots, archDoc)`

Scores every section in `archDoc` against its source screenshot. The algorithm:

1. Sections absent from the generated HTML are assigned `type: "missing"`, `score: 0`.
2. Remaining sections are chunked into batches of **8 pairs** (`VLM_BATCH_SIZE`) and all batches are sent to `MODELS.vlmScorer` in parallel via `Promise.all`.
3. Each batch call returns a JSON array of `{ score, verdict, issues }` per section. Both source and generated images are resized to 1024px JPEG before being sent.
4. If an individual batch call fails, those sections fall back to a `"VLM scoring failed"` issue string; other batches are unaffected.
5. Returns `{ sectionScores, discrepancies, tokensIn, tokensOut }`.

### `collectFidelityMetrics(params)`

Runs after generation (and correction) completes. Calls `computeSectionDiscrepancies` on the final assembled HTML and produces `FidelityMetrics`:

```ts
interface FidelityMetrics {
  mainVlmScore: VlmFidelityScore;
  baselineVlmScore?: VlmFidelityScore;
  // ... screenshot base64 fields (stripped from run.json/summary.json)
}

interface VlmFidelityScore {
  score: number;           // mean of per-section scores
  sectionScores: Record<string, SectionScoreEntry>;
  discrepancies: SectionDiscrepancy[];
}
```

A section is labelled `"missing"` only when truly absent from the DOM. Visual discrepancies — including VLM call failures — are labelled `"partial"`, accurately reflecting that the shell exists but rendered incorrectly.

---

## Metrics and cost accounting (`metrics.ts`)

### `estimateMaxTokens(htmlLength, model)`

Scales output token budget linearly between per-model `min` and `max` caps, proportional to how close `htmlLength` is to the 80,000-char truncation ceiling.

| Model | min tokens | max tokens |
|---|---|---|
| `claude-haiku-4-5` | 8,000 | 16,000 |
| `claude-sonnet-4-6` | 16,000 | 64,000 |

### `estimateCost(model, tokensIn, tokensOut)`

Converts token counts to USD at per-model rates:

| Model | Input ($/M) | Output ($/M) |
|---|---|---|
| `claude-sonnet-4-6` | $3.00 | $15.00 |
| `claude-haiku-4-5` | $0.80 | $4.00 |

Cost components tracked separately in `agent.ts`: skeleton, section-initial, section-correction, caption, scorer, baseline.

---

## Event logging (`logger.ts`, `recorder.ts`)

### `Recorder`

Opens `run.ndjson` as an append stream at run start. Each `write(line)` call appends a JSON-serialised `LogLine`. On `finalize(record)`, it closes the stream and writes `run.json` and `summary.json` with base64 image fields stripped.

Stripping logic: `sourceScreenshotBase64`, `mainScreenshotBase64`, `baselineScreenshotBase64` are removed from `FidelityMetrics`; `mainThumbnail` and `baselineThumbnail` are zeroed out in `BaselineComparison`.

### `Logger`

Thin wrapper over `Recorder` that also formats each event to a human-readable terminal line. Phase tags are colour-coded (green for success, yellow for partial, red for distant/error). All formatting logic is self-contained in `logger.ts`.

### Phase event types

| Phase | Emitted by |
|---|---|
| `run:start` / `run:complete` | `agent.ts` |
| `preprocess:start` / `preprocess:complete` | `agent.ts` |
| `skeleton:start` / `skeleton:complete` | `agent.ts` |
| `section:start` / `section:complete` | `agent.ts` |
| `assemble:start` / `assemble:complete` | `agent.ts` |
| `correction-iter:start` / `correction-iter:complete` | `correction-loop.ts` |
| `section-score` | `correction-loop.ts` |
| `fidelity:start` / `fidelity:complete` | `agent.ts` |

---

## HTML report (`report.ts`)

`generateReport(runDir, record, events)` writes `report.html` to the run directory. The report includes a fidelity score summary, iteration table, per-section score cards with side-by-side thumbnails, cost breakdown, and a link to the visualizer if present.

---

## Visualizer (`observability/visualizer/`)

`generateVisualizer(runDir, events, record)` generates `visualizer.html` — an interactive single-file HTML page with a timeline of all phase events, slide-by-slide navigation, and screenshot previews. It is a self-contained client-side app; all event data is embedded as a JSON literal in a `<script>` block.
