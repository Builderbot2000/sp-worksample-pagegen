// ── Run data types ────────────────────────────────────────────────────────────

export interface LogLine {
  phase: string;
  ts: number;
  data?: Record<string, unknown>;
}

export interface ScreenshotPaths {
  source?: string;
  sections?: Record<string, string>;
  fidelityMain?: string;
}

export interface RunMeta {
  runId: string;
  name: string | null;
  url: string;
  startedAt: number;
  completedAt: number;
  estimatedCostUsd: number;
  screenshotPaths: ScreenshotPaths | null;
  hasFidelity: boolean;
  hasCorrection: boolean;
  skeletonScreenshotPath?: string | null;
  skeletonHtml?: string | null;
  generatedHtmlPath?: string | null;
  generatedHtml?: string | null;
}

export interface RunData {
  meta: RunMeta;
  events: LogLine[];
  /** Absolute filesystem path to the run directory (for @fs image serving). */
  fsBase: string;
}

// ── Derived state types ───────────────────────────────────────────────────────

export interface SectionState {
  status: string;
  role: string;
  order: number;
  score: number | null;
  verdict: string | null;
  genPath: string | null;
  fixing: boolean;
  durationMs: number | null;
}

export interface ScoreData {
  score: number;
  verdict: string;
  issues: string[];
  genPath: string | null;
  srcPath: string | null;
}

export interface CorrectionState {
  iter: number;
  status: string;
  activeSlugs: string[];
  scores: Record<string, ScoreData>;
  sectionFix: Record<string, string>;
  aggregateScore: number | null;
  sectionsToFix: number | null;
}

export interface PreprocessSection {
  slug: string;
  role: string;
  order: number;
  description: string;
  y: number;
  heightPx: number;
}

export interface PreprocessData {
  sections: PreprocessSection[];
  pageHeight: number;
  htmlSnippet?: string;
}

export interface SkeletonData {
  screenshotPath?: string;
}

export interface FidelityData {
  mainScore: number;
  tokensIn: number;
  tokensOut: number;
  durationMs: number;
}

export interface VisState {
  sectionOrder: string[];
  sections: Record<string, SectionState>;
  corrections: CorrectionState[];
  assemble: {status: string; data: unknown};
  fidelity: {status: string; data: FidelityData | null};
  preprocess: {status: string; data: PreprocessData | null};
  skeleton: {status: string; data: SkeletonData | null};
}

// ── State derivation (mirrors client-state.ts deriveState) ───────────────────

export function deriveState(events: LogLine[]): VisState {
  const s: VisState = {
    sectionOrder: [],
    sections: {},
    corrections: [],
    assemble: {status: 'idle', data: null},
    fidelity: {status: 'idle', data: null},
    preprocess: {status: 'idle', data: null},
    skeleton: {status: 'idle', data: null},
  };

  for (const ev of events) {
    const p = ev.phase;
    const d = (ev.data ?? {}) as Record<string, unknown>;

    if (p === 'preprocess:start') {
      s.preprocess.status = 'active';
    } else if (p === 'preprocess:complete') {
      s.preprocess.status = 'complete';
      s.preprocess.data = d as unknown as PreprocessData;
    } else if (p === 'skeleton:start') {
      s.skeleton.status = 'active';
    } else if (p === 'skeleton:complete') {
      s.skeleton.status = 'complete';
      s.skeleton.data = d as unknown as SkeletonData;
    } else if (p === 'section:start') {
      const slug = d.slug as string;
      if (!s.sectionOrder.includes(slug)) s.sectionOrder.push(slug);
      s.sections[slug] = {
        status: 'active',
        role: d.role as string,
        order: d.order as number,
        score: null,
        verdict: null,
        genPath: null,
        fixing: false,
        durationMs: null,
      };
    } else if (p === 'section:complete') {
      const slug = d.slug as string;
      if (s.sections[slug]) {
        s.sections[slug].status = 'complete';
        s.sections[slug].durationMs = d.durationMs as number;
      }
    } else if (p === 'assemble:start') {
      s.assemble.status = 'active';
    } else if (p === 'assemble:complete') {
      s.assemble.status = 'complete';
      s.assemble.data = d;
    } else if (p === 'correction-iter:start') {
      s.corrections.push({
        iter: d.iteration as number,
        status: 'active',
        activeSlugs: (d.activeSlugs as string[]) ?? [],
        scores: {},
        sectionFix: {},
        aggregateScore: null,
        sectionsToFix: null,
      });
    } else if (p === 'section-score') {
      const slug = d.slug as string;
      const iter = d.iteration as number;
      const entry: ScoreData = {
        score: d.score as number,
        verdict: d.verdict as string,
        issues: (d.issues as string[]) ?? [],
        genPath: (d.generatedScreenshotPath as string) ?? null,
        srcPath: (d.sourceScreenshotPath as string) ?? null,
      };
      for (let k = s.corrections.length - 1; k >= 0; k--) {
        if (s.corrections[k].iter === iter) {
          s.corrections[k].scores[slug] = entry;
          break;
        }
      }
      if (s.sections[slug]) {
        s.sections[slug].score = d.score as number;
        s.sections[slug].verdict = d.verdict as string;
        if (d.generatedScreenshotPath) {
          s.sections[slug].genPath = d.generatedScreenshotPath as string;
        }
      }
    } else if (p === 'section-correction:start') {
      const slug = d.slug as string;
      const iter = d.iteration as number;
      for (let k = s.corrections.length - 1; k >= 0; k--) {
        if (s.corrections[k].iter === iter) {
          s.corrections[k].sectionFix[slug] = 'fixing';
          break;
        }
      }
      if (s.sections[slug]) s.sections[slug].fixing = true;
    } else if (p === 'section-correction:complete') {
      const slug = d.slug as string;
      const iter = d.iteration as number;
      for (let k = s.corrections.length - 1; k >= 0; k--) {
        if (s.corrections[k].iter === iter) {
          s.corrections[k].sectionFix[slug] = 'fixed';
          break;
        }
      }
      if (s.sections[slug]) s.sections[slug].fixing = false;
    } else if (p === 'correction-iter:complete') {
      const iter = d.iteration as number;
      for (let k = s.corrections.length - 1; k >= 0; k--) {
        if (s.corrections[k].iter === iter) {
          s.corrections[k].status = 'complete';
          s.corrections[k].aggregateScore = d.aggregateScore as number;
          s.corrections[k].sectionsToFix = d.sectionsToFix as number;
          break;
        }
      }
    } else if (p === 'fidelity:start') {
      s.fidelity.status = 'active';
    } else if (p === 'fidelity:complete') {
      s.fidelity.status = 'complete';
      s.fidelity.data = d as unknown as FidelityData;
    }
  }

  return s;
}
