import * as fs from "fs";
import * as path from "path";
import { slugify, urlSlug } from "./utils";
import { crawlAndPreprocess } from "./context";
import { Recorder } from "./observability/recorder";
import { Logger } from "./observability/logger";
import { estimateCost } from "./observability/metrics";
import { collectFidelityMetrics } from "./observability/fidelity";
import { generateReport } from "./observability/report";
import type { RunRecord, QualityMode, QualityBudget } from "./observability/types";
export type { QualityBudget };
import { formatArchDoc, assembleSkeleton, extractRootCssVars, extractShellTag, assembleNeighbour } from "./pipeline/assembly";
export { formatArchDoc, assembleSkeleton, extractShellTag, assembleNeighbour };
import { runSkeletonAgent } from "./pipeline/skeleton-agent";
import { generateSection } from "./pipeline/section-agent";
export { generateSection };
import { runBaseline } from "./pipeline/baseline-agent";
import { runCorrectionLoop } from "./pipeline/correction-loop";
import { MODELS, QUALITY_BUDGETS } from "./config";

export const GENERATE_MODEL = MODELS.sectionInitial;
const BASELINE_MODEL = MODELS.baseline;


const OUTPUT_DIR = path.resolve(__dirname, "..", "output");

export interface GenerateOptions {
  name?: string;
  quality?: QualityMode;
  baseline?: boolean;
  correction?: boolean;
  open?: boolean;
}

export async function generatePage(url: string, opts: GenerateOptions = {}): Promise<string | null> {
  const startedAt = Date.now();
  const runId = `${startedAt}-${opts.name ? slugify(opts.name) : urlSlug(url)}`;
  const runDir = path.join(OUTPUT_DIR, runId);
  const mainDir = path.join(runDir, "main");
  fs.mkdirSync(mainDir, { recursive: true });

  const recorder = new Recorder(runDir);
  const logger = new Logger(recorder);

  let savedPath: string | null = null;

  const crawlResult = await crawlAndPreprocess(url);
  const archDoc = crawlResult.visualArchDoc;
  const budget = QUALITY_BUDGETS[opts.quality ?? "standard"];

  logger.log({
    phase: "fetch",
    timestamp: Date.now(),
    data: {
      url,
      htmlBytes: crawlResult.html.length,
      truncated: crawlResult.truncated,
      enriched: true,
      imageCount: crawlResult.imageUrls.length,
      fontCount: crawlResult.fontFamilies.length,
      sectionCount: archDoc.sections.length,
      qualityMode: opts.quality ?? "standard",
    },
  });

  const record: RunRecord = {
    runId,
    ...(opts.name ? { name: opts.name } : {}),
    url,
    startedAt,
    completedAt: 0,
    iterations: [],
    estimatedCostUsd: 0,
  };

  const generateStart = Date.now();
  let scorerTokensIn = 0;
  let scorerTokensOut = 0;

  // ── Stage 1: Skeleton Agent ──────────────────────────────────────────────────────
  console.log(`
[gen] Stage 1 — skeleton (${GENERATE_MODEL})...`);
  const skeletonResult = await runSkeletonAgent({ url, crawlResult, mainDir });
  if (!skeletonResult) {
    console.error("[gen] Skeleton agent produced no output — aborting.");
    return null;
  }
  const { skeletonHtml, skeletonBasename, tokensIn: skeletonIn, tokensOut: skeletonOut } = skeletonResult;
  console.log(`[gen] Skeleton done — ${skeletonIn} in / ${skeletonOut} out tokens`);

  // ── Stage 2: Section Agents (parallel) ──────────────────────────────────────
  console.log(`
[gen] Stage 2 — ${archDoc.sections.length} section agents (parallel)...`);
  const rootCssVars = extractRootCssVars(skeletonHtml);
  const sectionResults = await Promise.all(
    archDoc.sections.map((section, i) => {
      const selfTag = extractShellTag(skeletonHtml, section.slug);
      const prevTag = i > 0 ? extractShellTag(skeletonHtml, archDoc.sections[i - 1].slug) : undefined;
      const nextTag = i < archDoc.sections.length - 1 ? extractShellTag(skeletonHtml, archDoc.sections[i + 1].slug) : undefined;
      const shellContext = selfTag ? { self: selfTag, prev: prevTag, next: nextTag } : undefined;
      return generateSection(
        section,
        { prev: archDoc.sections[i - 1]?.slug, next: archDoc.sections[i + 1]?.slug },
        crawlResult.sourceSectionScreenshots[section.slug] ?? [],
        crawlResult.computedStyles,
        crawlResult.fontFamilies,
        crawlResult.imageUrls,
        url,
        rootCssVars || undefined,
        shellContext,
      );
    }),
  );

  const sectionFragments = sectionResults.map((r) => ({ slug: r.slug, fragment: r.fragment }));
  const sectionTokensIn = sectionResults.reduce((sum, r) => sum + r.tokensIn, 0);
  const sectionTokensOut = sectionResults.reduce((sum, r) => sum + r.tokensOut, 0);
  console.log(`[gen] Sections done — ${sectionTokensIn} in / ${sectionTokensOut} out tokens (${sectionResults.length} agents)`);

  // ── Stage 3: Programmatic Assembly ─────────────────────────────────────────────
  console.log(`
[gen] Stage 3 — assembling...`);
  const assembledHtml = assembleSkeleton(skeletonHtml, sectionFragments);
  const assembledFilename = `${skeletonBasename}.html`;
  const assembledPath = path.join(mainDir, assembledFilename);
  fs.writeFileSync(assembledPath, assembledHtml, "utf-8");
  savedPath = assembledPath;
  console.log(`[gen] Assembled — ${assembledPath}`);

  let correctionSectionTokensIn = 0;
  let correctionSectionTokensOut = 0;

  // ── Stage 2.5: Per-section correction loop ──────────────────────────────────────────
  if (opts.correction && budget.maxCorrectionIter > 0) {
    const loopResult = await runCorrectionLoop({
      url,
      assembledPath,
      skeleton: skeletonHtml,
      archDoc,
      crawlResult,
      budget,
      runDir,
      sectionFragments,
    });
    scorerTokensIn += loopResult.scorerTokensIn;
    scorerTokensOut += loopResult.scorerTokensOut;
    correctionSectionTokensIn = loopResult.sectionTokensIn;
    correctionSectionTokensOut = loopResult.sectionTokensOut;
    for (const iterRecord of loopResult.iterationRecords) {
      record.iterations.push(iterRecord);
      logger.log({
        phase: "diff",
        timestamp: Date.now(),
        data: {
          iteration: iterRecord.iteration,
          vlmScore: iterRecord.vlmScore,
          matched: iterRecord.matched,
          unmatched: iterRecord.unmatched,
          discrepancyCount: iterRecord.discrepancyCount,
        },
      });
    }
  }

  const generateDurationMs = Date.now() - generateStart;
  const generateTokensIn = skeletonIn + sectionTokensIn + correctionSectionTokensIn;
  const generateTokensOut = skeletonOut + sectionTokensOut + correctionSectionTokensOut;

  logger.log({
    phase: "generate",
    timestamp: Date.now(),
    data: {
      model: GENERATE_MODEL,
      tokensIn: generateTokensIn,
      tokensOut: generateTokensOut,
      durationMs: generateDurationMs,
      outputFile: savedPath ?? "",
    },
  });

  record.completedAt = Date.now();
  record.estimatedCostUsd =
    estimateCost(GENERATE_MODEL, generateTokensIn, generateTokensOut) +
    estimateCost(MODELS.caption, crawlResult.captionTokensIn, crawlResult.captionTokensOut) +
    estimateCost(GENERATE_MODEL, scorerTokensIn, scorerTokensOut);

  let baselineSavedPath: string | null = null;
  if (opts.baseline) {
    const baselineDir = path.join(runDir, "baseline");
    console.log("\n[baseline] Running baseline agent...");
    const bl = await runBaseline(url, baselineDir, crawlResult.html);
    baselineSavedPath = bl.savedPath;
    record.baseline = {
      baselineScore: 0,
      baselineCostUsd: estimateCost(BASELINE_MODEL, bl.tokensIn, bl.tokensOut),
      baselineDurationMs: bl.durationMs,
      baselineThumbnail: "",
      mainScore: 0,
      mainCostUsd: record.estimatedCostUsd,
      mainDurationMs: generateDurationMs,
      mainThumbnail: "",
    };
    console.log(`[baseline] Saved to ${bl.savedPath}`);
  }

  if (savedPath) {
    console.log("\n[fidelity] Computing final fidelity metrics...");
    try {
      const { metrics: fidelity, tokensIn: fidelityIn, tokensOut: fidelityOut } = await collectFidelityMetrics(
        { screenshotBase64: crawlResult.screenshotBase64, sectionScreenshots: crawlResult.sourceSectionScreenshots },
        archDoc,
        savedPath,
        baselineSavedPath ?? undefined,
      );
      scorerTokensIn += fidelityIn;
      scorerTokensOut += fidelityOut;
      record.fidelityMetrics = fidelity;
      if (record.baseline) {
        record.baseline.mainScore = fidelity.mainVlmScore.score;
        record.baseline.mainThumbnail = fidelity.mainScreenshotBase64;
        if (fidelity.baselineScreenshotBase64) {
          record.baseline.baselineThumbnail = fidelity.baselineScreenshotBase64;
        }
      }
    } catch (err) {
      console.error("[fidelity] Failed to collect fidelity metrics:", err);
    }
  }

  logger.finalize(record);
  generateReport(runDir, record, record.fidelityMetrics?.sourceScreenshotBase64);
  return savedPath;
}
