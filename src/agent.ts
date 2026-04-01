import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { renderStream } from "./render";
import { enrichContext } from "./context";
import { Recorder } from "./observability/recorder";
import { Logger } from "./observability/logger";
import { estimateCost } from "./observability/metrics";
import {
  collectFidelityMetrics,
  screenshotAndExtract,
  computeVlmFidelityScore,
  scoreSeverity,
  captionDiscrepancies,
} from "./observability/fidelity";
import { generateReport } from "./observability/report";
import type { RunRecord } from "./observability/types";

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
    max_tokens: 16000,
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
    max_tokens: 16000,
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
- Be responsive and well-structured
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
  const sourceBase64 = context.screenshotBase64;
  let prevScore: number | null = null;

  if (savedPath) {
    for (let i = 0; i < MAX_ITER; i++) {
      console.log(`\n[fidelity] Iteration ${i + 1}/${MAX_ITER} — scoring...`);

      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const { screenshot: genBuf } = await screenshotAndExtract({ file: savedPath! });
      const genBase64 = genBuf.toString("base64");

      const vlmScore = await computeVlmFidelityScore(sourceBase64, genBase64);
      const severity = scoreSeverity(vlmScore.score);

      logger.log({
        phase: "diff",
        timestamp: Date.now(),
        data: { iteration: i + 1, vlmScore: vlmScore.score, vlmVerdict: vlmScore.verdict },
      });

      const iterRecord = {
        iteration: i + 1,
        vlmScore: vlmScore.score,
        vlmVerdict: vlmScore.verdict,
        severity,
        discrepancyCount: 0,
      };

      console.log(`[fidelity] Score: ${vlmScore.score.toFixed(3)} (${severity})`);

      if (severity === "low") {
        console.log("[fidelity] Severity low — converged, stopping loop.");
        record.iterations.push(iterRecord);
        break;
      }

      if (prevScore !== null && Math.abs(vlmScore.score - prevScore) < CONV_THRESHOLD) {
        console.log("[fidelity] Score delta below threshold — converged, stopping loop.");
        record.iterations.push(iterRecord);
        break;
      }

      console.log(`[fidelity] Captioning discrepancies...`);
      const discrepancies = await captionDiscrepancies(sourceBase64, genBase64);

      iterRecord.discrepancyCount = discrepancies.length;
      record.iterations.push(iterRecord);

      logger.log({
        phase: "caption",
        timestamp: Date.now(),
        data: {
          iteration: i + 1,
          tokensIn: 0,
          tokensOut: 0,
          discrepancies,
        },
      });

      if (discrepancies.length === 0) {
        console.log("[fidelity] No actionable discrepancies — stopping loop.");
        break;
      }

      console.log(`[fidelity] ${discrepancies.length} discrepancies — running fix pass...`);

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

      const discrepancyList = discrepancies
        .map((d) => `[${d.severity}] ${d.section}: ${d.issue}`)
        .join("\n");

      const fixStart = Date.now();
      const fixRunner = client.beta.messages.toolRunner({
        model: "claude-sonnet-4-6",
        max_tokens: 32000,
        tools: [fixSaveFile],
        tool_choice: { type: "tool", name: "save_file" },
        stream: true,
        max_iterations: 1,
        system: `You are an expert front-end developer fixing visual fidelity issues in a generated HTML page. You will be shown the source page screenshot and a list of specific discrepancies. Fix ONLY the listed issues — do not modify sections that are already correct.`,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "base64", media_type: "image/png", data: sourceBase64 },
              },
              {
                type: "text",
                text: `The image above is the SOURCE page you must match. The HTML below is the current reconstruction. Fix ONLY the discrepancies listed — do not change anything else.

<discrepancies>
${discrepancyList}
</discrepancies>

<current_html>
${currentHtml}
</current_html>`,
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

      prevScore = vlmScore.score;
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

