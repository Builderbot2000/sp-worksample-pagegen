// ─── Severity ────────────────────────────────────────────────────────────────

export type Severity = "high" | "medium" | "low";

// ─── Quality mode ────────────────────────────────────────────────────────────

export type QualityMode = "draft" | "standard" | "quality";

export interface QualityBudget {
  /** Max correction iterations per section. 0 = no correction loop. */
  maxCorrectionIter: number;
}

// ─── Visual architecture ──────────────────────────────────────────────────────

export interface SectionSpec {
  slug: string;
  description: string;
  role: string;
  order: number;
  /** Pixel y offset of the section in the source page at the crawl viewport. */
  y: number;
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

// ─── VLM verdict + section score entry ───────────────────────────────────────

export type VlmVerdict = "close" | "partial" | "distant";

export interface SectionScoreEntry {
  score: number;
  verdict: VlmVerdict;
  issues: string[];
}

// ─── Phase data interfaces ────────────────────────────────────────────────────

export interface RunStartData {
  runId: string;
  url: string;
  qualityMode: QualityMode;
  correctionEnabled: boolean;
  baselineEnabled: boolean;
}

export interface RunCompleteData {
  runId: string;
  durationMs: number;
  estimatedCostUsd: number;
  outputFile: string | null;
}

export interface PreprocessStartData {
  url: string;
}

export interface PreprocessCompleteData {
  url: string;
  htmlBytes: number;
  truncated: boolean;
  sectionCount: number;
  imageCount: number;
  fontCount: number;
  captionTokensIn: number;
  captionTokensOut: number;
  durationMs: number;
  /** Full section specs including y/heightPx for bounding box overlay. */
  sections?: SectionSpec[];
  /** Crawl viewport width in pixels. */
  viewportWidth?: number;
  /** Full page scroll height in pixels (for correct bbox ↔ screenshot alignment). */
  pageHeight?: number;
  /** First chars of source HTML for the Start slide. */
  htmlSnippet?: string;
}

export interface SkeletonStartData {
  model: string;
}

export interface SkeletonCompleteData {
  model: string;
  tokensIn: number;
  tokensOut: number;
  durationMs: number;
  outputFile: string;
  /** Path to skeleton preview screenshot relative to run dir, if available. */
  screenshotPath?: string;
}

export interface SectionStartData {
  slug: string;
  role: string;
  order: number;
  model: string;
}

export interface SectionCompleteData {
  slug: string;
  role: string;
  order: number;
  model: string;
  tokensIn: number;
  tokensOut: number;
  durationMs: number;
}

export interface AssembleStartData {
  sectionCount: number;
}

export interface AssembleCompleteData {
  outputFile: string;
  htmlSizeBytes: number;
  durationMs: number;
}

export interface CorrectionIterStartData {
  iteration: number;
  activeSlugs: string[];
}

export interface CorrectionIterCompleteData {
  iteration: number;
  aggregateScore: number;
  sectionsToFix: number;
  durationMs: number;
}

export interface SectionScoreData {
  iteration: number;
  slug: string;
  score: number;
  verdict: VlmVerdict;
  issues: string[];
  generatedScreenshotPath?: string;
  sourceScreenshotPath?: string;
}

export interface SectionCorrectionStartData {
  iteration: number;
  slug: string;
  prevScore: number;
  model: string;
}

export interface SectionCorrectionCompleteData {
  iteration: number;
  slug: string;
  tokensIn: number;
  tokensOut: number;
  durationMs: number;
}

export interface FidelityStartData {
  // intentionally empty
}

export interface FidelityCompleteData {
  mainScore: number;
  baselineScore?: number;
  tokensIn: number;
  tokensOut: number;
  durationMs: number;
}

export interface BaselineStartData {
  model: string;
}

export interface BaselineCompleteData {
  model: string;
  tokensIn: number;
  tokensOut: number;
  durationMs: number;
  outputFile: string;
}

// ─── LogLine discriminated union ──────────────────────────────────────────────

export type LogLine =
  | { phase: "run:start"; timestamp: number; data: RunStartData }
  | { phase: "run:complete"; timestamp: number; data: RunCompleteData }
  | { phase: "preprocess:start"; timestamp: number; data: PreprocessStartData }
  | { phase: "preprocess:complete"; timestamp: number; data: PreprocessCompleteData }
  | { phase: "skeleton:start"; timestamp: number; data: SkeletonStartData }
  | { phase: "skeleton:complete"; timestamp: number; data: SkeletonCompleteData }
  | { phase: "section:start"; timestamp: number; data: SectionStartData }
  | { phase: "section:complete"; timestamp: number; data: SectionCompleteData }
  | { phase: "assemble:start"; timestamp: number; data: AssembleStartData }
  | { phase: "assemble:complete"; timestamp: number; data: AssembleCompleteData }
  | { phase: "correction-iter:start"; timestamp: number; data: CorrectionIterStartData }
  | { phase: "correction-iter:complete"; timestamp: number; data: CorrectionIterCompleteData }
  | { phase: "section-score"; timestamp: number; data: SectionScoreData }
  | { phase: "section-correction:start"; timestamp: number; data: SectionCorrectionStartData }
  | { phase: "section-correction:complete"; timestamp: number; data: SectionCorrectionCompleteData }
  | { phase: "fidelity:start"; timestamp: number; data: FidelityStartData }
  | { phase: "fidelity:complete"; timestamp: number; data: FidelityCompleteData }
  | { phase: "baseline:start"; timestamp: number; data: BaselineStartData }
  | { phase: "baseline:complete"; timestamp: number; data: BaselineCompleteData };

// ─── Run records ─────────────────────────────────────────────────────────────

export interface IterationRecord {
  iteration: number;
  matched: number;
  unmatched: number;
  vlmScore: number;
  severity: Severity;
  discrepancyCount: number;
  sectionScores: Record<string, SectionScoreEntry>;
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

// ─── Screenshot paths (disk paths relative to runDir) ────────────────────────

export interface ScreenshotPaths {
  source: string;
  sections: Record<string, string>;
  fidelityMain?: string;
  fidelityBaseline?: string;
  /** Per-section crops of the generated page fed to the VLM scorer. */
  fidelitySections?: Record<string, string>;
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
  screenshotPaths?: ScreenshotPaths;
  baseline?: BaselineComparison;
  fidelityMetrics?: FidelityMetrics;
}
