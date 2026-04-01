// Sonnet 4-6 pricing (USD per million tokens)
const SONNET_INPUT_COST_PER_M = 3.0;
const SONNET_OUTPUT_COST_PER_M = 15.0;

export function estimateCost(
  _model: string,
  tokensIn: number,
  tokensOut: number,
): number {
  return (
    (tokensIn / 1_000_000) * SONNET_INPUT_COST_PER_M +
    (tokensOut / 1_000_000) * SONNET_OUTPUT_COST_PER_M
  );
}

export function checkConvergence(
  prevScore: number,
  currScore: number,
  threshold: number,
): boolean {
  return Math.abs(currScore - prevScore) < threshold;
}
