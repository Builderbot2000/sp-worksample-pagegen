# Architecture

## Overview

The system takes a public URL and produces a self-contained, Tailwind CSS page that visually replicates the source. The pipeline is multi-stage and LLM-driven: a preprocessing phase extracts structured knowledge from the live page, a skeleton LLM call establishes the document shell and global styles, then N section LLM agents run in parallel to fill in each section's content independently. An optional correction loop follows, driven by a VLM fidelity scorer that identifies visual discrepancies and targets only the sections that need fixing.

All source is TypeScript, executed via `ts-node`. The entry point is `src/cli.ts`, which delegates to `generatePage()` in `src/agent.ts`. Output is written to `output/<timestamp>-<name>/`.

---

## Stage 0 — Crawl and Preprocess (`src/context.ts`)

The first phase uses Puppeteer to drive a headless Chromium browser at a fixed viewport of 1280×900. After navigating to the URL with `waitUntil: "networkidle2"`, it captures a full-page screenshot (capped at 7,800px height), serialises the DOM as HTML (truncated at 80,000 characters), extracts image URLs, font families, and computed styles for key selectors, and collects the `outerHTML` of top-level fixed and sticky elements that are visible on initial load.

Section detection runs entirely inside the browser via `page.evaluate()`. It queries all semantic elements (`section`, `article`, `main`, `header`, `footer`, `nav`), filters to those without a semantic ancestor (the top-level set), and discards elements shorter than 50px or marked fixed/sticky. Sections taller than 1,350px trigger a recursive descent into their direct semantic children, preventing a single monolithic element from absorbing the whole page. Each surviving element gets a role inferred from its tag name, `aria-label`, `class`, and `id` (navbar, hero, features, pricing, etc.) and a slug derived from its heading or aria label, falling back to `tag-N`. All slugs are then replaced with generic `section-1`, `section-2`, … names before leaving the browser to prevent content-derived names from biasing section agents. The final list is capped at 20 sections.

A per-section screenshot is taken for each detected section using its bounding rect. These are stored in `sourceSectionScreenshots` keyed by slug and used in both the generation and scoring phases.

After DOM detection, each section screenshot is run through a parallel batch of VLM caption calls using `claude-haiku-4-5`. The model is instructed to list every distinct content block visible in the screenshot, one line per block. This caption replaces the DOM-derived heading+paragraph heuristic as the section's `description` field in the `VisualArchDoc`. The caption calls are the cheapest AI cost in the pipeline and run fully in parallel via `Promise.all`.

The function returns a `CrawlResult` containing all extracted data plus `captionTokensIn` and `captionTokensOut` for cost accounting.

---

## Stage 1 — Skeleton Generation (`src/agent.ts` → `generatePage`)

The skeleton agent receives the full-page screenshot, the serialised `VisualArchDoc`, the complete source HTML, computed styles, font families, image URLs, inline SVGs, and the `outerHTML` of fixed/sticky elements. It is instructed to produce a complete HTML document with all global infrastructure rendered — `<head>` with charset, viewport, title, and font imports; a Tailwind CDN `<script>` tag; a `tailwind.config` block with `theme.extend` containing brand colours and fonts as CSS custom properties; a `:root` style block for any values that cannot be Tailwind config tokens; and all fixed/sticky navigation elements fully rendered using Tailwind utility classes.

Critically, section interiors are intentionally left empty. The agent emits one shell element per section, and each shell's outermost tag must carry exactly two attributes: `data-section-slug="<slug>"` and `data-section-order="<N>"`. No content goes inside the shells. This is the skeleton contract that makes deterministic assembly possible downstream. The model is told whether the page's navigation lives in a dedicated section (a `navbar` or `header` role section already in the list) — if so, it must not render a duplicate global nav element outside the shells.

The skeleton agent uses `claude-sonnet-4-6` with streaming via the Anthropic Beta Tool Runner, forced to call a `save_file` tool that writes the HTML to `main/<name>-skeleton.html`. Token usage is read from the stream events and tracked separately as `skeletonIn` / `skeletonOut`.

The token budget for the skeleton call is dynamic: `estimateMaxTokens()` scales linearly between 16,000 and 64,000 tokens depending on source HTML length relative to the 80,000-character cap, unless the fidelity mode specifies a hard `generateMaxTokens` override.

---

## Stage 2 — Parallel Section Generation (`generateSection`)

Once the skeleton HTML is available, all sections are launched simultaneously via `Promise.all`. Each `generateSection` call runs independently with no shared mutable state, which is what makes full parallelism safe.

Every section agent receives: the section's own screenshot(s) resized for VLM via `sharp` (1024px wide, JPEG 80%); the section's slug, role, order, description, and source height; the `:root` CSS custom properties extracted from the skeleton (so agents can use `var(--brand-color)` rather than hardcoded hex); the computed styles, font families, and image URL list; and a `shell_context` block containing the section's own opening shell tag plus the fully assembled neighbouring sections above and below (see `assembleNeighbour`).

The model is instructed to produce only an interior HTML fragment — no `<html>`, `<head>`, `<body>`, `<style>`, or `<script>` tags, no outer semantic container (the shell already provides that), no redeclaration of background or padding already present on the shell. This keeps each agent's output at output-position-zero relative to its own section, eliminating the attention decay that degrades quality in single-pass full-page generation.

Each agent calls a `save_section` tool with the slug and interior content. The tool runner allows `max_iterations: 2` so that if Zod validation rejects the first call (e.g. model omits the `content` field), the model receives the error and can retry on the second turn. The fragment is captured in a closure and returned alongside token counts.

After all sections complete, the fragments and skeleton are merged by `assembleSkeleton`, which applies a regex with a backreference on the tag name to locate each shell by its `data-section-slug` attribute and inject the fragment between the opening and closing tag. Unmatched slugs are logged as warnings. The assembled file is written to `main/<name>.html`.

---

## Stage 2.5 — Correction Loop (optional, `--correction`)

When `--correction` is passed, a fidelity-driven correction loop runs after initial assembly. The number of iterations is controlled by the fidelity budget (`maxSectionIter`): 0 for minimal, 1 for fast, 2 for balanced, 3 for high, 4 for maximal.

Each iteration begins by screenshotting the assembled HTML with Puppeteer, locating each section by its `data-section-slug` attribute via `el.boundingBox()`. Sections that render to less than 4px, or to less than 25% of their source `heightPx`, are skipped — they are treated as collapsed shells and fed into the correction pass as missing sections rather than scoring them with a near-empty image. The per-section screenshots from the source and the reconstruction are then passed to `computeSectionDiscrepancies`. All matched sections are scored: they are chunked into batches of 5 pairs (`VLM_BATCH_SIZE`) and all batches are sent to `claude-sonnet-4-6` in parallel via `Promise.all`. Each call returns a JSON array with a score (0–1), a verdict (`close`, `partial`, or `distant`), and up to three issue strings per section. Both source and generated images are run through `resizeForVlm` (1024px JPEG) before being sent, consistent with all other VLM calls in the pipeline. If an individual batch call fails, only those sections fall back to a `"VLM scoring failed"` discrepancy; other batches are unaffected.

Sections scoring below 0.85 are flagged for correction. All flagged sections are corrected in parallel by calling `generateSection` again, this time passing the issues list as `corrections`, the current reconstruction screenshot as `currentScreenshot`, and the current fragment HTML as `currentHtml`. The `currentHtml` is injected as a `<current_html>` block in the prompt with the instruction to modify it surgically rather than rewrite from scratch, preventing regressions in the parts that already match. The `currentScreenshot` gives the model a side-by-side visual of exactly what went wrong.

Neighbour context is built with `assembleNeighbour`, which wraps the neighbour's live fragment (from `fragmentMap`, updated after each iteration) inside its shell opening tag. This ensures correction agents see the real rendered HTML of adjacent sections, not the empty shell placeholders from the skeleton.

After each correction pass the skeleton is reassembled with the updated `fragmentMap` and written back to disk. The loop stops early if no sections need fixing or if the aggregate score improvement over the previous iteration falls below 0.01 (plateau detection).

Each iteration writes an `iter-N-report.html` to `corrections/` containing a card per section with its score badge, severity, issue list, and side-by-side screenshots. Source screenshots are saved once to `sections/source-<slug>.png`; generated screenshots are saved to `corrections/iter-N/generated-<slug>.png`.

---

## Stage 3 — Fidelity Metrics (`src/observability/fidelity.ts`)

After generation (and correction, if enabled) completes, `collectFidelityMetrics` runs a final VLM scoring pass on the assembled page. It captures full-page screenshots of the main output (and baseline if requested) and the per-section screenshots of the final assembled HTML, then runs `computeSectionDiscrepancies` once more to produce the final `mainVlmScore`. The aggregate score is the mean of per-section scores across all sections in `archDoc`. Sections absent from the generated HTML score 0; sections that were scored by a VLM batch use their returned score. In `buildVlmFidelityScore`, a section is labelled `"missing"` only when its discrepancy type is `"missing"` (genuinely absent from the DOM). Visual discrepancies — including those produced by a failed VLM call — are labelled `"partial"` regardless of their severity, accurately reflecting that the shell exists but rendered incorrectly. The `FidelityMetrics` record is attached to the `RunRecord` and surfaced in the HTML report.

---

## Baseline Agent (optional, `--baseline`)

When `--baseline` is passed, `runBaseline` runs `claude-haiku-4-5` on the raw source HTML with a simple prompt: reproduce the page using Tailwind CSS CDN. This serves as a cost and quality benchmark. The baseline output is written to `baseline/`, and the `BaselineComparison` record in the `RunRecord` captures both agents' scores, costs, and durations.

---

## Cost Accounting

All token consumption is tracked and converted to USD at the end of the run. The formula has three components:

Generation cost uses `claude-sonnet-4-6` pricing ($3/MTok in, $15/MTok out) against the combined skeleton and section (plus correction) token counts. Caption cost uses `claude-haiku-4-5` pricing ($0.8/MTok in, $4/MTok out) against `captionTokensIn/Out` returned by `crawlAndPreprocess`. Scorer cost uses `claude-sonnet-4-6` pricing against `scorerTokensIn/Out`, which accumulates across all `computeSectionDiscrepancies` calls in the correction loop plus the final `collectFidelityMetrics` call.

Pricing constants and `estimateCost` live in `src/observability/metrics.ts`. The final `estimatedCostUsd` is written to `run.json`.

---

## Output Structure

Every run writes to `output/<timestamp>-<name>/`. The layout is:

```
<runId>/
  run.ndjson       — streaming NDJSON log of all phase events
  run.json         — structured run record (no base64 images)
  summary.json     — identical to run.json
  report.html      — HTML report with fidelity scores, iteration table, thumbnails
  main/
    <name>-skeleton.html
    <name>.html    — final assembled page
  baseline/        — present if --baseline was passed
    <name>.html
  sections/
    source-<slug>.png   — source section screenshots (one per section)
  corrections/     — present if --correction was passed
    iter-1-report.html
    iter-1/
      generated-<slug>.png
    iter-2-report.html
    iter-2/
      ...
```

---

## Observability (`src/observability/`)

The `Recorder` class opens a write stream to `run.ndjson` and appends a JSON line for every phase event. At the end of the run it writes `run.json` and `summary.json` with base64 image fields stripped to keep file sizes manageable. The `Logger` wraps `Recorder` and provides typed `log()` calls keyed by phase (`fetch`, `generate`, `screenshot`, `diff`, `fix`). The `report.ts` module generates the standalone `report.html` from the `RunRecord`, including an iteration table with VLM score progress bars, a baseline comparison section, and embedded thumbnail screenshots.

---

## Key Constants and Configuration

| Constant | Value | Location |
|---|---|---|
| Crawl viewport | 1280×900 | `context.ts` |
| HTML truncation cap | 80,000 chars | `context.ts` |
| Max screenshot height | 7,800px | `context.ts`, `fidelity.ts` |
| Section tall threshold (triggers descent) | 1,350px | `context.ts` |
| Max sections per page | 20 | `context.ts` |
| VLM batch size (pairs per scorer call) | 5 | `fidelity.ts` |
| Section screenshot min height ratio | 25% of source heightPx | `fidelity.ts` |
| Section agent max tokens | 8,000 | `agent.ts` |
| Correction threshold (score below triggers fix) | 0.85 | `agent.ts` |
| Plateau delta (stops loop if improvement ≤) | 0.01 | `agent.ts` |
| VLM resize target | 1024px wide, JPEG 80% | `image.ts` |

---

## Model Assignments

| Role | Model |
|---|---|
| Skeleton generation | `claude-sonnet-4-6` |
| Section generation | `claude-sonnet-4-6` |
| Section correction | `claude-sonnet-4-6` |
| VLM fidelity scorer | `claude-sonnet-4-6` |
| Section captioning | `claude-haiku-4-5` |
| Baseline generation | `claude-haiku-4-5` |

---

## Data Flow Summary

```
URL
 └─ crawlAndPreprocess()          context.ts
     ├─ Puppeteer: DOM, screenshots, CSS, assets
     └─ Haiku: parallel VLM captions → VisualArchDoc + CrawlResult
         └─ generatePage()                  agent.ts
             ├─ Sonnet: skeleton → skeleton.html
             ├─ Sonnet ×N (parallel): sections → sectionFragments[]
             ├─ assembleSkeleton() → page.html
             └─ [correction, fidelity mode]
                 ├─ Puppeteer: screenshot page.html by slug
                 ├─ Sonnet: computeSectionDiscrepancies (batch VLM)
                 ├─ Sonnet ×M (parallel): corrected sections
                 ├─ assembleSkeleton() → page.html (overwrite)
                 └─ repeat up to maxSectionIter times
             └─ collectFidelityMetrics()   fidelity.ts
                 ├─ Puppeteer: final screenshots
                 └─ Sonnet: final section VLM score
```
