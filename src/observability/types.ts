// ─── Severity ────────────────────────────────────────────────────────────────

export type Severity = "high" | "medium" | "low";

// ─── Phase data interfaces ────────────────────────────────────────────────────

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
  vlmScore: number;
  vlmVerdict: VlmVerdict;
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

// ─── LogLine discriminated union ──────────────────────────────────────────────

export type LogLine =
  | { phase: "fetch"; timestamp: number; data: FetchData }
  | { phase: "generate"; timestamp: number; data: GenerateData }
  | { phase: "screenshot"; timestamp: number; data: ScreenshotData }
  | { phase: "diff"; timestamp: number; data: DiffData }
  | { phase: "caption"; timestamp: number; data: CaptionData }
  | { phase: "fix"; timestamp: number; data: FixData };

// ─── Run records ─────────────────────────────────────────────────────────────

export interface IterationRecord {
  iteration: number;
  vlmScore: number;
  vlmVerdict: VlmVerdict;
  severity: Severity;
  discrepancyCount: number;
}

export interface BaselineComparison {
  baselineScore: number;
  baselineCostUsd: number;
  baselineDurationMs: number;
  baselineThumbnail: string;
  mainScore: number;
  mainCostUsd: number;
  mainDurationMs: number;
  mainThumbnail: string;
}

// ─── Fidelity metrics ────────────────────────────────────────────────────────

export interface DomInfo {
  headings: Array<{ tag: string; text: string }>;
  paragraphs: number;
  images: number;
  buttons: number;
  sections: number;
  links: number;
  totalTextLength: number;
}

export type VlmVerdict = "close" | "partial" | "distant";

export interface VlmFidelityScore {
  verdict: VlmVerdict;
  score: number;
  sections: Record<string, "match" | "partial" | "missing">;
  issues: string[];
}

export interface DomDiffResult {
  missingHeadings: string[];
  extraHeadings: string[];
  imageDelta: number;
  buttonDelta: number;
  sectionDelta: number;
  textCoverageRatio: number;
  score: number;
}

export interface FidelityMetrics {
  sourceScreenshotBase64: string;
  mainScreenshotBase64: string;
  baselineScreenshotBase64?: string;
  mainVlmScore: VlmFidelityScore;
  baselineVlmScore?: VlmFidelityScore;
  mainDomDiff: DomDiffResult;
  baselineDomDiff?: DomDiffResult;
}

// ─── Run record ───────────────────────────────────────────────────────────────

export interface RunRecord {
  runId: string;
  name?: string;
  url: string;
  startedAt: number;
  completedAt: number;
  iterations: IterationRecord[];
  estimatedCostUsd: number;
  baseline?: BaselineComparison;
  fidelityMetrics?: FidelityMetrics;
}
