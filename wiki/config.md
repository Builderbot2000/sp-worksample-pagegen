# Configuration

Source: [`src/config.ts`](../src/config.ts)

All model names and quality budgets are centralised here. No pipeline module contains a hardcoded model string.

---

## Models

```ts
export const MODELS = {
  skeleton:          "claude-sonnet-4-6",  // Stage 1 — skeleton generation
  sectionInitial:    "claude-sonnet-4-6",  // Stage 2 — initial section generation
  sectionCorrection: "claude-haiku-4-5",   // Stage 2.5 — correction re-generation
  vlmScorer:         "claude-sonnet-4-6",  // VLM fidelity scorer
  caption:           "claude-haiku-4-5",   // Stage 0 — section captions during crawl
  baseline:          "claude-haiku-4-5",   // Optional single-pass baseline agent
};
```

To swap a model across the entire pipeline, edit this file only. Every consumer imports from `config.ts` via the `MODELS` constant.

---

## Quality budgets

```ts
export const QUALITY_BUDGETS: Record<QualityMode, QualityBudget> = {
  draft:    { maxCorrectionIter: 0 },  // no correction loop
  standard: { maxCorrectionIter: 2 },  // default
  quality:  { maxCorrectionIter: 3 },
};
```

`maxCorrectionIter` controls how many times the [correction loop](/correction) is allowed to run. Used via `--quality` on the CLI.

---

## Pricing and token caps

Pricing rates and per-model output token caps live in [`src/observability/metrics.ts`](../src/observability/metrics.ts) — see [Observability](/observability) for details.
