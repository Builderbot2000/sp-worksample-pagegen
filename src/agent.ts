import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { renderStream, printIterationHeader, printPageScore, printFinalSummary } from "./render";
import { enrichContext } from "./context";
import { screenshotPage } from "./screenshot";
import { scorePage } from "./diff/score";
import { captionPage } from "./diff/caption";
import { Recorder } from "./observability/recorder";
import { Logger } from "./observability/logger";
import { estimateCost, checkConvergence } from "./observability/metrics";
import { generateReport } from "./observability/report";
import { runBaseline } from "./baseline-runner";
import type { IterationRecord, RunRecord, BaselineComparison } from "./observability/types";

const client = new Anthropic();

const OUTPUT_ROOT = path.resolve(__dirname, "..", "output");

export interface GenerateOptions {
  maxIterations: number;
  threshold: number;
  baseline: boolean;
}

function urlSlug(url: string): string {
  return url
    .replace(/^https?:\/\//, "")
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function buildSaveFileTool(outputDir: string) {
  let savedPath: string | null = null;

  const tool = betaZodTool({
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
      const outPath = path.join(outputDir, input.filename);
      fs.mkdirSync(outputDir, { recursive: true });
      fs.writeFileSync(outPath, input.content, "utf-8");
      savedPath = outPath;
      return JSON.stringify({ success: true, file_path: outPath });
    },
  });

  return {
    tool,
    getSavedPath: () => savedPath,
  };
}

function buildFixFileTool(outputDir: string, existingFilename: string) {
  return betaZodTool({
    name: "save_file",
    description:
      "Save the repaired HTML page to disk, overwriting the previous version.",
    inputSchema: z.object({
      filename: z
        .string()
        .describe(`The filename to write. Use: ${existingFilename}`),
      content: z.string().describe("The full repaired HTML content of the page"),
    }),
    run: async (input) => {
      const outPath = path.join(outputDir, input.filename);
      fs.mkdirSync(outputDir, { recursive: true });
      fs.writeFileSync(outPath, input.content, "utf-8");
      return JSON.stringify({ success: true, file_path: outPath });
    },
  });
}

export interface GenerateResult {
  savedPath: string;
  reportPath: string;
  baselineSavedPath?: string;
}

export async function generatePage(
  url: string,
  opts: GenerateOptions,
): Promise<GenerateResult | null> {
  const runId = `${Date.now()}-${urlSlug(url)}`;
  const runDir = path.join(OUTPUT_ROOT, runId);
  fs.mkdirSync(runDir, { recursive: true });

  const recorder = new Recorder(runDir);
  const logger = new Logger(recorder);

  const startedAt = Date.now();
  let totalTokensIn = 0;
  let totalTokensOut = 0;
  const iterationRecords: IterationRecord[] = [];

  // ── Parallelize upfront context work ───────────────────────────────────────
  process.stdout.write("\n⏳ Enriching context and capturing source screenshot...\n");

  const [
    { html, screenshotChunks, computedStyles, absoluteImageUrls, fontFamilies, inlineSvgs },
    sourceScreenshotResult,
  ] = await Promise.all([
    enrichContext(url).then((ctx) => {
      logger.log({
        phase: "fetch",
        timestamp: Date.now(),
        data: {
          url,
          htmlBytes: ctx.html.length,
          truncated: ctx.html.endsWith("<!-- truncated -->"),
        },
      });
      return ctx;
    }),
    screenshotPage(url).then((r) => {
      logger.log({
        phase: "screenshot",
        timestamp: Date.now(),
        data: {
          target: url,
          imageBytes: r.buffer.length,
          durationMs: 0,
        },
      });
      return r;
    }),
  ]);

  // ── Start baseline after context is fetched (avoids URL/rate-limit contention) ──
  const baselinePromise = opts.baseline
    ? runBaseline(url, path.join(runDir, "baseline")).then((r) => {
        process.stdout.write("✅ Baseline generation complete\n");
        return r;
      })
    : null;

  // ── Initial generation ─────────────────────────────────────────────────────
  const { tool: saveFile, getSavedPath } = buildSaveFileTool(path.join(runDir, "main"));

  const genStart = Date.now();
  const runner = client.beta.messages.toolRunner({
    model: "claude-sonnet-4-6",
    max_tokens: 32000,
    tools: [saveFile],
    tool_choice: { type: "tool", name: "save_file" },
    stream: true,
    max_iterations: 1,
    system: `You are a helpful assistant that generates HTML pages from source HTML.`,
    messages: [
      {
        role: "user",
        content: [
          ...screenshotChunks.map((data) => ({
            type: "image" as const,
            source: {
              type: "base64" as const,
              media_type: "image/png" as const,
              data,
            },
          })),
          {
            type: "text",
            text: `Create a single-file HTML page that recreates this page's content and visual design using Tailwind CSS (via CDN script tag).

The page MUST:

- Be a complete, self-contained HTML file
- Use the Tailwind CSS CDN (<script src="https://cdn.tailwindcss.com"></script>)
- Faithfully reproduce the layout, content, and visual style of the source page as shown in the viewport screenshots above (each image is a 1440×900px slice of the page from top to bottom)
- Be responsive and well-structured

Use descriptive kebab-case filename based on the source page's title or domain.

**Fonts**
The following non-generic font families were detected on the source page. Import each one via a Google Fonts <link> tag in the <head> and apply them to the appropriate elements:
${fontFamilies.length > 0 ? fontFamilies.map((f) => `- ${f}`).join("\n") : "- (none detected — use system fonts)"}
For each element, apply font sizes from the computed styles using Tailwind arbitrary values (e.g., \`text-[16px]\`). Do NOT use generic Tailwind size classes (text-sm, text-base, text-lg, etc.) when an exact px value is available. Match font-weight, line-height, and letter-spacing precisely from the computed styles.

**Layout**
Preserve the columnar and grid structure exactly as shown in the screenshots and computed styles. If a section uses an N-column grid or flex row, reproduce it with exactly N columns — use Tailwind arbitrary grid classes (e.g., \`grid grid-cols-[repeat(3,1fr)]\`) when the source layout doesn't map to a standard Tailwind column count. Do NOT collapse multi-column layouts into a single column or stacked list.

**Computed styles** (use these to match colors, spacing, typography, and layout exactly):
\`\`\`json
${JSON.stringify(computedStyles, null, 2)}
\`\`\`

**Image URLs** (use these exact absolute URLs as src attributes for <img> tags — do not use placeholder images):
${absoluteImageUrls.length > 0 ? absoluteImageUrls.map((u) => `- ${u}`).join("\n") : "- (none detected)"}

**SVG assets** — treat programmed graphics as assets, not visuals to approximate.
- For inline SVGs: copy the markup **verbatim** from the source HTML or from the list below. Do NOT redraw or simplify them.
- For external SVG URLs (ending in .svg in the image list above): use them as \`src\` in an \`<img>\` tag exactly as-is.
${inlineSvgs.length > 0
  ? inlineSvgs.map((svg, i) => `<!-- SVG asset ${i + 1} -->\n${svg}`).join("\n\n")
  : "- (no inline SVGs detected)"}

Here is the HTML source of the page at ${url}:

<source_html>
${html}
</source_html>`,
          },
        ],
      },
    ],
  });

  await renderStream(runner);
  const genEnd = Date.now();

  const savedPath = getSavedPath();
  if (!savedPath) {
    process.stderr.write("Generation failed: no file was saved.\n");
    return null;
  }

  // Estimate tokens from final message usage (best effort)
  try {
    const finalMsg = await runner.done();
    totalTokensIn += finalMsg.usage.input_tokens;
    totalTokensOut += finalMsg.usage.output_tokens;
    logger.log({
      phase: "generate",
      timestamp: Date.now(),
      data: {
        model: "claude-sonnet-4-6",
        tokensIn: finalMsg.usage.input_tokens,
        tokensOut: finalMsg.usage.output_tokens,
        durationMs: genEnd - genStart,
        outputFile: savedPath,
      },
    });
  } catch {
    // Not fatal — proceed without token tracking for this pass
  }

  // ── Iterative fix loop ─────────────────────────────────────────────────────
  let prevScore = 0;
  const overallScores: number[] = [];
  const filename = path.basename(savedPath);

  for (let iter = 0; iter < opts.maxIterations; iter++) {
    printIterationHeader(iter + 1, opts.maxIterations);

    // Screenshot the current generated output
    const outputScreenshot = await screenshotPage(`file://${savedPath}`);
    logger.log({
      phase: "screenshot",
      timestamp: Date.now(),
      data: {
        target: `file://${savedPath}`,
        imageBytes: outputScreenshot.buffer.length,
        durationMs: 0,
      },
    });

    // Full-page pixel diff
    const pageScore = scorePage(
      sourceScreenshotResult.buffer,
      outputScreenshot.buffer,
    );
    const currScore = pageScore.score;
    overallScores.push(currScore);

    printPageScore(pageScore);

    logger.log({
      phase: "diff",
      timestamp: Date.now(),
      data: {
        iteration: iter + 1,
        overallScore: currScore,
        diffPixels: pageScore.diffPixels,
        totalPixels: pageScore.totalPixels,
      },
    });

    // Stopping conditions
    const converged =
      pageScore.severity !== "high" &&
      iter > 0 &&
      checkConvergence(prevScore, currScore, opts.threshold);

    if (converged) {
      process.stdout.write(
        `\n✅ Converged at iteration ${iter + 1} (score ${currScore.toFixed(3)}, delta < ${opts.threshold})\n`,
      );
      iterationRecords.push({
        iteration: iter + 1,
        overallScore: currScore,
        severity: pageScore.severity,
        diffPixels: pageScore.diffPixels,
        totalPixels: pageScore.totalPixels,
        discrepancyCount: 0,
      });
      break;
    }

    // No meaningful differences — skip captioning
    if (pageScore.severity === "low") {
      process.stdout.write("\n✅ Fidelity is high — stopping.\n");
      iterationRecords.push({
        iteration: iter + 1,
        overallScore: currScore,
        severity: pageScore.severity,
        diffPixels: pageScore.diffPixels,
        totalPixels: pageScore.totalPixels,
        discrepancyCount: 0,
      });
      break;
    }

    // Caption: ask Claude what components are missing or out of position
    const { discrepancies, tokensIn: capIn, tokensOut: capOut } =
      await captionPage(pageScore);

    totalTokensIn += capIn;
    totalTokensOut += capOut;

    iterationRecords.push({
      iteration: iter + 1,
      overallScore: currScore,
      severity: pageScore.severity,
      diffPixels: pageScore.diffPixels,
      totalPixels: pageScore.totalPixels,
      discrepancyCount: discrepancies.length,
    });

    logger.log({
      phase: "caption",
      timestamp: Date.now(),
      data: {
        iteration: iter + 1,
        tokensIn: capIn,
        tokensOut: capOut,
        discrepancies,
      },
    });

    if (discrepancies.length === 0) {
      process.stdout.write("\n✅ No discrepancies to fix.\n");
      break;
    }

    // Fix prompt
    const currentHtml = fs.readFileSync(savedPath, "utf-8");
    const fixStart = Date.now();
    const fixTool = buildFixFileTool(path.join(runDir, "main"), filename);

    const fixRunner = client.beta.messages.toolRunner({
      model: "claude-sonnet-4-6",
      max_tokens: 32000,
      tools: [fixTool],
      tool_choice: { type: "tool", name: "save_file" },
      stream: true,
      max_iterations: 1,
      system: `You are a helpful assistant that repairs HTML pages to improve visual fidelity.`,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `You have generated an HTML page that does not fully match the source visual design.
Below is the list of visual discrepancies found by automated pixel comparison:

\`\`\`json
${JSON.stringify(discrepancies, null, 2)}
\`\`\`

Repair ONLY the failing segments listed above. Do not change sections that are not mentioned.
Keep all existing Tailwind classes, fonts, and image URLs that are correct.

Return the COMPLETE repaired HTML by calling the save_file tool with filename: ${filename}

Current generated HTML:
<generated_html>
${currentHtml}
</generated_html>`,
            },
          ],
        },
      ],
    });

    await renderStream(fixRunner);
    const fixEnd = Date.now();

    try {
      const fixMsg = await fixRunner.done();
      const htmlSizeDelta = fs.statSync(savedPath).size - currentHtml.length;
      totalTokensIn += fixMsg.usage.input_tokens;
      totalTokensOut += fixMsg.usage.output_tokens;
      logger.log({
        phase: "fix",
        timestamp: Date.now(),
        data: {
          iteration: iter + 1,
          model: "claude-sonnet-4-6",
          tokensIn: fixMsg.usage.input_tokens,
          tokensOut: fixMsg.usage.output_tokens,
          durationMs: fixEnd - fixStart,
          htmlSizeDelta,
        },
      });
    } catch {
      // Not fatal
    }

    prevScore = currScore;
  }

  // Final summary
  printFinalSummary(overallScores);

  const mainDurationMs = Date.now() - startedAt;
  const mainCostUsd = estimateCost("claude-sonnet-4-6", totalTokensIn, totalTokensOut);

  // ── Baseline comparison (if requested) ──────────────────────────────────────
  let baseline: BaselineComparison | undefined;
  let baselineSavedPath: string | undefined;

  if (baselinePromise && savedPath) {
    const baselineResult = await baselinePromise;

    if (baselineResult.outputPath) {
      baselineSavedPath = baselineResult.outputPath;
      // Screenshot both final outputs and score against source
      const [mainScreenshot, baselineScreenshot] = await Promise.all([
        screenshotPage(`file://${savedPath}`),
        screenshotPage(`file://${baselineResult.outputPath}`),
      ]);

      const mainScore = scorePage(sourceScreenshotResult.buffer, mainScreenshot.buffer);
      const baselineScore = scorePage(sourceScreenshotResult.buffer, baselineScreenshot.buffer);

      baseline = {
        baselineScore: baselineScore.score,
        baselineCostUsd: baselineResult.costUsd,
        baselineDurationMs: baselineResult.durationMs,
        baselineThumbnail: baselineScreenshot.buffer.toString("base64"),
        mainScore: mainScore.score,
        mainCostUsd: mainCostUsd,
        mainDurationMs: mainDurationMs,
        mainThumbnail: mainScreenshot.buffer.toString("base64"),
      };

      process.stdout.write(
        `\n📊 Baseline comparison: main ${mainScore.score.toFixed(3)} vs baseline ${baselineScore.score.toFixed(3)}\n`,
      );
    }
  }

  const runRecord: RunRecord = {
    runId,
    url,
    startedAt,
    completedAt: Date.now(),
    iterations: iterationRecords,
    estimatedCostUsd: mainCostUsd,
    baseline,
  };

  logger.finalize(runRecord);
  const reportPath = generateReport(runDir, runRecord, sourceScreenshotResult.buffer);
  return { savedPath, reportPath, baselineSavedPath };
}
