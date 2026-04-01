import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { renderStream, printIterationHeader, printPageScore, printFinalSummary } from "./render";
import { enrichContext } from "./context";
import type { PageSection } from "./context";
import type { ComputedStyles } from "./context";
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

function buildSaveSectionTool(sectionId: string) {
  let savedContent: string | null = null;

  const tool = betaZodTool({
    name: "save_section",
    description:
      "Save a generated HTML section fragment. The content must NOT include <html>, <head>, or <body> tags — only the inner fragment markup for this section.",
    inputSchema: z.object({
      content: z.string().describe("The HTML fragment for this section only. No <html>/<head>/<body> tags."),
    }),
    run: async (input) => {
      savedContent = input.content;
      return JSON.stringify({ success: true, section_id: sectionId });
    },
  });

  return { tool, getContent: () => savedContent };
}

function buildPageShell(fontFamilies: string[], computedStyles: ComputedStyles): string {
  const bodyBg = computedStyles["body"]?.["background-color"] ?? "rgb(255, 255, 255)";
  const bodyColor = computedStyles["body"]?.["color"] ?? "rgb(0, 0, 0)";
  const fontLinks = fontFamilies
    .map((f) => {
      const encoded = encodeURIComponent(f);
      return `  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=${encoded}:ital,wght@0,300;0,400;0,500;0,600;0,700;0,800&display=swap">`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <script src="https://cdn.tailwindcss.com"></script>
${fontLinks}
  <style>
    body { background-color: ${bodyBg}; color: ${bodyColor}; }
  </style>
</head>
<body>`;
}

function buildSectionPrompt(opts: {
  section: PageSection;
  sectionIndex: number;
  totalSections: number;
  computedStyles: ComputedStyles;
  fontFamilies: string[];
  absoluteImageUrls: string[];
  inlineSvgs: string[];
  prevTail: string | null;
}): string {
  const { section, sectionIndex, totalSections, computedStyles, fontFamilies, absoluteImageUrls, inlineSvgs, prevTail } = opts;
  return `You are generating section ${sectionIndex + 1} of ${totalSections} of a page reconstruction.

CRITICAL: Output ONLY an HTML fragment for this section. Do NOT include <html>, <head>, <body>, or any Tailwind CDN script tags — those are already in the surrounding shell.

The section screenshots above show exactly what this section looks like (1440×900px slices from top to bottom of the section).

**Fonts in use across this page:**
${fontFamilies.length > 0 ? fontFamilies.map((f) => `- ${f}`).join("\n") : "- (none — use system fonts)"}
Apply font sizes from computed styles using Tailwind arbitrary values (e.g., \`text-[16px]\`). Do NOT use generic size classes (text-sm, text-base, etc.) when an exact px value is available.

**Layout**
Reproduce the columnar and grid structure exactly as shown in screenshots and computed styles. Use Tailwind arbitrary grid classes (e.g., \`grid grid-cols-[repeat(3,1fr)]\`) when needed. Do NOT collapse multi-column layouts.

**Computed styles** (use for colors, spacing, typography):
\`\`\`json
${JSON.stringify(computedStyles, null, 2)}
\`\`\`

**Image URLs** (use exact absolute URLs):
${absoluteImageUrls.length > 0 ? absoluteImageUrls.map((u) => `- ${u}`).join("\n") : "- (none)"}

**SVG assets** — copy verbatim, do NOT redraw:
${inlineSvgs.length > 0 ? inlineSvgs.map((svg, i) => `<!-- SVG ${i + 1} -->\n${svg}`).join("\n\n") : "- (none)"}

**Source HTML for this section:**
<section_html>
${section.html}
</section_html>
${prevTail ? `\n**Preceding section tail** (match spacing/colors at the boundary — do NOT repeat this markup):\n<preceding_section_tail>\n${prevTail}\n</preceding_section_tail>` : ""}

Call save_section with your HTML fragment now.`;
}

async function generatePageInSections(
  client: Anthropic,
  opts: {
    url: string;
    sections: PageSection[];
    computedStyles: ComputedStyles;
    fontFamilies: string[];
    absoluteImageUrls: string[];
    inlineSvgs: string[];
    outDir: string;
  },
): Promise<{ savedPath: string | null; tokensIn: number; tokensOut: number; filename: string | null }> {
  const { url, sections, computedStyles, fontFamilies, absoluteImageUrls, inlineSvgs, outDir } = opts;
  let tokensIn = 0;
  let tokensOut = 0;
  const sectionContents: string[] = [];

  for (let i = 0; i < sections.length; i++) {
    const section = sections[i];
    process.stdout.write(`\n⚙️  Generating section ${i + 1}/${sections.length}: ${section.id}\n`);

    const prevTail = i > 0 && sectionContents[i - 1]
      ? sectionContents[i - 1].slice(-2000)
      : null;

    const { tool, getContent } = buildSaveSectionTool(section.id);

    const sectionRunner = client.beta.messages.toolRunner({
      model: "claude-sonnet-4-6",
      max_tokens: 16000,
      tools: [tool],
      tool_choice: { type: "tool", name: "save_section" },
      stream: true,
      max_iterations: 1,
      system: `You are a helpful assistant that generates HTML section fragments from source HTML. You produce only the fragment — no document shell.`,
      messages: [
        {
          role: "user",
          content: [
            ...section.screenshotChunks.map((data) => ({
              type: "image" as const,
              source: {
                type: "base64" as const,
                media_type: "image/png" as const,
                data,
              },
            })),
            {
              type: "text",
              text: buildSectionPrompt({ section, sectionIndex: i, totalSections: sections.length, computedStyles, fontFamilies, absoluteImageUrls, inlineSvgs, prevTail }),
            },
          ],
        },
      ],
    });

    await renderStream(sectionRunner);

    try {
      const msg = await sectionRunner.done();
      tokensIn += msg.usage.input_tokens;
      tokensOut += msg.usage.output_tokens;
    } catch {
      // Not fatal
    }

    const content = getContent();
    sectionContents.push(content ?? "<!-- section generation failed -->");
  }

  const shell = buildPageShell(fontFamilies, computedStyles);
  const assembled = shell + "\n" + sectionContents.join("\n") + "\n</body>\n</html>";

  fs.mkdirSync(outDir, { recursive: true });
  const filename = urlSlug(url) + ".html";
  const savedPath = path.join(outDir, filename);
  fs.writeFileSync(savedPath, assembled, "utf-8");
  process.stdout.write(`\n✅ Assembled ${sections.length} sections → ${savedPath}\n`);

  return { savedPath, tokensIn, tokensOut, filename };
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
    { html, screenshotChunks, computedStyles, absoluteImageUrls, fontFamilies, inlineSvgs, sections },
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
  const mainOutDir = path.join(runDir, "main");
  const genStart = Date.now();
  let savedPath: string | null = null;
  let genFilename: string | null = null;

  if (sections.length >= 2) {
    // Multi-section path: generate each semantic section independently then assemble
    process.stdout.write(`\n📐 Segmented generation: ${sections.length} sections detected\n`);
    const result = await generatePageInSections(client, {
      url,
      sections,
      computedStyles,
      fontFamilies,
      absoluteImageUrls,
      inlineSvgs,
      outDir: mainOutDir,
    });
    savedPath = result.savedPath;
    genFilename = result.filename;
    totalTokensIn += result.tokensIn;
    totalTokensOut += result.tokensOut;
    logger.log({
      phase: "generate",
      timestamp: Date.now(),
      data: {
        model: "claude-sonnet-4-6",
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
        durationMs: Date.now() - genStart,
        outputFile: savedPath ?? "",
      },
    });
  } else {
    // Single-shot path (short pages or pages where segmentation found < 2 sections)
    const { tool: saveFile, getSavedPath } = buildSaveFileTool(mainOutDir);

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

    savedPath = getSavedPath();
    genFilename = savedPath ? path.basename(savedPath) : null;

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
          durationMs: Date.now() - genStart,
          outputFile: savedPath ?? "",
        },
      });
    } catch {
      // Not fatal — proceed without token tracking for this pass
    }
  }

  const genEnd = Date.now();
  void genEnd; // used only for logging above

  if (!savedPath) {
    process.stderr.write("Generation failed: no file was saved.\n");
    return null;
  }

  // ── Iterative fix loop ─────────────────────────────────────────────────────
  let prevScore = 0;
  const overallScores: number[] = [];
  const filename = genFilename ?? path.basename(savedPath);

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
