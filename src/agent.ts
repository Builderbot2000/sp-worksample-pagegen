import * as fs from "fs";
import * as path from "path";
import { slugify, urlSlug } from "./utils";
import { crawlAndPreprocess } from "./context";
import { Recorder } from "./observability/recorder";
import { Logger } from "./observability/logger";
import { estimateCost } from "./observability/metrics";
import { collectFidelityMetrics } from "./observability/fidelity";
import { generateReport } from "./observability/report";
import type { RunRecord, QualityMode, QualityBudget, ScreenshotPaths } from "./observability/types";
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

  logger.log({
    phase: "run:start",
    timestamp: Date.now(),
    data: {
      runId,
      url,
      qualityMode: opts.quality ?? "standard",
      correctionEnabled: opts.correction ?? false,
      baselineEnabled: opts.baseline ?? false,
    },
  });

  logger.log({ phase: "preprocess:start", timestamp: Date.now(), data: { url } });
  const preprocessStart = Date.now();
  const crawlResult = await crawlAndPreprocess(url);
  const archDoc = crawlResult.visualArchDoc;
  const budget = QUALITY_BUDGETS[opts.quality ?? "standard"];

  logger.log({
    phase: "preprocess:complete",
    timestamp: Date.now(),
    data: {
      url,
      htmlBytes: crawlResult.html.length,
      truncated: crawlResult.truncated,
      sectionCount: archDoc.sections.length,
      imageCount: crawlResult.imageUrls.length,
      fontCount: crawlResult.fontFamilies.length,
      captionTokensIn: crawlResult.captionTokensIn,
      captionTokensOut: crawlResult.captionTokensOut,
      durationMs: Date.now() - preprocessStart,
    },
  });

  // ── Phase 0: Save source screenshots unconditionally ─────────────────────────
  const sectionsDir = path.join(runDir, "sections");
  fs.mkdirSync(sectionsDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "source.png"), Buffer.from(crawlResult.screenshotBase64, "base64"));
  for (const section of archDoc.sections) {
    const bufs = crawlResult.sourceSectionScreenshots[section.slug];
    if (bufs?.[0]) fs.writeFileSync(path.join(sectionsDir, `source-${section.slug}.png`), bufs[0]);
  }

  const record: RunRecord = {
    runId,
    ...(opts.name ? { name: opts.name } : {}),
    url,
    startedAt,
    completedAt: 0,
    iterations: [],
    estimatedCostUsd: 0,
    screenshotPaths: {
      source: "source.png",
      sections: Object.fromEntries(
        archDoc.sections
          .filter((s) => crawlResult.sourceSectionScreenshots[s.slug]?.[0])
          .map((s) => [s.slug, `sections/source-${s.slug}.png`]),
      ),
    },
  };

  const generateStart = Date.now();
  let scorerTokensIn = 0;
  let scorerTokensOut = 0;

  // ── Stage 1: Skeleton Agent ──────────────────────────────────────────────────────
  console.log(`
[gen] Stage 1 — skeleton (${GENERATE_MODEL})...`);
  const skeletonStart = Date.now();
  logger.log({ phase: "skeleton:start", timestamp: skeletonStart, data: { model: MODELS.skeleton } });
  const skeletonResult = await runSkeletonAgent({ url, crawlResult, mainDir });
  if (!skeletonResult) {
    console.error("[gen] Skeleton agent produced no output — aborting.");
    return null;
  }
  const { skeletonHtml, skeletonBasename, tokensIn: skeletonIn, tokensOut: skeletonOut } = skeletonResult;
  logger.log({
    phase: "skeleton:complete",
    timestamp: Date.now(),
    data: { model: MODELS.skeleton, tokensIn: skeletonIn, tokensOut: skeletonOut, durationMs: Date.now() - skeletonStart, outputFile: `main/${skeletonBasename}-skeleton.html` },
  });
  console.log(`[gen] Skeleton done — ${skeletonIn} in / ${skeletonOut} out tokens`);

  // ── Stage 2: Section Agents (parallel) ──────────────────────────────────────
  console.log(`
[gen] Stage 2 — ${archDoc.sections.length} section agents (parallel)...`);
  const rootCssVars = extractRootCssVars(skeletonHtml);
  const sectionResults = await Promise.all(
    archDoc.sections.map(async (section, i) => {
      const selfTag = extractShellTag(skeletonHtml, section.slug);
      const prevTag = i > 0 ? extractShellTag(skeletonHtml, archDoc.sections[i - 1].slug) : undefined;
      const nextTag = i < archDoc.sections.length - 1 ? extractShellTag(skeletonHtml, archDoc.sections[i + 1].slug) : undefined;
      const shellContext = selfTag ? { self: selfTag, prev: prevTag, next: nextTag } : undefined;
      const sectionStart = Date.now();
      logger.log({
        phase: "section:start",
        timestamp: sectionStart,
        data: { slug: section.slug, role: section.role, order: section.order, model: MODELS.sectionInitial },
      });
      const result = await generateSection(
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
      logger.log({
        phase: "section:complete",
        timestamp: Date.now(),
        data: { slug: result.slug, role: section.role, order: section.order, model: MODELS.sectionInitial, tokensIn: result.tokensIn, tokensOut: result.tokensOut, durationMs: Date.now() - sectionStart },
      });
      return result;
    }),
  );

  const sectionFragments = sectionResults.map((r) => ({ slug: r.slug, fragment: r.fragment }));
  const sectionTokensIn = sectionResults.reduce((sum, r) => sum + r.tokensIn, 0);
  const sectionTokensOut = sectionResults.reduce((sum, r) => sum + r.tokensOut, 0);
  console.log(`[gen] Sections done — ${sectionTokensIn} in / ${sectionTokensOut} out tokens (${sectionResults.length} agents)`);

  // ── Stage 3: Programmatic Assembly ─────────────────────────────────────────────
  console.log(`
[gen] Stage 3 — assembling...`);
  const assembleStart = Date.now();
  logger.log({ phase: "assemble:start", timestamp: assembleStart, data: { sectionCount: sectionFragments.length } });
  const assembledHtml = assembleSkeleton(skeletonHtml, sectionFragments);
  const assembledFilename = `${skeletonBasename}.html`;
  const assembledPath = path.join(mainDir, assembledFilename);
  fs.writeFileSync(assembledPath, assembledHtml, "utf-8");
  savedPath = assembledPath;
  logger.log({
    phase: "assemble:complete",
    timestamp: Date.now(),
    data: { outputFile: `main/${assembledFilename}`, htmlSizeBytes: Buffer.byteLength(assembledHtml, "utf-8"), durationMs: Date.now() - assembleStart },
  });
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
      logger,
    });
    scorerTokensIn += loopResult.scorerTokensIn;
    scorerTokensOut += loopResult.scorerTokensOut;
    correctionSectionTokensIn = loopResult.sectionTokensIn;
    correctionSectionTokensOut = loopResult.sectionTokensOut;
    for (const iterRecord of loopResult.iterationRecords) {
      record.iterations.push(iterRecord);
    }
  }

  const generateDurationMs = Date.now() - generateStart;
  const generateTokensIn = skeletonIn + sectionTokensIn + correctionSectionTokensIn;
  const generateTokensOut = skeletonOut + sectionTokensOut + correctionSectionTokensOut;

  let baselineSavedPath: string | null = null;
  if (opts.baseline) {
    const baselineDir = path.join(runDir, "baseline");
    logger.log({ phase: "baseline:start", timestamp: Date.now(), data: { model: BASELINE_MODEL } });
    const bl = await runBaseline(url, baselineDir, crawlResult.html);
    baselineSavedPath = bl.savedPath;
    logger.log({
      phase: "baseline:complete",
      timestamp: Date.now(),
      data: { model: BASELINE_MODEL, tokensIn: bl.tokensIn, tokensOut: bl.tokensOut, durationMs: bl.durationMs, outputFile: `baseline/${path.basename(bl.savedPath ?? "")}` },
    });
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
  }

  if (savedPath) {
    const fidelityStart = Date.now();
    logger.log({ phase: "fidelity:start", timestamp: fidelityStart, data: {} });
    try {
      const fidelityDir = path.join(runDir, "fidelity");
      const { metrics: fidelity, tokensIn: fidelityIn, tokensOut: fidelityOut, mainSectionPaths } = await collectFidelityMetrics(
        { screenshotBase64: crawlResult.screenshotBase64, sectionScreenshots: crawlResult.sourceSectionScreenshots },
        archDoc,
        savedPath,
        baselineSavedPath ?? undefined,
        fidelityDir,
      );
      scorerTokensIn += fidelityIn;
      scorerTokensOut += fidelityOut;
      record.fidelityMetrics = fidelity;

      // Save fidelity screenshots to disk for log-based reconstruction
      fs.mkdirSync(fidelityDir, { recursive: true });
      fs.writeFileSync(path.join(fidelityDir, "main.png"), Buffer.from(fidelity.mainScreenshotBase64, "base64"));
      if (record.screenshotPaths) {
        record.screenshotPaths.fidelityMain = "fidelity/main.png";
        if (Object.keys(mainSectionPaths).length > 0) {
          record.screenshotPaths.fidelitySections = mainSectionPaths;
        }
      }
      if (fidelity.baselineScreenshotBase64) {
        fs.writeFileSync(path.join(fidelityDir, "baseline.png"), Buffer.from(fidelity.baselineScreenshotBase64, "base64"));
        if (record.screenshotPaths) record.screenshotPaths.fidelityBaseline = "fidelity/baseline.png";
      }

      logger.log({
        phase: "fidelity:complete",
        timestamp: Date.now(),
        data: {
          mainScore: fidelity.mainVlmScore.score,
          ...(fidelity.baselineScreenshotBase64 ? { baselineScore: record.baseline?.baselineScore } : {}),
          tokensIn: fidelityIn,
          tokensOut: fidelityOut,
          durationMs: Date.now() - fidelityStart,
        },
      });

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

  record.completedAt = Date.now();
  record.estimatedCostUsd =
    estimateCost(GENERATE_MODEL, generateTokensIn, generateTokensOut) +
    estimateCost(MODELS.caption, crawlResult.captionTokensIn, crawlResult.captionTokensOut) +
    estimateCost(MODELS.vlmScorer, scorerTokensIn, scorerTokensOut);

  logger.log({
    phase: "run:complete",
    timestamp: Date.now(),
    data: { runId, durationMs: record.completedAt - record.startedAt, estimatedCostUsd: record.estimatedCostUsd, outputFile: savedPath },
  });
  logger.finalize(record);
  generateReport(runDir, record, record.fidelityMetrics?.sourceScreenshotBase64);
  return savedPath;
}
