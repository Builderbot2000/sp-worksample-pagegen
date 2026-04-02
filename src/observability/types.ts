// ─── Severity ────────────────────────────────────────────────────────────────

export type Severity = "high" | "medium" | "low";

// ─── Fidelity level ───────────────────────────────────────────────────────────

export type FidelityLevel = "structure" | "content" | "visual";

// ─── Fidelity mode ────────────────────────────────────────────────────────────

export type FidelityMode = "minimal" | "fast" | "balanced" | "high" | "maximal";

// ─── Phase data interfaces ────────────────────────────────────────────────────

export interface FetchData {
  url: string;
  htmlBytes: number;
  truncated: boolean;
  enriched?: boolean;
  imageCount?: number;
  fontCount?: number;
  sourceHeadings?: number;
  resolvedMaxIter?: number;
  fidelityMode?: FidelityMode;
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
  level?: FidelityLevel;
  domScore?: number;
  compositeScore?: number;
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
  level: FidelityLevel;
  vlmScore: number;
  vlmVerdict: VlmVerdict;
  domScore: number;
  compositeScore: number;
  severity: Severity;
  discrepancyCount: number;
  vlmChunks?: VlmChunkScore[];
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
  headings: Array<{ tag: string; text: string; y: number }>;
  paragraphs: number;
  images: number;
  buttons: number;
  sections: number;
  links: number;
  totalTextLength: number;
}

export type VlmVerdict = "close" | "partial" | "distant";

// ─── Chunked VLM scoring ─────────────────────────────────────────────────────

export interface VlmChunkScore {
  heading: string;
  score: number;
  verdict: VlmVerdict;
  issues: string[];
}

export interface ChunkedVlmScore {
  chunks: VlmChunkScore[];
  aggregateScore: number;
  aggregateVerdict: VlmVerdict;
}

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
  headingRetentionRatio: number;
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
