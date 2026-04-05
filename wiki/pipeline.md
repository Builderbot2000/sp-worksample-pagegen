# Pipeline Overview

The pipeline transforms a public URL into a self-contained Tailwind CSS page through five sequential stages. Stages 0–2 are always active; Stages 2.5 and 3 are conditional.

---

## Stages

```mermaid
flowchart TD
    URL([URL])

    subgraph S0["Stage 0 — Crawl & Preprocess"]
        P1["Puppeteer crawl\nnetworkidle2 · 1280×900"]
        P2["Section detection\nDOM + recursive descent"]
        P3["Screenshots\nfull-page + per-section"]
        P4["VLM captions\nclaude-haiku-4-5"]
        P1 --> P2 --> P3 --> P4
    end

    subgraph S1["Stage 1 — Skeleton"]
        SK1[":root vars\nTailwind config · fonts"]
        SK2["Empty section shells\ndata-section-slug per slot"]
        SK1 --> SK2
    end

    subgraph S23["Stages 2–2.5 — Generation & Correction"]
        direction TB

        subgraph SGEN["2 · Parallel Section Generation — Promise.all"]
            direction LR
            SA["section\nagent"]
            SB["section\nagent"]
            SC["section\nagent ×N"]
            ASM["assembleSkeleton\nfragments → shells"]
            SA & SB & SC --> ASM
        end

        subgraph SCORR["2.5 · Correction Loop — optional · --correction"]
            SC1["Screenshot assembled page\nper-section clips"]
            SC2["Score unsettled sections\nVLM batches of 8"]
            SC3{"score ≥ 0.70?"}
            SC4["Settle section\nskip in future iters"]
            SC5["Re-generate with issues\nsurgical fix on currentHtml"]
            SC6["Reassemble skeleton\nwrite to disk"]
            SC7{"Plateau or\nmax iters?"}
            SC1 --> SC2 --> SC3
            SC3 -- yes --> SC4
            SC3 -- no --> SC5
            SC4 & SC5 --> SC6 --> SC7
            SC7 -- no --> SC1
        end

        SGEN --> SCORR
    end

    subgraph S3["Stage 3 — Fidelity & Report"]
        F1["Final VLM scoring\nper-section + aggregate"]
        HUMAN["report.html · visualizer.html\nhuman-readable"]
        MACHINE["run.json · FidelityMetrics\nmachine-readable"]
        F1 --> HUMAN & MACHINE
    end

    URL --> S0 --> S1 --> S23 --> S3
```

---

## Data contracts between stages

**Stage 0 → 1+2:** `CrawlResult` from `context.ts` — carries `html`, `screenshotBase64`, `visualArchDoc`, `sourceSectionScreenshots`, `computedStyles`, `fontFamilies`, `imageUrls`, `svgs`, and `fixedElementsHtml`.

**Stage 1 → 2:** Skeleton HTML string. Each section slot is a shell element tagged with `data-section-slug="<slug>"` and `data-section-order="<N>"`. A `:root` CSS custom-property block encodes brand colours and fonts for section agents to inherit.

**Stage 2 → 2.5/3:** `fragmentMap` — a `Map<slug, htmlFragment>` updated in-place by the correction loop. `assembleSkeleton` merges the current map into the skeleton on each write.

**Stage 3:** `FidelityMetrics` is attached to `RunRecord` and written to `run.json`.

---

## Model assignments

All model strings live in [`src/config.ts`](/config). No pipeline module contains a hardcoded model name.

| Stage | Model constant | Default |
|---|---|---|
| Skeleton | `MODELS.skeleton` | `claude-sonnet-4-6` |
| Section initial | `MODELS.sectionInitial` | `claude-sonnet-4-6` |
| Section correction | `MODELS.sectionCorrection` | `claude-haiku-4-5` |
| VLM scorer | `MODELS.vlmScorer` | `claude-sonnet-4-6` |
| Section captions | `MODELS.caption` | `claude-haiku-4-5` |
| Baseline | `MODELS.baseline` | `claude-haiku-4-5` |

---

## Module map

| File | Responsibility |
|---|---|
| `src/context.ts` | Stage 0 — Puppeteer crawl, section detection, VLM captions |
| `src/pipeline/skeleton-agent.ts` | Stage 1 — skeleton LLM call |
| `src/pipeline/section-agent.ts` | Stage 2 — per-section LLM call |
| `src/pipeline/assembly.ts` | Fragment injection, neighbour context, CSS var extraction |
| `src/pipeline/correction-loop.ts` | Stage 2.5 — scoring and re-generation loop |
| `src/pipeline/baseline-agent.ts` | Optional single-pass baseline (Haiku) |
| `src/observability/fidelity.ts` | Stage 3 — VLM section scoring + final metrics |
| `src/observability/metrics.ts` | Cost accounting, `estimateMaxTokens` |
| `src/observability/recorder.ts` | NDJSON stream + `run.json` / `summary.json` writer |
| `src/observability/logger.ts` | Typed phase event emitter + terminal formatter |
| `src/observability/report.ts` | HTML report generation |
| `src/config.ts` | Model names and quality budgets |
| `src/image.ts` | `resizeForVlm` — 1024px JPEG resize for all VLM calls |
| `src/utils.ts` | `slugify`, `urlSlug`, `escHtml` |
