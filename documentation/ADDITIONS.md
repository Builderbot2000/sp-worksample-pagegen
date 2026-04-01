# Additions over Baseline

The raw baseline (`baseline/`) is a single-pass, single-model, no-feedback HTML generator: it fetches the page HTML as text, sends it to Claude Haiku once, saves the output, and exits. Everything below is added in `src/`.

---

## 1. Browser-rendered context enrichment (`src/context.ts`)

The baseline fetches raw HTML with `fetch()`. The main agent launches Puppeteer to load the live page and extracts:

- **Viewport screenshot chunks** — up to five 1440×900 px PNG slices of the full page, sent to Claude as inline images so it can see the rendered visual design, not just markup.
- **Computed styles** — CSS property values resolved by the browser for key semantic selectors (`body`, `h1–h4`, `nav`, `header`, `footer`, etc.), covering color, font, spacing, grid, and flex properties. Passed to Claude as a JSON block so it can apply exact values via Tailwind arbitrary syntax.
- **Absolute image URLs** — all `<img>` sources resolved to fully qualified URLs so Claude uses real images instead of placeholders.
- **Font families** — non-generic font families detected on the page, injected into the prompt as Google Fonts `<link>` instructions.
- **Browser-rendered HTML** — `page.content()` after JavaScript execution, replacing the static `fetch()` text.

---

## 2. Full-page screenshot capture (`src/screenshot.ts`)

A dedicated utility that screenshots any URL or `file://` path at 1440×900 viewport and returns a full-page PNG `Buffer` plus dimensions. Used both for capturing the source reference and for capturing each iteration of the generated output during the fix loop.

---

## 3. Pixel-level diff scoring (`src/diff/score.ts`)

After each generation or fix, the output is screenshotted and compared against the source reference using **pixelmatch**. This produces:

- A normalized **fidelity score** (0–1, where 1 is pixel-perfect).
- A **severity band** — `high` (score < 0.6), `medium` (0.6–0.85), `low` (> 0.85) — used to decide whether to continue iterating.
- Chunked PNG images of the source, generated output, and diff mask (red pixels = mismatch), ready to send to Claude for captioning.

The baseline has no scoring whatsoever.

---

## 4. Vision-based discrepancy captioning (`src/diff/caption.ts`)

When the iteration has not converged AND severity is not `low`, the source/generated/diff image chunks are sent to **Claude Sonnet** with a prompt asking it to identify what is visually wrong and where. It returns a structured JSON array of discrepancies, each with an `issue` description and `severity` (`high` or `medium`). This list is fed directly into the fix prompt. Captioning is skipped — and the loop exits — if either stopping condition fires first: convergence (score delta below threshold, severity not `high`) or the severity reaching `low`.

---

## 5. Iterative fix loop (`src/agent.ts`)

The baseline runs one generation pass, period. The main agent adds a configurable fix loop (default: 4 iterations) that repeats:

1. Screenshot the current output.
2. Score it against the source.
3. If converged or score is `low`, stop.
4. Caption the diff to get a discrepancy list.
5. Send the current HTML plus the discrepancy list to Claude Sonnet to produce a repaired version.

Convergence is declared when the score delta between iterations falls below a configurable threshold (`--threshold`, default 0.02) and the severity is not `high`.

---

## 6. Upgraded model and richer generation prompt (`src/agent.ts`)

The baseline uses `claude-haiku-4-5` with a plain text HTML-only prompt. The main agent uses `claude-sonnet-4-6` and augments the initial generation prompt with the screenshot chunks, computed styles JSON, absolute image URLs, and font family instructions described in §1.

---

## 7. Parallel baseline runner (`src/baseline-runner.ts`)

The `--baseline` flag causes the original baseline agent to run in parallel with the main generation (both start immediately and race). When both finish, their final outputs are screenshotted and scored against the same source reference to produce a head-to-head comparison.

---

## 8. Observability stack (`src/observability/`)

The baseline emits nothing persisted. The main agent records a full audit trail:

- **`types.ts`** — Typed data shapes for every pipeline phase (`fetch`, `generate`, `screenshot`, `diff`, `caption`, `fix`) and the run-level summary and baseline comparison structures.
- **`recorder.ts`** — Writes a streaming NDJSON log (`run.ndjson`) per phase as the run executes, and flushes a final snapshot (`run.json`) on completion.
- **`logger.ts`** — Wraps the Recorder; also prints each phase event to stdout with dim color coding.
- **`metrics.ts`** — Token cost estimation (per-model input/output pricing table) and convergence threshold check.
- **`report.ts`** — Generates a self-contained `report.html` dashboard after each run containing: run metadata, KPI summary (final score, estimated cost, duration), an iteration timeline table with score progress bars, a **Performance Comparison** section (overlapping horizontal bars for fidelity, processing time, and cost with ±% delta badges for main vs. baseline), and a **Baseline Comparison** section with side-by-side scrollable full-page screenshots of the source, main output, and baseline output.

---

## 9. CLI improvements (`src/cli.ts`)

The baseline CLI has a single `--open` flag that optionally opens the output with `execSync('open ...')`. The main CLI adds:

- **`--iterations <n>`** — Maximum fix iterations (default: 4).
- **`--threshold <n>`** — Convergence delta threshold (default: 0.02).
- **`--baseline`** — Enables parallel baseline run and comparison.
- **Automatic multi-tab browser open** — After every run, `openFiles()` opens the report, the generated page, the baseline page (if present), and the source URL all as tabs in a single browser window. Uses `spawnSync` with Chromium/Firefox/xdg-open fallback chain; no shell interpolation.

---

## 10. Enhanced terminal renderer (`src/render.ts`)

The baseline renderer only handles `thinking`, `tool_use`, and `text` stream events. The main renderer adds:

- **`printIterationHeader(n, max)`** — Bold cyan header for each fix iteration.
- **`printPageScore(score)`** — Prints the fidelity score and severity with red/amber/green coloring.
- **`printFinalSummary(scores)`** — Prints the score trajectory across all iterations at the end.
- A `red` and `bold` ANSI helper in addition to the baseline's `dim`, `cyan`, `yellow`, `green`.
