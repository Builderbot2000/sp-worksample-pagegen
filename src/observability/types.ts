// ─── Severity ────────────────────────────────────────────────────────────────

export type Severity = "high" | "medium" | "low";

// ─── Fidelity mode ────────────────────────────────────────────────────────────

export type FidelityMode = "minimal" | "fast" | "balanced" | "high" | "maximal";

export interface FidelityBudget {
  /** Hard cap for initial generation. null = use estimateMaxTokens() dynamically. */
  generateMaxTokens: number | null;
  /** Max correction iterations per section. 0 = no correction loop. */
  maxSectionIter: number;
}

// ─── Visual architecture ──────────────────────────────────────────────────────

export interface SectionSpec {
  slug: string;
  description: string;
  role: string;
  order: number;
  /** Pixel height of the section in the source page at the crawl viewport. */
  heightPx: number;
}

export interface VisualArchDoc {
  sections: SectionSpec[];
  fixedElements: string[];
  backgroundDescription: string;
}

// ─── Section discrepancy ─────────────────────────────────────────────────────

export interface SectionDiscrepancy {
  slug: string;
  type: "missing" | "visual";
  severity: "high" | "medium";
  issues: string[];
  relativePosition?: number;
  score?: number;
}

// ─── Phase data interfaces ────────────────────────────────────────────────────

export interface FetchData {
  url: string;
  htmlBytes: number;
  truncated: boolean;
  enriched?: boolean;
  imageCount?: number;
  fontCount?: number;
  sectionCount?: number;
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
  matched: number;
  unmatched: number;
  discrepancyCount: number;
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
  | { phase: "fix"; timestamp: number; data: FixData };

// ─── Run records ─────────────────────────────────────────────────────────────

export interface IterationRecord {
  iteration: number;
  matched: number;
  unmatched: number;
  vlmScore: number;
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

export type VlmVerdict = "close" | "partial" | "distant";

export interface VlmFidelityScore {
  verdict: VlmVerdict;
  score: number;
  sections: Record<string, "match" | "partial" | "missing">;
  issues: string[];
}

export interface FidelityMetrics {
  sourceScreenshotBase64: string;
  mainScreenshotBase64: string;
  baselineScreenshotBase64?: string;
  mainVlmScore: VlmFidelityScore;
  baselineVlmScore?: VlmFidelityScore;
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
