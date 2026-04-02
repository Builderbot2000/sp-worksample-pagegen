import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import sharp from "sharp";
import { renderStream } from "./render";
import { crawlAndPreprocess } from "./context";
import { Recorder } from "./observability/recorder";
import { Logger } from "./observability/logger";
import { estimateCost, estimateMaxTokens, computeIterBudget } from "./observability/metrics";
import {
  collectFidelityMetrics,
  screenshotSectionsBySlug,
  computeSectionDiscrepancies,
  scoreSeverity,
} from "./observability/fidelity";
import { generateReport } from "./observability/report";
import type { RunRecord, FidelityMode, IterationRecord, VisualArchDoc } from "./observability/types";

const BASELINE_MODEL = "claude-haiku-4-5";
const GENERATE_MODEL = "claude-sonnet-4-6";
const FIX_MODEL = "claude-haiku-4-5";

const client = new Anthropic();

// ─── VLM image helpers ────────────────────────────────────────────────────────

/** Resize a section screenshot to a resolution optimised for Claude VLM input. */
async function resizeForVlm(buf: Buffer): Promise<Buffer> {
  return sharp(buf)
    .resize({ width: 1024, withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .toBuffer();
}

// ─── Fidelity budget ──────────────────────────────────────────────────────────

export interface FidelityBudget {
  minIterations: number;
  maxIterations: number;
  /** Hard cap for initial generation. null = use estimateMaxTokens() dynamically. */
  generateMaxTokens: number | null;
  /** Max tokens for Haiku full-document rewrite. null = use estimateMaxTokens() dynamically. */
  patchMaxTokens: number | null;
  /** Max tokens for the section VLM comparison call. */
  sectionVlmMaxTokens: number;
}

const FIDELITY_BUDGETS: Record<FidelityMode, FidelityBudget> = {
  minimal:  { minIterations: 0,  maxIterations: 0,  generateMaxTokens: 8_000,  patchMaxTokens: null,   sectionVlmMaxTokens: 512   },
  fast:     { minIterations: 2,  maxIterations: 3,  generateMaxTokens: 12_000, patchMaxTokens: 32_768, sectionVlmMaxTokens: 512   },
  balanced: { minIterations: 3,  maxIterations: 6,  generateMaxTokens: null,   patchMaxTokens: null,   sectionVlmMaxTokens: 1_024 },
  high:     { minIterations: 4,  maxIterations: 8,  generateMaxTokens: null,   patchMaxTokens: 65_536, sectionVlmMaxTokens: 1_024 },
  maximal:  { minIterations: 6,  maxIterations: 12, generateMaxTokens: null,   patchMaxTokens: 65_536, sectionVlmMaxTokens: 2_048 },
};

const OUTPUT_DIR = path.resolve(__dirname, "..", "output");

export interface GenerateOptions {
  name?: string;
  fidelity?: FidelityMode;
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

function formatArchDoc(archDoc: VisualArchDoc): string {
  const sectionsText = archDoc.sections
    .map((s) => `  ${s.order}. slug: "${s.slug}" | role: ${s.role}\n     ${s.description}`)
    .join("\n");
  const fixedText =
    archDoc.fixedElements.length > 0 ? archDoc.fixedElements.join("; ") : "None";
  return `Background: ${archDoc.backgroundDescription}
Fixed/sticky elements: ${fixedText}
Sections (in visual order):
${sectionsText}`;
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

  const crawlResult = await crawlAndPreprocess(url);
  const archDoc = crawlResult.visualArchDoc;

  const budget = FIDELITY_BUDGETS[opts.fidelity ?? "balanced"];
  const sectionCount = archDoc.sections.length;
  const { resolvedMaxIter, rawBudget } = computeIterBudget(sectionCount, budget);

  if (budget.maxIterations > 0 && rawBudget > budget.maxIterations) {
    const fidelityMode = opts.fidelity ?? "balanced";
    const modeOrder: FidelityMode[] = ["fast", "balanced", "high", "maximal"];
    const nextMode = modeOrder[modeOrder.indexOf(fidelityMode as FidelityMode) + 1];
    const pct = Math.round((resolvedMaxIter / rawBudget) * 100);
    const suggestion = nextMode ? ` Consider --fidelity ${nextMode}.` : "";
    console.warn(
      `[budget] Site has ${sectionCount} sections; ${fidelityMode} mode covers ~${pct}% of raw budget (${resolvedMaxIter}/${rawBudget} iterations).${suggestion}`,
    );
  }

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
      sectionCount,
      resolvedMaxIter,
      fidelityMode: opts.fidelity ?? "balanced",
    },
  });

  const generateStart = Date.now();

  const stylesJson = JSON.stringify(crawlResult.computedStyles, null, 2);
  const fontsText = crawlResult.fontFamilies.join(", ");
  const imageUrlsText = crawlResult.imageUrls.join("\n");
  const svgsText = crawlResult.svgs.join("\n");
  const archDocText = formatArchDoc(archDoc);

  // Build interleaved section screenshot blocks for VLM reference
  type ContentBlock = Anthropic.TextBlockParam | Anthropic.ImageBlockParam;
  const sectionVisualBlocks: ContentBlock[] = [];
  for (const section of archDoc.sections) {
    const screenshots = crawlResult.sourceSectionScreenshots[section.slug];
    if (screenshots?.[0]) {
      const resized = await resizeForVlm(screenshots[0]);
      sectionVisualBlocks.push({
        type: "text",
        text: `Section ${section.order} — slug: "${section.slug}" | role: ${section.role}\n${section.description}`,
      });
      sectionVisualBlocks.push({
        type: "image",
        source: { type: "base64", media_type: "image/jpeg", data: resized.toString("base64") },
      });
    }
  }

  const runner = client.beta.messages.toolRunner({
    model: GENERATE_MODEL,
    max_tokens: budget.generateMaxTokens ?? estimateMaxTokens(crawlResult.html.length, GENERATE_MODEL),
    thinking: { type: "disabled" },
    tools: [saveFile],
    tool_choice: { type: "tool", name: "save_file" },
    stream: true,
    max_iterations: 1,
    system: `You are an expert front-end developer that generates pixel-faithful HTML pages from source pages.

CRITICAL: The visual architecture specification in the user message defines the sections that MUST appear in your output. Every section's outermost element MUST have these two attributes exactly:
  data-section-slug="<slug>"   (must match the slug from the spec verbatim)
  data-section-order="<N>"     (integer 1-based order from the spec)

These attributes are mandatory — the correction system identifies and scores sections solely by them.`,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "Below are screenshots of each visual section of the source page, in order. Use them as a visual reference when recreating the layout, colours, and styling.",
          },
          ...sectionVisualBlocks,
          {
            type: "text",
            text: `Create a single-file HTML page that recreates the source page at ${url} using Tailwind CSS (via CDN script tag).

The page MUST:
- Be a complete, self-contained HTML file
- Use the Tailwind CSS CDN (<script src="https://cdn.tailwindcss.com"></script>)
- Faithfully reproduce the layout, content, colours, typography, and visual style of the source page
- Use the absolute image URLs provided below so assets resolve correctly
- Be responsive across all viewport widths from 375px (mobile) through 2560px+ (large desktop):
  - Use Tailwind's max-w-* and mx-auto for all layout containers — never use fixed pixel widths
  - Use xl: and 2xl: breakpoint variants to keep proportions correct at wide viewports
- Use descriptive kebab-case filename based on the source page's title or domain

SECTION LABELS (hard constraint):
The visual architecture doc below defines the required sections for this page.
For every section listed, its outermost root element MUST carry these two attributes:
  data-section-slug="<slug>"    (must match exactly)
  data-section-order="<order>"  (integer, 1-based)
The correction system identifies and scores sections solely by these attributes.

<visual_architecture>
${archDocText}
</visual_architecture>

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
${crawlResult.html}
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

  if (savedPath) {
    for (let i = 0; i < MAX_ITER; i++) {
      console.log(`\n[fidelity] Iteration ${i + 1}/${MAX_ITER} — scoring sections...`);

      const genSections = await screenshotSectionsBySlug({ file: savedPath! }, archDoc);
      const { discrepancies, matched, unmatched, aggregateScore } = await computeSectionDiscrepancies(
        crawlResult.sourceSectionScreenshots,
        genSections,
        archDoc,
        { maxTokens: budget.sectionVlmMaxTokens },
      );
      const severity = scoreSeverity(aggregateScore);

      logger.log({
        phase: "diff",
        timestamp: Date.now(),
        data: { iteration: i + 1, vlmScore: aggregateScore, matched, unmatched, discrepancyCount: discrepancies.length },
      });

      const iterRecord: IterationRecord = {
        iteration: i + 1,
        matched,
        unmatched,
        vlmScore: aggregateScore,
        severity,
        discrepancyCount: discrepancies.length,
      };

      console.log(
        `[fidelity] ${matched}/${matched + unmatched} sections matched | VLM: ${aggregateScore.toFixed(3)} (${severity}) | ${discrepancies.length} discrepancies`,
      );

      if (discrepancies.length === 0) {
        console.log("[fidelity] No discrepancies — converged.");
        record.iterations.push(iterRecord);
        break;
      }

      record.iterations.push(iterRecord);

      // ── Patch pass ────────────────────────────────────────────────────────
      const currentFilePath = savedPath!;
      const currentHtml = fs.readFileSync(currentFilePath, "utf-8");
      savedPath = null;

      const fixSaveFile = betaZodTool({
        name: "save_file",
        description: "Save the rewritten HTML page to disk.",
        inputSchema: z.object({
          filename: z.string().describe("Same kebab-case filename as the original."),
          content: z.string().describe("The complete rewritten HTML content of the page."),
        }),
        run: async (input) => {
          const outPath = path.join(mainDir, input.filename);
          fs.writeFileSync(outPath, input.content, "utf-8");
          savedPath = outPath;
          return JSON.stringify({ success: true, file_path: outPath });
        },
      });

      const discrepancyList = discrepancies
        .map((d) => {
          const spec = archDoc.sections.find((s) => s.slug === d.slug);
          return `[${d.severity}] ${d.slug} (${spec?.role ?? "section"}): ${d.issues.join("; ")}`;
        })
        .join("\n");

      const fixStart = Date.now();
      // Always allocate enough tokens to emit the full HTML plus 25% headroom.
      // Haiku caps at 32K output; if the page needs more, bump to Sonnet's 64K ceiling.
      const htmlTokenEstimate = Math.ceil(currentHtml.length / 4);
      const patchTokensNeeded = Math.ceil(htmlTokenEstimate * 1.25);
      const fixMaxTokens = budget.patchMaxTokens ?? Math.min(patchTokensNeeded, 32_768);
      const fixRunner = client.beta.messages.toolRunner({
        model: FIX_MODEL,
        max_tokens: fixMaxTokens,
        tools: [fixSaveFile],
        tool_choice: { type: "tool", name: "save_file" },
        stream: true,
        max_iterations: 1,
        system: `You are an expert front-end developer fixing visual fidelity issues in a generated HTML page. Rewrite the complete HTML document fixing the listed discrepancies. Preserve sections that are already correct. All sections MUST keep their data-section-slug and data-section-order attributes.`,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "base64", media_type: "image/png", data: crawlResult.screenshotBase64 },
              },
              {
                type: "text",
                text: `SOURCE page above.\n\n<visual_architecture>\n${archDocText}\n</visual_architecture>\n\n<discrepancies>\n${discrepancyList}\n</discrepancies>\n\nRewrite the complete HTML fixing the listed discrepancies. Each section root MUST carry its data-section-slug and data-section-order attributes.\n\n<current_html>\n${currentHtml}\n</current_html>`,
              },
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
      const fidelity = await collectFidelityMetrics(
        { screenshotBase64: crawlResult.screenshotBase64, sectionScreenshots: crawlResult.sourceSectionScreenshots },
        archDoc,
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

