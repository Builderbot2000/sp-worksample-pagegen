const PRICING: Record<string, { input: number; output: number }> = {
  "claude-sonnet-4-6": { input: 3.0, output: 15.0 },
  "claude-haiku-4-5": { input: 0.8, output: 4.0 },
};

const FALLBACK = PRICING["claude-haiku-4-5"];

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
