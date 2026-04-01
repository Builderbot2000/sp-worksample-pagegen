// Pricing (USD per million tokens)
const PRICING: Record<string, { input: number; output: number }> = {
  "claude-sonnet-4-6": { input: 3.0, output: 15.0 },
  "claude-haiku-4-5": { input: 0.8, output: 4.0 },
};
const DEFAULT_PRICING = PRICING["claude-sonnet-4-6"];

export function estimateCost(
  model: string,
  tokensIn: number,
  tokensOut: number,
): number {
  const p = PRICING[model] ?? DEFAULT_PRICING;
  return (
    (tokensIn / 1_000_000) * p.input +
    (tokensOut / 1_000_000) * p.output
  );
}

export function checkConvergence(
  prevScore: number,
  currScore: number,
  threshold: number,
): boolean {
  return Math.abs(currScore - prevScore) < threshold;
}
