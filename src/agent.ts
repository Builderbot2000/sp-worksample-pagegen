import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { renderStream } from "./render";
import { enrichContext } from "./context";
import { Recorder } from "./observability/recorder";
import { Logger } from "./observability/logger";
import { estimateCost, estimateMaxTokens } from "./observability/metrics";
import {
  collectFidelityMetrics,
  screenshotAndExtract,
  computeVlmFidelityScore,
  scoreSeverity,
  captionDiscrepancies,
  classifyLevel,
  computeCompositeScore,
  computeDomDiff,
} from "./observability/fidelity";
import { generateReport } from "./observability/report";
import type { RunRecord, FidelityLevel } from "./observability/types";

const BASELINE_MODEL = "claude-haiku-4-5";

const client = new Anthropic();

const OUTPUT_DIR = path.resolve(__dirname, "..", "output");

export interface GenerateOptions {
  name?: string;
  iterations?: number;
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
    },
  });

  const generateStart = Date.now();

  const stylesJson = JSON.stringify(context.computedStyles, null, 2);
  const fontsText = context.fontFamilies.join(", ");
  const imageUrlsText = context.imageUrls.join("\n");
  const svgsText = context.svgs.join("\n");

  const runner = client.beta.messages.toolRunner({
    model: "claude-haiku-4-5",
    max_tokens: estimateMaxTokens(context.html.length, "claude-haiku-4-5"),
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
      model: "claude-haiku-4-5",
      tokensIn,
      tokensOut,
      durationMs: generateDurationMs,
      outputFile: savedPath ?? "",
    },
  });

  let totalTokensIn = tokensIn;
  let totalTokensOut = tokensOut;

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
  const MAX_ITER = opts.iterations ?? 4;
  const CONV_THRESHOLD = opts.threshold ?? 0.02;
  const sourceFoldBase64 = context.screenshotFoldBase64;
  const sourceBase64 = context.screenshotBase64;
  const sourceWideBase64 = context.screenshotWideBase64;
  const sourceDomInfo = context.domInfo;
  let prevCompositeScore: number | null = null;

  const STRUCTURE_ITERS_CAP = 20;
  const CONTENT_ITERS_CAP = 2;
  let structureItersUsed = 0;
  let contentItersUsed = 0;

  if (savedPath) {
    for (let i = 0; i < MAX_ITER; i++) {
      console.log(`\n[fidelity] Iteration ${i + 1}/${MAX_ITER} — scoring...`);

      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const { screenshot: genBuf, screenshotFold: genFoldBuf, screenshotWide: genWideBuf, domInfo: genDomInfo } =
        await screenshotAndExtract({ file: savedPath! });
      const genBase64 = genBuf.toString("base64");
      const genFoldBase64 = genFoldBuf.toString("base64");
      const genWideBase64 = genWideBuf.toString("base64");

      // ── Level classification via DOM diff (no VLM cost) ──────────────────
      const domDiff = computeDomDiff(sourceDomInfo, genDomInfo);
      const domLevel: FidelityLevel = classifyLevel(domDiff);
      let level: FidelityLevel = domLevel;
      if (level === "structure" && structureItersUsed >= STRUCTURE_ITERS_CAP) level = "content";
      if (level === "content" && contentItersUsed >= CONTENT_ITERS_CAP) level = "visual";

      // ── VLM scoring only at visual level (fold screenshots for stability) ─
      let vlmScore: Awaited<ReturnType<typeof computeVlmFidelityScore>> | null = null;
      let severity: "high" | "medium" | "low" = "high";
      if (level === "visual") {
        vlmScore = await computeVlmFidelityScore(sourceFoldBase64, genFoldBase64);
        severity = scoreSeverity(vlmScore.score);
      }

      const compositeScore =
        level === "visual" && vlmScore !== null
          ? computeCompositeScore(vlmScore.score, domDiff.score)
          : domDiff.score;

      logger.log({
        phase: "diff",
        timestamp: Date.now(),
        data: {
          iteration: i + 1,
          vlmScore: vlmScore?.score ?? 0,
          vlmVerdict: vlmScore?.verdict ?? "distant",
          level,
          domLevel,
          domScore: domDiff.score,
          compositeScore,
          missingHeadingCount: domDiff.missingHeadings.length,
        },
      });

      const iterRecord = {
        iteration: i + 1,
        level,
        vlmScore: vlmScore?.score ?? 0,
        vlmVerdict: vlmScore?.verdict ?? "distant",
        domScore: domDiff.score,
        compositeScore,
        severity,
        discrepancyCount: 0,
      };

      const levelStr = level !== domLevel ? `${level} (forced from ${domLevel})` : level;
      console.log(
        `[fidelity] Level: ${levelStr} | DOM: ${domDiff.score.toFixed(3)} (hr=${domDiff.headingRetentionRatio.toFixed(2)} tc=${domDiff.textCoverageRatio.toFixed(2)})` +
          (level === "visual" && vlmScore ? ` | VLM: ${vlmScore.score.toFixed(3)} (${severity})` : "") +
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

      const STRUCTURE_BATCH = 4;
      const fixStart = Date.now();

      if (level === "structure") {
        // Fragment-only pass: model emits new section HTML only, injected before </body>.
        // Avoids rewriting the full document (~200KB) just to append 15 sections.
        const batch = domDiff.missingHeadings.slice(0, STRUCTURE_BATCH);
        const missingList = batch.join("\n");
        const remaining = domDiff.missingHeadings.length - batch.length;
        console.log(`[fidelity] Structure pass — appending ${batch.length} of ${domDiff.missingHeadings.length} sections (${remaining} remaining)`);

        iterRecord.discrepancyCount = domDiff.missingHeadings.length;
        record.iterations.push(iterRecord);

        // Provide the first 8 KB of the document as a style reference so the model
        // can match colours, typography, and spacing without seeing the full HTML.
        const styleContext = currentHtml.slice(0, 8000);

        const saveFragment = betaZodTool({
          name: "save_fragment",
          description:
            "Append new HTML section fragments before </body>. Call once with all new sections.",
          inputSchema: z.object({
            fragment: z
              .string()
              .describe(
                "New <section>/<div> elements to insert before </body>. Must NOT contain <html>, <head>, or <body> tags.",
              ),
          }),
          run: async (input) => {
            const injected = currentHtml.replace(/(<\/body>)/i, `${input.fragment}\n$1`);
            fs.writeFileSync(currentFilePath, injected, "utf-8");
            savedPath = currentFilePath;
            return JSON.stringify({ success: true });
          },
        });

        const fixRunner = client.beta.messages.toolRunner({
          model: "claude-sonnet-4-6",
          max_tokens: 16384,
          tools: [saveFragment],
          tool_choice: { type: "tool", name: "save_fragment" },
          stream: true,
          max_iterations: 1,
          system: `You are an expert front-end developer completing a partially-generated HTML page. Output ONLY the HTML fragments for the missing sections — do NOT output a full document, and do NOT include <html>, <head>, or <body> tags. Use responsive Tailwind classes matching the style context provided.`,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "image",
                  source: { type: "base64", media_type: "image/png", data: sourceFoldBase64 },
                },
                {
                  type: "text",
                  text: `The image above is the SOURCE page. Generate HTML fragment(s) for these missing sections in the order they appear on the source page:\n\n<missing_sections>\n${missingList}\n</missing_sections>\n\nMatch the styling patterns from this existing page context:\n\n<style_context>\n${styleContext}\n</style_context>`,
                },
              ],
            },
          ],
        });

        const { tokensIn: fixIn, tokensOut: fixOut } = await renderStream(fixRunner);
        const fixDurationMs = Date.now() - fixStart;
        totalTokensIn += fixIn;
        totalTokensOut += fixOut;

        logger.log({
          phase: "fix",
          timestamp: Date.now(),
          data: {
            iteration: i + 1,
            model: "claude-sonnet-4-6",
            tokensIn: fixIn,
            tokensOut: fixOut,
            durationMs: fixDurationMs,
            htmlSizeDelta: savedPath
              ? fs.readFileSync(savedPath, "utf-8").length - currentHtml.length
              : 0,
          },
        });

        structureItersUsed++;
      } else {
        // Content and visual: full-page rewrite via save_file
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

        if (level === "content") {
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
          contentItersUsed++;
        } else {
          // Level 3: visual fix using VLM discrepancy list
          console.log(`[fidelity] Captioning discrepancies...`);
          const discrepancies = await captionDiscrepancies(sourceFoldBase64, genFoldBase64, {
            sourceWideBase64,
            generatedWideBase64: genWideBase64,
          });
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
          const discrepancyList = discrepancies
            .map((d) => `[${d.severity}] ${d.section}: ${d.issue}`)
            .join("\n");
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

        const fixRunner = client.beta.messages.toolRunner({
          model: "claude-sonnet-4-6",
          max_tokens: estimateMaxTokens(currentHtml.length, "claude-sonnet-4-6"),
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
        totalTokensIn += fixIn;
        totalTokensOut += fixOut;

        logger.log({
          phase: "fix",
          timestamp: Date.now(),
          data: {
            iteration: i + 1,
            model: "claude-sonnet-4-6",
            tokensIn: fixIn,
            tokensOut: fixOut,
            durationMs: fixDurationMs,
            htmlSizeDelta: savedPath
              ? fs.readFileSync(savedPath, "utf-8").length - currentHtml.length
              : 0,
          },
        });
      }

      if (!savedPath) {
        console.log("[fidelity] Fix pass did not save a file — stopping loop.");
        break;
      }

      prevCompositeScore = compositeScore;
    }
  }

  // ─── Cost + record finalisation ─────────────────────────────────────────────
  record.completedAt = Date.now();
  record.estimatedCostUsd = estimateCost("claude-sonnet-4-6", totalTokensIn, totalTokensOut);

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

