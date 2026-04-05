# Project Overview

A CLI tool that uses Claude to generate self-contained Tailwind CSS pages from a source URL. The central quality goal is **fidelity** — how closely the generated page reproduces the source page's layout, copy, images, and visual theme.

Source: [`src/cli.ts`](../src/cli.ts) · [`src/agent.ts`](../src/agent.ts)

---

## CLI

```bash
npm run generate -- <url> [options]
```

| Option | Description |
|---|---|
| `--name <label>` | Human-readable label for the run (used in run ID and file names) |
| `--quality <mode>` | `draft` / `standard` / `quality` — controls correction budget (default: `standard`) |
| `--correction` | Run the per-section correction loop after initial generation |
| `--baseline` | Also run the single-pass baseline agent for cost/quality comparison |
| `--open` | Open the generated file in the browser after writing |

The run ID is `<timestamp>-<name-or-url-slug>`. All output lands in `output/<runId>/`.

---

## Output Structure

```
output/<runId>/
  run.ndjson           — streaming NDJSON event log (all phases)
  run.json             — structured run record (no base64 images)
  summary.json         — same as run.json
  report.html          — HTML report with scores, costs, iteration table, thumbnails
  source.png           — full-page screenshot of the source URL
  main/
    <name>-skeleton.html
    <name>.html        — final assembled page
  sections/
    source-<slug>.png  — per-section screenshot of the source (one per section)
  baseline/            — present if --baseline
    <name>.html
  corrections/         — present if --correction
    iter-1-report.html
    iter-1/
      generated-<slug>.png
    iter-2-report.html
    ...
```

---

## Entry Point: `src/agent.ts`

`generatePage(url, opts)` is the top-level orchestrator. It:

1. Creates the output directory and initialises `Recorder` and `Logger`.
2. Calls `crawlAndPreprocess` (Stage 0).
3. Applies the quality budget from `QUALITY_BUDGETS[opts.quality]`.
4. Runs `runSkeletonAgent` (Stage 1).
5. Launches all `generateSection` calls in parallel via `Promise.all` (Stage 2).
6. Assembles the skeleton with all fragments via `assembleSkeleton`.
7. Optionally runs `runCorrectionLoop` (Stage 2.5).
8. Optionally runs `runBaseline` for comparison.
9. Calls `collectFidelityMetrics` (Stage 3) and `generateReport`.
10. Writes `run.json`, `summary.json`, and finalises the NDJSON log.

Cost accounting is computed at the end from summed token counts across all stages; see [Observability](/observability).
