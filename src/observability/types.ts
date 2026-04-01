export type Severity = "high" | "medium" | "low";

// ─── Per-phase data shapes ────────────────────────────────────────────────────

export interface FetchData {
  url: string;
  htmlBytes: number;
  truncated: boolean;
}

export interface GenerateData {
  model: string;
  tokensIn: number;
  tokensOut: number;
  durationMs: number;
  outputFile: string;
}

export interface ScreenshotData {
  target: string;
  imageBytes: number;
  durationMs: number;
}

export interface DiffData {
  iteration: number;
  overallScore: number;
  diffPixels: number;
  totalPixels: number;
}

export interface CaptionData {
  iteration: number;
  tokensIn: number;
  tokensOut: number;
  discrepancies: Array<{ issue: string; severity: Severity }>;
}

export interface FixData {
  iteration: number;
  model: string;
  tokensIn: number;
  tokensOut: number;
  durationMs: number;
  htmlSizeDelta: number;
}

// ─── Discriminated-union log line ────────────────────────────────────────────

export type LogLine =
  | { phase: "fetch"; timestamp: number; data: FetchData }
  | { phase: "generate"; timestamp: number; data: GenerateData }
  | { phase: "screenshot"; timestamp: number; data: ScreenshotData }
  | { phase: "diff"; timestamp: number; data: DiffData }
  | { phase: "caption"; timestamp: number; data: CaptionData }
  | { phase: "fix"; timestamp: number; data: FixData };

// ─── Baseline comparison ──────────────────────────────────────────────────────

export interface BaselineComparison {
  baselineScore: number;
  baselineCostUsd: number;
  baselineDurationMs: number;
  baselineThumbnail: string; // base64 PNG
  mainScore: number;
  mainCostUsd: number;
  mainDurationMs: number;
  mainThumbnail: string; // base64 PNG
}

// ─── Run-level structures ─────────────────────────────────────────────────────

export interface IterationRecord {
  iteration: number;
  overallScore: number;
  severity: Severity;
  diffPixels: number;
  totalPixels: number;
  discrepancyCount: number;
}

export interface RunRecord {
  runId: string;
  url: string;
  startedAt: number;
  completedAt: number;
  iterations: IterationRecord[];
  estimatedCostUsd: number;
  baseline?: BaselineComparison;
}
