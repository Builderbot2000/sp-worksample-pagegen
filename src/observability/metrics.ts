const PRICING: Record<string, { input: number; output: number }> = {
  "claude-sonnet-4-6": { input: 3.0, output: 15.0 },
  "claude-haiku-4-5": { input: 0.8, output: 4.0 },
};

const FALLBACK = PRICING["claude-haiku-4-5"];

// Per-model min/max output token caps, scaled by source HTML size.
// 80_000 chars is the truncation ceiling in context.ts and runBaseline.
const TOKEN_CAPS: Record<string, { min: number; max: number }> = {
  "claude-haiku-4-5": { min: 8_000, max: 16_000 },
  "claude-sonnet-4-6": { min: 16_000, max: 64_000 },
};
const TOKEN_CAPS_FALLBACK = TOKEN_CAPS["claude-haiku-4-5"];

export function estimateMaxTokens(htmlLength: number, model: string): number {
  const caps = TOKEN_CAPS[model] ?? TOKEN_CAPS_FALLBACK;
  const ratio = Math.min(1, Math.max(0, htmlLength / 80_000));
  return Math.round(caps.min + ratio * (caps.max - caps.min));
}

export function estimateCost(
  model: string,
  tokensIn: number,
  tokensOut: number,
): number {
  const pricing = PRICING[model] ?? FALLBACK;
  return (
    (tokensIn / 1_000_000) * pricing.input +
    (tokensOut / 1_000_000) * pricing.output
  );
}

export function checkConvergence(
  prevScore: number,
  currScore: number,
  threshold: number,
): boolean {
  return Math.abs(currScore - prevScore) < threshold;
}

// \u2500\u2500\u2500 Iteration budget \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

import type { FidelityBudget } from "../agent";

/**
 * Compute the resolved iteration count for a run, scaled to the source page's
 * heading count, clamped within the mode's min/max range.
 *
 * Formula:
 *   structPassesNeeded = ceil(headingCount * 0.8 / structureBatchSize)
 *   rawBudget          = structPassesNeeded + 2  (+1 content, +1 visual minimum)
 *   resolvedMaxIter    = clamp(rawBudget, minIterations, maxIterations)
 */
export function computeIterBudget(
  headingCount: number,
  budget: FidelityBudget,
): { resolvedMaxIter: number; rawBudget: number } {
  if (budget.maxIterations === 0 || budget.structureBatchSize === undefined) {
    return { resolvedMaxIter: 0, rawBudget: 0 };
  }
  const structPassesNeeded = Math.ceil((headingCount * 0.8) / budget.structureBatchSize);
  const rawBudget = structPassesNeeded + 2;
  const resolvedMaxIter = Math.max(
    budget.minIterations,
    Math.min(budget.maxIterations, rawBudget),
  );
  return { resolvedMaxIter, rawBudget };
}
