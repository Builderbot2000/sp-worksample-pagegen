# Project Plan: Superpilot Page Generation — Fidelity Improvement

## Overview

Extend the existing CLI tool with a richer generation pipeline that improves output fidelity through context enrichment, an iterative visual feedback loop, and a full observability layer. The central quality goal remains **fidelity** — how closely the generated page reproduces the source page's layout, copy, images, and visual theme.

---

## Context Enrichment

Before the first generation pass, Puppeteer fetches the source page and extracts additional context to give Claude a richer prompt than raw HTML alone:

- **Full-page screenshot** as visual ground truth passed alongside the HTML
- **Computed styles** for key elements — colors, fonts, spacing — extracted via `getComputedStyle`
- **Absolute image URLs** so assets resolve correctly in the generated output
- **Font families** identified and injected as CDN imports

---

## Iterative Fidelity Loop

After each generation, the output HTML is screenshotted and compared against the source using a coarse segmentation and pixel-diff strategy.

### Segmentation

Five coarse landmark regions are extracted from the source DOM via Puppeteer:

| Segment | Selector targets |
|---|---|
| `nav` | `header`, `nav`, `[role='navigation']` |
| `hero` | `main > *:first-child`, `.hero`, `[class*='hero']` |
| `features` | `main > *:nth-child(2)`, `[class*='feature']` |
| `cta` | `[class*='cta']`, `[class*='call-to-action']` |
| `footer` | `footer` |

Viewport is normalized to 1440px on both screenshots for stability. Segments are sorted top-to-bottom and clipped to prevent overlap before diffing.

### Scoring

Each segment is scored deterministically via `pixelmatch`:

```
score = 1 - (diffPixels / totalPixels)   // 0.0–1.0 per segment
```

Severity bands:

| Score | Severity |
|---|---|
| < 0.60 | high |
| 0.60 – 0.85 | medium |
| > 0.85 | low (not captioned) |

Overall fidelity score is a weighted average across all segments.

### Captioning

Only `high` and `medium` segments are sent to Claude for captioning. Claude receives the source crop, generated crop, and diff mask for each failing segment and returns a structured discrepancy description:

```json
{ "segment": "hero", "issue": "background image missing, solid color used instead", "severity": "high" }
```

Claude does not decide *what* is wrong — pixelmatch establishes that — it only articulates *how* it is wrong in terms useful for a fix prompt.

### Fix Prompt

The fix prompt passes Claude the current generated HTML alongside the structured discrepancy list, constraining it to repair only failing segments and leave correct ones untouched.

### Stopping Conditions

The loop continues until any of the following:
- No `high` severity segments remain **and** overall score delta between iterations < 0.02
- Hard cap of 4 iterations reached

---

## Observability Layer

Every run produces a structured event log that drives real-time terminal output, a persisted run file, and a future streaming UI — all from a single source of truth.

### What is Tracked

Each phase emits timestamped log lines with relevant metadata:

| Phase | Key data |
|---|---|
| `fetch` | URL, response status, HTML size, truncation applied |
| `generate` | Model, tokens in/out, time-to-first-token, stream duration |
| `screenshot` | Viewport, page load time, file size |
| `diff` | Segments evaluated, per-segment pixel counts, overall score |
| `caption` | Segments sent, tokens consumed, captions returned |
| `fix` | Tokens in/out, HTML size delta |

Accumulated per-run totals: total tokens in/out, total duration, estimated cost derived from token counts and model pricing.

### Derived Views

- **Score over iterations** — overall score plus per-segment lines
- **Discrepancy count over iterations** — high + medium segments per iteration
- **Token consumption** — stacked by phase per iteration
- **Processing time** — stacked by phase per iteration

### Persistence

Runs are written as append-only NDJSON (`run.ndjson`) for streaming semantics — the UI reconstructs the full run by replaying the event stream. A completed run also produces a final `run.json` snapshot. Both are written to `output/<run-id>/`.

---

## Module Structure

```
src/
  cli.ts                  — entry point, --iterations and --threshold flags
  agent.ts                — generation logic and iterative loop
  render.ts               — terminal output, sparkline graphs
  screenshot.ts           — shared Puppeteer logic for source and output screenshots
  diff/
    segment.ts            — DOM extraction → bounding boxes
    score.ts              — pixelmatch per segment → scores and severity
    caption.ts            — Claude call per failing segment → structured captions
  observability/
    types.ts              — Run, IterationRecord, LogLine interfaces
    recorder.ts           — run.ndjson and run.json writes
    logger.ts             — wraps recorder, emits to stdout
    metrics.ts            — cost, score delta, convergence check
```

---

## Design Principles

- **Determinism in the diff layer** — scores and discrepancy lists are pixel-based and stable across runs
- **Claude's non-determinism is confined** — Claude only captions and generates, never scores
- **Single source of truth** — the observability event stream feeds the terminal, the run file, and the future UI without duplicating state
- **Targeted fixes** — each iteration repairs only failing segments, preserving what is already correct
