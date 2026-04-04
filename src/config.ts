import type { QualityMode, QualityBudget } from "./observability/types";

/**
 * Quality mode budgets — controls how many correction iterations run per section.
 * draft: no corrections (fast single-pass run)
 * standard: up to 2 correction passes (default)
 * quality: up to 3 correction passes
 */
export const QUALITY_BUDGETS: Record<QualityMode, QualityBudget> = {
  draft:    { maxCorrectionIter: 0 },
  standard: { maxCorrectionIter: 2 },
  quality:  { maxCorrectionIter: 3 },
};

/**
 * Model configuration — edit this file to swap models across the entire pipeline.
 * No model name strings live in operational code.
 */
export const MODELS = {
  /** Stage 1 — structural skeleton generation */
  skeleton: "claude-sonnet-4-6",
  /** Stage 2 — initial section generation (parallel) */
  sectionInitial: "claude-sonnet-4-6",
  /** Stage 2.5 — correction pass re-generation */
  sectionCorrection: "claude-haiku-4-5",
  /** VLM fidelity scorer (section comparison) */
  vlmScorer: "claude-sonnet-4-6",
  /** Section captioning during crawl preprocessing */
  caption: "claude-haiku-4-5",
  /** Single-pass baseline generation */
  baseline: "claude-haiku-4-5",
} as const;
