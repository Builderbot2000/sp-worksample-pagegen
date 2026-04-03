import * as fs from "fs";
import * as path from "path";
import { assembleSkeleton, extractShellTag, extractRootCssVars, assembleNeighbour } from "./assembly";
import { generateSection } from "./section-agent";
import { screenshotSectionsBySlug, computeSectionDiscrepancies, scoreSeverity } from "../observability/fidelity";
import { buildCorrectionIterReport } from "../observability/correction-report";
import type { CrawlResult } from "../context";
import type { VisualArchDoc, IterationRecord } from "../observability/types";
import type { FidelityBudget } from "../observability/types";
import { MODELS } from "../config";

const CORRECTION_THRESHOLD = 0.70;
const PLATEAU_DELTA = 0.01;

export interface CorrectionLoopParams {
  url: string;
  assembledPath: string;
  skeleton: string;
  archDoc: VisualArchDoc;
  crawlResult: CrawlResult;
  budget: FidelityBudget;
  runDir: string;
  sectionFragments: { slug: string; fragment: string }[];
}

export interface CorrectionLoopResult {
  fragmentMap: Map<string, string>;
  scorerTokensIn: number;
  scorerTokensOut: number;
  sectionTokensIn: number;
  sectionTokensOut: number;
  iterationRecords: IterationRecord[];
}

export async function runCorrectionLoop(
  params: CorrectionLoopParams,
): Promise<CorrectionLoopResult> {
  const { url, assembledPath, skeleton, archDoc, crawlResult, budget, runDir, sectionFragments } = params;

  const fragmentMap = new Map(sectionFragments.map((f) => [f.slug, f.fragment]));
  const rootCssVars = extractRootCssVars(skeleton);
  let prevScore = 0;
  let scorerTokensIn = 0;
  let scorerTokensOut = 0;
  let sectionTokensIn = 0;
  let sectionTokensOut = 0;
  const iterationRecords: IterationRecord[] = [];

  // Sections that have already scored ≥ CORRECTION_THRESHOLD — skip VLM scoring and
  // re-generation for them in subsequent iterations.
  const settledSlugs = new Set<string>();

  const correctionsDir = path.join(runDir, "corrections");
  const sectionsDir = path.join(runDir, "sections");

  // Save source screenshots once so per-iteration HTML reports can reference them
  fs.mkdirSync(sectionsDir, { recursive: true });
  for (const section of archDoc.sections) {
    const bufs = crawlResult.sourceSectionScreenshots[section.slug];
    if (bufs?.[0]) fs.writeFileSync(path.join(sectionsDir, `source-${section.slug}.png`), bufs[0]);
  }

  for (let iter = 1; iter <= budget.maxSectionIter; iter++) {
    const genScreenshots = await screenshotSectionsBySlug({ file: assembledPath }, archDoc);

    // Build filtered views that exclude sections already settled in a prior iteration.
    // We still screenshot all sections above (needed for the HTML report and final output),
    // but we skip settled ones in VLM scoring and re-generation.
    const activeArchDoc = settledSlugs.size > 0
      ? { ...archDoc, sections: archDoc.sections.filter((s) => !settledSlugs.has(s.slug)) }
      : archDoc;
    const activeSource = settledSlugs.size > 0
      ? Object.fromEntries(Object.entries(crawlResult.sourceSectionScreenshots).filter(([k]) => !settledSlugs.has(k)))
      : crawlResult.sourceSectionScreenshots;
    const activeGen = settledSlugs.size > 0
      ? Object.fromEntries(Object.entries(genScreenshots).filter(([k]) => !settledSlugs.has(k)))
      : genScreenshots;

    const iterScreenshotsDir = path.join(correctionsDir, `iter-${iter}`);
    fs.mkdirSync(iterScreenshotsDir, { recursive: true });
    for (const [slug, bufs] of Object.entries(genScreenshots)) {
      if (bufs[0]) fs.writeFileSync(path.join(iterScreenshotsDir, `generated-${slug}.png`), bufs[0]);
    }

    const result = await computeSectionDiscrepancies(
      activeSource,
      activeGen,
      activeArchDoc,
    );
    scorerTokensIn += result.tokensIn;
    scorerTokensOut += result.tokensOut;

    const sectionsToFix = result.discrepancies.filter((d) => (d.score ?? 0) < CORRECTION_THRESHOLD);
    const slugsToFix = new Set(sectionsToFix.map((d) => d.slug.replace(/\s*\([^)]*\)\s*$/, "").trim()));

    // Sections that were VLM-scored this iteration but don’t need fixing have ≥ threshold — settle them.
    for (const slug of activeArchDoc.sections.map((s) => s.slug)) {
      if (activeGen[slug] && !slugsToFix.has(slug)) {
        if (!settledSlugs.has(slug)) {
          settledSlugs.add(slug);
          console.log(`[correct] section "${slug}" settled — skipping in future iterations`);
        }
      }
    }

    console.log(
      `[correct] iter ${iter}/${budget.maxSectionIter} — score ${result.aggregateScore.toFixed(2)}, ` +
      `fixing ${sectionsToFix.length} sections: [${[...slugsToFix].join(", ")}]`,
    );

    const iterReportPath = path.join(correctionsDir, `iter-${iter}-report.html`);
    fs.writeFileSync(
      iterReportPath,
      buildCorrectionIterReport({
        iter,
        maxIter: budget.maxSectionIter,
        url,
        aggregateScore: result.aggregateScore,
        matched: result.matched,
        unmatched: result.unmatched,
        sections: archDoc.sections,
        discrepancies: result.discrepancies,
        slugsToFix,
        correctionsDir,
        sectionsDir,
      }),
    );
    console.log(`[correct] iter ${iter} report — ${path.relative(runDir, iterReportPath)}`);

    iterationRecords.push({
      iteration: iter,
      matched: result.matched,
      unmatched: result.unmatched,
      vlmScore: result.aggregateScore,
      severity: scoreSeverity(result.aggregateScore),
      discrepancyCount: result.discrepancies.length,
    });

    if (sectionsToFix.length === 0) break;
    if (iter > 1 && result.aggregateScore - prevScore < PLATEAU_DELTA) {
      console.log(`[correct] Plateau detected — stopping.`);
      break;
    }
    prevScore = result.aggregateScore;

    const correctionResults = await Promise.all(
      sectionsToFix.map((d) => {
        const baseSlug = d.slug.replace(/\s*\([^)]*\)\s*$/, "").trim();
        const section = archDoc.sections.find((s) => s.slug === baseSlug);
        if (!section) return Promise.resolve({ slug: baseSlug, fragment: "", tokensIn: 0, tokensOut: 0 });
        const i = archDoc.sections.indexOf(section);
        const selfTag = extractShellTag(skeleton, section.slug);
        const prevSlug = archDoc.sections[i - 1]?.slug;
        const nextSlug = archDoc.sections[i + 1]?.slug;
        const prevShell = prevSlug ? extractShellTag(skeleton, prevSlug) : undefined;
        const nextShell = nextSlug ? extractShellTag(skeleton, nextSlug) : undefined;
        const prevTag = prevShell
          ? assembleNeighbour(prevShell, fragmentMap.get(prevSlug!) ?? "")
          : undefined;
        const nextTag = nextShell
          ? assembleNeighbour(nextShell, fragmentMap.get(nextSlug!) ?? "")
          : undefined;
        const shellCtx = selfTag ? { self: selfTag, prev: prevTag, next: nextTag } : undefined;
        return generateSection(
          section,
          { prev: archDoc.sections[i - 1]?.slug, next: archDoc.sections[i + 1]?.slug },
          crawlResult.sourceSectionScreenshots[section.slug] ?? [],
          crawlResult.computedStyles,
          crawlResult.fontFamilies,
          crawlResult.imageUrls,
          url,
          rootCssVars || undefined,
          shellCtx,
          d.issues,
          undefined,
          fragmentMap.get(baseSlug),
          MODELS.sectionCorrection,
        );
      }),
    );

    for (const r of correctionResults) {
      fragmentMap.set(r.slug, r.fragment);
      sectionTokensIn += r.tokensIn;
      sectionTokensOut += r.tokensOut;
    }

    const reassembled = assembleSkeleton(
      skeleton,
      [...fragmentMap].map(([slug, fragment]) => ({ slug, fragment })),
    );
    fs.writeFileSync(assembledPath, reassembled, "utf-8");
  }

  return { fragmentMap, scorerTokensIn, scorerTokensOut, sectionTokensIn, sectionTokensOut, iterationRecords };
}
