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
