import { generatePage } from "../baseline/agent";
import { estimateCost } from "./observability/metrics";

export interface BaselineRunResult {
  outputPath: string | null;
  durationMs: number;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
}

export async function runBaseline(
  url: string,
  outputDir: string,
): Promise<BaselineRunResult> {
  const start = Date.now();
  const { savedPath, tokensIn, tokensOut } = await generatePage(url, outputDir);
  const durationMs = Date.now() - start;

  return {
    outputPath: savedPath,
    durationMs,
    costUsd: estimateCost("claude-haiku-4-5", tokensIn, tokensOut),
    tokensIn,
    tokensOut,
  };
}
