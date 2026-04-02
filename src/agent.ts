import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { renderStream } from "./render";
import { enrichContext } from "./context";
import { Recorder } from "./observability/recorder";
import { Logger } from "./observability/logger";
import { estimateCost, estimateMaxTokens, computeIterBudget } from "./observability/metrics";
import {
  collectFidelityMetrics,
  screenshotAndExtract,
  computeChunkedVlmScore,
  CHUNK_HARD_CAP,
  scoreSeverity,
  captionDiscrepancies,
  classifyLevel,
  computeCompositeScore,
  computeDomDiff,
} from "./observability/fidelity";
import { generateReport } from "./observability/report";
import type { RunRecord, FidelityLevel, FidelityMode, ChunkedVlmScore } from "./observability/types";

const BASELINE_MODEL = "claude-haiku-4-5";
const GENERATE_MODEL = "claude-sonnet-4-6";
const FIX_MODEL = "claude-haiku-4-5";

const client = new Anthropic();

// ─── Fidelity budget ──────────────────────────────────────────────────────────

export interface FidelityBudget {
  minIterations: number;
  maxIterations: number;
  /** Headings per structure-level fix pass. undefined = no structure passes. */
  structureBatchSize: number | undefined;
  /** Hard cap for initial generation. null = use estimateMaxTokens() dynamically. */
  generateMaxTokens: number | null;
  /**
   * Floor for structure fix pass max_tokens. Actual value =
   * Math.max(structureFixFloor, estimateMaxTokens(currentHtml.length, model)).
   * undefined = no structure passes (minimal mode).
   */
  structureFixFloor: number | undefined;
  /** null = use estimateMaxTokens() dynamically. */
  contentFixMaxTokens: number | null;
  /** null = use estimateMaxTokens() dynamically. */
  visualFixMaxTokens: number | null;
  captionMaxTokens: number;
  useWideViewport: boolean;
  /**
   * Multiplier applied to (scrollHeight / viewportHeight) to determine how
   * many heading-anchored VLM chunks to use. 0 = use fold only (1 chunk).
   */
  vlmChunkMultiplier: number;
}

const FIDELITY_BUDGETS: Record<FidelityMode, FidelityBudget> = {
  minimal:  { minIterations: 0,  maxIterations: 0,  structureBatchSize: undefined, generateMaxTokens: 8_000,  structureFixFloor: undefined, contentFixMaxTokens: null,   visualFixMaxTokens: null,   captionMaxTokens: 1_024, useWideViewport: false, vlmChunkMultiplier: 0   },
  fast:     { minIterations: 2,  maxIterations: 3,  structureBatchSize: 10,        generateMaxTokens: 12_000, structureFixFloor: 24_576,   contentFixMaxTokens: 32_768, visualFixMaxTokens: 24_576, captionMaxTokens: 512,   useWideViewport: false, vlmChunkMultiplier: 0.4 },
  balanced: { minIterations: 3,  maxIterations: 6,  structureBatchSize: 15,        generateMaxTokens: null,   structureFixFloor: 40_960,   contentFixMaxTokens: null,   visualFixMaxTokens: null,   captionMaxTokens: 1_024, useWideViewport: true,  vlmChunkMultiplier: 0.6 },
  high:     { minIterations: 4,  maxIterations: 8,  structureBatchSize: 20,        generateMaxTokens: null,   structureFixFloor: 49_152,   contentFixMaxTokens: 65_536, visualFixMaxTokens: 65_536, captionMaxTokens: 1_024, useWideViewport: true,  vlmChunkMultiplier: 0.8 },
  maximal:  { minIterations: 6,  maxIterations: 12, structureBatchSize: 30,        generateMaxTokens: null,   structureFixFloor: 57_344,   contentFixMaxTokens: 65_536, visualFixMaxTokens: 65_536, captionMaxTokens: 2_048, useWideViewport: true,  vlmChunkMultiplier: 1.0 },
};

const OUTPUT_DIR = path.resolve(__dirname, "..", "output");

export interface GenerateOptions {
  name?: string;
  fidelity?: FidelityMode;
  threshold?: number;
  baseline?: boolean;
  open?: boolean;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function urlSlug(url: string): string {
  try {
    const u = new URL(url);
    return slugify(u.hostname + u.pathname);
  } catch {
    return slugify(url);
  }
}

async function fetchPage(url: string): Promise<{ html: string; truncated: boolean }> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  const sourceHtml = await res.text();
  const maxChars = 80_000;
  if (sourceHtml.length > maxChars) {
    return { html: sourceHtml.slice(0, maxChars) + "\n<!-- truncated -->", truncated: true };
  }
  return { html: sourceHtml, truncated: false };
}

async function runBaseline(
  url: string,
  outDir: string,
  truncatedHtml: string,
): Promise<{ savedPath: string | null; tokensIn: number; tokensOut: number; durationMs: number }> {
  fs.mkdirSync(outDir, { recursive: true });
  let savedPath: string | null = null;

  const saveFile = betaZodTool({
    name: "save_file",
    description:
      "Save the generated HTML page to disk. Call this once with the complete HTML content.",
    inputSchema: z.object({
      filename: z
        .string()
        .describe(
          "A descriptive kebab-case filename based on the source page, e.g. acme-landing-page.html",
        ),
      content: z.string().describe("The full HTML content of the page"),
    }),
    run: async (input) => {
      const outPath = path.join(outDir, input.filename);
      fs.writeFileSync(outPath, input.content, "utf-8");
      savedPath = outPath;
      return JSON.stringify({ success: true, file_path: outPath });
    },
  });

  const start = Date.now();
  const runner = client.beta.messages.toolRunner({
    model: BASELINE_MODEL,
    max_tokens: estimateMaxTokens(truncatedHtml.length, BASELINE_MODEL),
    tools: [saveFile],
    tool_choice: { type: "tool", name: "save_file" },
    stream: true,
    max_iterations: 1,
    system: `You are a helpful assistant that generates HTML pages from source HTML.`,
    messages: [
      {
        role: "user",
        content: `Create a single-file HTML page that recreates this page's content and visual design using Tailwind CSS (via CDN script tag). 
        
The page MUST:

- Be a complete, self-contained HTML file
- Use the Tailwind CSS CDN (<script src="https://cdn.tailwindcss.com"></script>)
- Faithfully reproduce the layout, content, and visual style of the source page
- Be responsive and well-structured

Use descriptive kebab-case filename based on the source page's title or domain.

Here is the HTML source of a webpage at ${url}:

<source_html>
${truncatedHtml}
</source_html>`,
      },
    ],
  });

  const { tokensIn, tokensOut } = await renderStream(runner);
  return { savedPath, tokensIn, tokensOut, durationMs: Date.now() - start };
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

  const saveFile = betaZodTool({
    name: "save_file",
    description:
      "Save the generated HTML page to disk. Call this once with the complete HTML content.",
    inputSchema: z.object({
      filename: z
        .string()
        .describe(
          "A descriptive kebab-case filename based on the source page, e.g. acme-landing-page.html",
        ),
      content: z.string().describe("The full HTML content of the page"),
    }),
    run: async (input) => {
      const outPath = path.join(mainDir, input.filename);
      fs.writeFileSync(outPath, input.content, "utf-8");
      savedPath = outPath;
      return JSON.stringify({ success: true, file_path: outPath });
    },
  });

  const context = await enrichContext(url);

  const budget = FIDELITY_BUDGETS[opts.fidelity ?? "balanced"];
  const sourceHeadings = context.domInfo.headings.length;
  const { resolvedMaxIter, rawBudget } = computeIterBudget(sourceHeadings, budget);

  if (budget.maxIterations > 0 && rawBudget > budget.maxIterations) {
    const fidelityMode = opts.fidelity ?? "balanced";
    const modeOrder: FidelityMode[] = ["fast", "balanced", "high", "maximal"];
    const nextMode = modeOrder[modeOrder.indexOf(fidelityMode as FidelityMode) + 1];
    const structPasses = resolvedMaxIter - 2;
    const coveredHeadings = structPasses * (budget.structureBatchSize ?? 0);
    const requiredHeadings = Math.ceil(sourceHeadings * 0.8);
    const pct = Math.round((coveredHeadings / requiredHeadings) * 100);
    const suggestion = nextMode ? ` Consider --fidelity ${nextMode}.` : "";
    console.warn(
      `[budget] Site has ${sourceHeadings} headings; ${fidelityMode} mode will cover ~${coveredHeadings}/${requiredHeadings} structure sections (~${pct}%).${suggestion}`,
    );
  }

  logger.log({
    phase: "fetch",
    timestamp: Date.now(),
    data: {
      url,
      htmlBytes: context.html.length,
      truncated: context.truncated,
      enriched: true,
      imageCount: context.imageUrls.length,
      fontCount: context.fontFamilies.length,
      sourceHeadings,
      resolvedMaxIter,
      fidelityMode: opts.fidelity ?? "balanced",
    },
  });

  const generateStart = Date.now();

  const stylesJson = JSON.stringify(context.computedStyles, null, 2);
  const fontsText = context.fontFamilies.join(", ");
  const imageUrlsText = context.imageUrls.join("\n");
  const svgsText = context.svgs.join("\n");

  const runner = client.beta.messages.toolRunner({
    model: GENERATE_MODEL,
    max_tokens: budget.generateMaxTokens ?? estimateMaxTokens(context.html.length, GENERATE_MODEL),
    tools: [saveFile],
    tool_choice: { type: "tool", name: "save_file" },
    stream: true,
    max_iterations: 1,
    system: `You are an expert front-end developer that generates pixel-faithful HTML pages from source pages.`,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: context.screenshotBase64,
            },
          },
          {
            type: "text",
            text: `The image above is a screenshot of the source page at ${url}. Use it as the primary visual reference.

Create a single-file HTML page that recreates this page's content and visual design using Tailwind CSS (via CDN script tag).

The page MUST:
- Be a complete, self-contained HTML file
- Use the Tailwind CSS CDN (<script src="https://cdn.tailwindcss.com"></script>)
- Faithfully reproduce the layout, content, colours, typography, and visual style visible in the screenshot
- Use the absolute image URLs provided below so assets resolve correctly
- Be responsive across all viewport widths from 375px (mobile) through 2560px+ (large desktop):
  - Use Tailwind's max-w-* and mx-auto for all layout containers — never use fixed pixel widths
  - Use xl: and 2xl: breakpoint variants to keep proportions correct at wide viewports
  - The reference screenshot is captured at 1280px; ensure nothing is broken or unnaturally stretched beyond that
- Use descriptive kebab-case filename based on the source page's title or domain

<computed_styles>
${stylesJson}
</computed_styles>

<fonts>
${fontsText}
</fonts>

<image_urls>
${imageUrlsText}
</image_urls>

<svgs>
${svgsText}
</svgs>

<source_html>
${context.html}
</source_html>`,
          },
        ],
      },
    ],
  });

  const { tokensIn, tokensOut } = await renderStream(runner);
  const generateDurationMs = Date.now() - generateStart;

  logger.log({
    phase: "generate",
    timestamp: Date.now(),
    data: {
      model: GENERATE_MODEL,
      tokensIn,
      tokensOut,
      durationMs: generateDurationMs,
      outputFile: savedPath ?? "",
    },
  });

  let generateTokensIn = tokensIn;
  let generateTokensOut = tokensOut;
  let fixTokensIn = 0;
  let fixTokensOut = 0;

  // ─── Run record (hoisted — iterations populated by loop below) ──────────────
  const record: RunRecord = {
    runId,
    ...(opts.name ? { name: opts.name } : {}),
    url,
    startedAt,
    completedAt: 0,
    iterations: [],
    estimatedCostUsd: 0,
  };

  // ─── Iterative fidelity loop ────────────────────────────────────────────────
  const MAX_ITER = resolvedMaxIter;
  const CONV_THRESHOLD = opts.threshold ?? 0.02;
  const sourceFoldBase64 = context.screenshotFoldBase64;
  const sourceBase64 = context.screenshotBase64;
  const sourceWideBase64 = context.screenshotWideBase64;
  const sourceChunks = context.screenshotChunksBase64;
  const sourceScrollHeight = context.scrollHeight;
  const sourceDomInfo = context.domInfo;
  let prevCompositeScore: number | null = null;

  if (savedPath) {
    for (let i = 0; i < MAX_ITER; i++) {
      console.log(`\n[fidelity] Iteration ${i + 1}/${MAX_ITER} — scoring...`);

      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const { screenshot: genBuf, screenshotFold: genFoldBuf, screenshotWide: genWideBuf, screenshotChunks: genChunksBuf, domInfo: genDomInfo } =
        await screenshotAndExtract(
          { file: savedPath! },
          {
            useWideViewport: budget.useWideViewport,
            // Drive gen chunk capture from source heading texts so chunk labels
            // are identical on both sides and fuzzy-match failures can't cause
            // present sections to be scored as absent.
            targetHeadings: sourceChunks
              .map((c) => c.heading)
              .filter((h) => h !== "FOLD"),
          },
        );
      const genBase64 = genBuf.toString("base64");
      const genFoldBase64 = genFoldBuf.toString("base64");
      const genWideBase64 = genWideBuf.toString("base64");
      const genChunks = genChunksBuf.map((c) => ({ heading: c.heading, screenshot: c.screenshot.toString("base64") }));

      // ── How many chunks to score this iteration ───────────────────────────
      // Dynamic: scale by (scrollHeight / viewportHeight) * mode multiplier,
      // clamped to [1, CHUNK_HARD_CAP]. 0 multiplier (minimal mode) → 1 chunk.
      const VIEWPORT_H = 900;
      const maxChunks = budget.vlmChunkMultiplier === 0
        ? 1
        : Math.max(1, Math.min(CHUNK_HARD_CAP, Math.ceil((sourceScrollHeight / VIEWPORT_H) * budget.vlmChunkMultiplier)));

      // ── Level classification via DOM diff (no VLM cost) ──────────────────
      const domDiff = computeDomDiff(sourceDomInfo, genDomInfo);
      const level: FidelityLevel = classifyLevel(domDiff);

      // ── VLM scoring only at visual level (chunk-based for coverage) ──────
      let chunkedVlm: ChunkedVlmScore | null = null;
      let severity: "high" | "medium" | "low" = "high";
      if (level === "visual") {
        chunkedVlm = await computeChunkedVlmScore(sourceChunks, genChunks, maxChunks);
        severity = scoreSeverity(chunkedVlm.aggregateScore);
      }

      const compositeScore =
        level === "visual" && chunkedVlm !== null
          ? computeCompositeScore(chunkedVlm.aggregateScore, domDiff.score)
          : domDiff.score;

      logger.log({
        phase: "diff",
        timestamp: Date.now(),
        data: {
          iteration: i + 1,
          vlmScore: chunkedVlm?.aggregateScore ?? 0,
          vlmVerdict: chunkedVlm?.aggregateVerdict ?? "distant",
          level,
          domScore: domDiff.score,
          compositeScore,
        },
      });

      const iterRecord = {
        iteration: i + 1,
        level,
        vlmScore: chunkedVlm?.aggregateScore ?? 0,
        vlmVerdict: chunkedVlm?.aggregateVerdict ?? "distant",
        domScore: domDiff.score,
        compositeScore,
        severity,
        discrepancyCount: 0,
        ...(chunkedVlm ? { vlmChunks: chunkedVlm.chunks } : {}),
      };

      console.log(
        `[fidelity] Level: ${level} | DOM: ${domDiff.score.toFixed(3)} (hr=${domDiff.headingRetentionRatio.toFixed(2)} tc=${domDiff.textCoverageRatio.toFixed(2)})` +
          (level === "visual" && chunkedVlm
            ? ` | VLM: ${chunkedVlm.aggregateScore.toFixed(3)} (${severity}) [${chunkedVlm.chunks.length} chunks]`
            : "") +
          ` | Composite: ${compositeScore.toFixed(3)}`,
      );

      // ── Convergence checks ────────────────────────────────────────────────
      if (level === "visual" && severity === "low") {
        console.log("[fidelity] Severity low — converged, stopping loop.");
        record.iterations.push(iterRecord);
        break;
      }

      if (prevCompositeScore !== null && Math.abs(compositeScore - prevCompositeScore) < CONV_THRESHOLD) {
        console.log("[fidelity] Composite score delta below threshold — converged, stopping loop.");
        record.iterations.push(iterRecord);
        break;
      }

      // ── Fix pass ──────────────────────────────────────────────────────────
      const currentFilePath = savedPath!;
      const currentHtml = fs.readFileSync(currentFilePath, "utf-8");
      savedPath = null;

      const fixSaveFile = betaZodTool({
        name: "save_file",
        description: "Save the fixed HTML page to disk.",
        inputSchema: z.object({
          filename: z.string().describe("Same kebab-case filename as the original."),
          content: z.string().describe("The complete fixed HTML content of the page."),
        }),
        run: async (input) => {
          const outPath = path.join(mainDir, input.filename);
          fs.writeFileSync(outPath, input.content, "utf-8");
          savedPath = outPath;
          return JSON.stringify({ success: true, file_path: outPath });
        },
      });

      let fixSystem: string;
      let fixUserText: string;
      let fixImageBase64: string;

      const STRUCTURE_BATCH = budget.structureBatchSize ?? 15;
      if (level === "structure") {
        const batch = domDiff.missingHeadings.slice(0, STRUCTURE_BATCH);
        const missingList = batch.join("\n");
        const remaining = domDiff.missingHeadings.length - batch.length;
        console.log(`[fidelity] Structure pass — adding ${batch.length} of ${domDiff.missingHeadings.length} missing headings (${remaining} remaining)`);
        fixSystem = `You are an expert front-end developer completing a partially-generated HTML page. Your ONLY task is to add the missing sections listed below in the correct order. Do NOT change any section that already exists. Use responsive Tailwind classes (max-w-* mx-auto, xl:/2xl: variants).`;
        fixImageBase64 = sourceFoldBase64;
        fixUserText = `The image above is the SOURCE page first fold. The HTML below is missing these sections — add them in the order they appear on the source page:

<missing_sections>
${missingList}
</missing_sections>

<current_html>
${currentHtml}
</current_html>`;
        iterRecord.discrepancyCount = domDiff.missingHeadings.length;
      } else if (level === "content") {
        // Level 2: fill copy and images into existing skeleton
        console.log(
          `[fidelity] Content pass — text coverage ${(domDiff.textCoverageRatio * 100).toFixed(0)}%, image delta ${domDiff.imageDelta}`,
        );
        fixSystem = `You are an expert front-end developer filling in missing content in a generated HTML page. Your ONLY task is to add missing copy and images. Do NOT change the layout, colours, or visual styling.`;
        fixImageBase64 = sourceBase64;
        fixUserText = `The image above is the full SOURCE page. The HTML below has the right structure but is missing content:
- Text coverage: ${(domDiff.textCoverageRatio * 100).toFixed(0)}% of source (target ≥70%)
- Image delta: ${domDiff.imageDelta} (negative = missing images)

Add missing body copy and images to match the source. Do not touch layout or styling.

<current_html>
${currentHtml}
</current_html>`;
        iterRecord.discrepancyCount = Math.round((1 - domDiff.textCoverageRatio) * 10);
      } else {
        // Level 3: visual fix using VLM discrepancy list
        console.log(`[fidelity] Captioning discrepancies...`);
        const discrepancies = await captionDiscrepancies(
          sourceFoldBase64,
          genFoldBase64,
          budget.useWideViewport ? { sourceWideBase64, generatedWideBase64: genWideBase64 } : undefined,
          { maxTokens: budget.captionMaxTokens },
        );
        iterRecord.discrepancyCount = discrepancies.length;

        logger.log({
          phase: "caption",
          timestamp: Date.now(),
          data: { iteration: i + 1, tokensIn: 0, tokensOut: 0, discrepancies },
        });

        if (discrepancies.length === 0) {
          console.log("[fidelity] No actionable discrepancies — stopping loop.");
          record.iterations.push(iterRecord);
          break;
        }

        console.log(`[fidelity] ${discrepancies.length} discrepancies — visual fix pass...`);
        const discrepancyList = discrepancies.map((d) => `[${d.severity}] ${d.section}: ${d.issue}`).join("\n");
        fixSystem = `You are an expert front-end developer fixing visual fidelity issues in a generated HTML page. You will be shown the source page screenshot and a list of specific discrepancies. Fix ONLY the listed issues — do not modify sections that are already correct. All fixes must use responsive Tailwind classes that render correctly from 1280px through 2560px+; never use fixed pixel widths on containers.`;
        fixImageBase64 = sourceFoldBase64;
        fixUserText = `The image above is the SOURCE page you must match. The HTML below is the current reconstruction. Fix ONLY the discrepancies listed — do not change anything else.

<discrepancies>
${discrepancyList}
</discrepancies>

<current_html>
${currentHtml}
</current_html>`;
      }

      record.iterations.push(iterRecord);

      const fixStart = Date.now();
      const fixMaxTokens =
        level === "structure"
          ? Math.max(budget.structureFixFloor ?? 40_960, estimateMaxTokens(currentHtml.length, FIX_MODEL))
          : level === "content"
          ? (budget.contentFixMaxTokens ?? estimateMaxTokens(currentHtml.length, FIX_MODEL))
          : (budget.visualFixMaxTokens ?? estimateMaxTokens(currentHtml.length, FIX_MODEL));

      const fixRunner = client.beta.messages.toolRunner({
        model: FIX_MODEL,
        max_tokens: fixMaxTokens,
        tools: [fixSaveFile],
        tool_choice: { type: "tool", name: "save_file" },
        stream: true,
        max_iterations: 1,
        system: fixSystem,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "base64", media_type: "image/png", data: fixImageBase64 },
              },
              { type: "text", text: fixUserText },
            ],
          },
        ],
      });

      const { tokensIn: fixIn, tokensOut: fixOut } = await renderStream(fixRunner);
      const fixDurationMs = Date.now() - fixStart;
      fixTokensIn += fixIn;
      fixTokensOut += fixOut;

      logger.log({
        phase: "fix",
        timestamp: Date.now(),
        data: {
          iteration: i + 1,
          model: FIX_MODEL,
          tokensIn: fixIn,
          tokensOut: fixOut,
          durationMs: fixDurationMs,
          htmlSizeDelta: savedPath
            ? fs.readFileSync(savedPath, "utf-8").length - currentHtml.length
            : 0,
        },
      });

      if (!savedPath) {
        console.log("[fidelity] Fix pass did not save a file — stopping loop.");
        break;
      }

      prevCompositeScore = compositeScore;
    }
  }

  // ─── Cost + record finalisation ─────────────────────────────────────────────
  record.completedAt = Date.now();
  record.estimatedCostUsd =
    estimateCost(GENERATE_MODEL, generateTokensIn, generateTokensOut) +
    estimateCost(FIX_MODEL, fixTokensIn, fixTokensOut);

  let baselineSavedPath: string | null = null;

  if (opts.baseline) {
    const baselineDir = path.join(runDir, "baseline");
    console.log("\n[baseline] Running baseline agent...");
    const bl = await runBaseline(url, baselineDir, context.html);
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
      const fidelity = await collectFidelityMetrics(
        url,
        savedPath,
        baselineSavedPath ?? undefined,
      );
      record.fidelityMetrics = fidelity;
      if (record.baseline) {
        record.baseline.mainScore = fidelity.mainVlmScore.score;
        record.baseline.mainThumbnail = fidelity.mainScreenshotBase64;
        if (fidelity.baselineVlmScore) {
          record.baseline.baselineScore = fidelity.baselineVlmScore.score;
        }
        if (fidelity.baselineScreenshotBase64) {
          record.baseline.baselineThumbnail = fidelity.baselineScreenshotBase64;
        }
      }
    } catch (err) {
      console.error("[fidelity] Failed to collect fidelity metrics:", err);
    }
  }

  logger.finalize(record);
  generateReport(
    runDir,
    record,
    record.fidelityMetrics?.sourceScreenshotBase64,
  );

  return savedPath;
}

