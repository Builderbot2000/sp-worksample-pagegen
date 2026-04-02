/**
 * Initial generation stage test script.
 *
 * Usage:
 *   npx tsx scripts/test-generate.ts <url> [--name <label>] [--out <dir>]
 *
 * Runs crawlAndPreprocess() then the single generate LLM call in isolation
 * (no fidelity loop, no patching) and writes:
 *   <out>/main/<page>.html    — generated HTML page
 *   <out>/screenshot.png      — full-page source screenshot
 *   <out>/arch.json           — visual arch doc + crawl metadata
 *   <out>/report.html         — visual report (source screenshot + generated page link)
 *
 * Defaults to out = output/<timestamp>-<name|generate-test>/
 */

import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { crawlAndPreprocess } from "../src/context";
import { renderStream } from "../src/render";
import { estimateMaxTokens } from "../src/observability/metrics";
import type { VisualArchDoc } from "../src/observability/types";

// ── Parse args ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const urlArg = args.find((a) => !a.startsWith("--"));
const outIndex = args.indexOf("--out");
const outArg = outIndex !== -1 ? args[outIndex + 1] : undefined;
const nameIndex = args.indexOf("--name");
const nameArg = nameIndex !== -1 ? args[nameIndex + 1] : undefined;

if (!urlArg) {
  console.error("Usage: npx tsx scripts/test-generate.ts <url> [--name <label>] [--out <dir>]");
  process.exit(1);
}

const GENERATE_MODEL = "claude-sonnet-4-6";
const client = new Anthropic();

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function formatArchDoc(archDoc: VisualArchDoc): string {
  const sectionsText = archDoc.sections
    .map((s) => `  ${s.order}. slug: "${s.slug}" | role: ${s.role}\n     ${s.description}`)
    .join("\n");
  const fixedText = archDoc.fixedElements.length > 0 ? archDoc.fixedElements.join("; ") : "None";
  return `Background: ${archDoc.backgroundDescription}
Fixed/sticky elements: ${fixedText}
Sections (in visual order):
${sectionsText}`;
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

async function main() {
  const runSlug = nameArg ? slugify(nameArg) : "generate-test";
  const outDir = outArg ?? path.join(path.resolve(__dirname, "../output"), `${Date.now()}-${runSlug}`);
  const mainDir = path.join(outDir, "main");
  fs.mkdirSync(mainDir, { recursive: true });

  console.log(`\n[generate] Crawling: ${urlArg}`);
  console.log(`[generate] Output:   ${outDir}\n`);

  // ── Crawl ─────────────────────────────────────────────────────────────────

  const crawlResult = await crawlAndPreprocess(urlArg!);

  fs.writeFileSync(path.join(outDir, "screenshot.png"), Buffer.from(crawlResult.screenshotBase64, "base64"));
  console.log(`[generate] Full-page screenshot saved.`);

  const archJson = {
    visualArchDoc: crawlResult.visualArchDoc,
    scrollHeight: crawlResult.scrollHeight,
    truncated: crawlResult.truncated,
    htmlBytes: crawlResult.html.length,
    imageUrls: crawlResult.imageUrls,
    fontFamilies: crawlResult.fontFamilies,
    computedStyles: crawlResult.computedStyles,
    svgCount: crawlResult.svgs.length,
  };
  fs.writeFileSync(path.join(outDir, "arch.json"), JSON.stringify(archJson, null, 2));
  console.log(`[generate] arch.json saved. ${crawlResult.visualArchDoc.sections.length} sections detected.`);

  // ── Generate ──────────────────────────────────────────────────────────────

  const archDocText = formatArchDoc(crawlResult.visualArchDoc);
  const stylesJson = JSON.stringify(crawlResult.computedStyles, null, 2);
  const fontsText = crawlResult.fontFamilies.join(", ");
  const imageUrlsText = crawlResult.imageUrls.join("\n");
  const svgsText = crawlResult.svgs.join("\n");

  let savedPath: string | null = null;

  const saveFile = betaZodTool({
    name: "save_file",
    description: "Save the generated HTML page to disk. Call this once with the complete HTML content.",
    inputSchema: z.object({
      filename: z.string().describe("A descriptive kebab-case filename, e.g. acme-landing-page.html"),
      content: z.string().describe("The full HTML content of the page"),
    }),
    run: async (input) => {
      const outPath = path.join(mainDir, input.filename);
      fs.writeFileSync(outPath, input.content, "utf-8");
      savedPath = outPath;
      return JSON.stringify({ success: true, file_path: outPath });
    },
  });

  console.log(`[generate] Calling ${GENERATE_MODEL}...`);
  const generateStart = Date.now();

  const runner = client.beta.messages.toolRunner({
    model: GENERATE_MODEL,
    max_tokens: estimateMaxTokens(crawlResult.html.length, GENERATE_MODEL),
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
            type: "image",
            source: { type: "base64", media_type: "image/png", data: crawlResult.screenshotBase64 },
          },
          {
            type: "text",
            text: `The image above is a screenshot of the source page at ${urlArg}. Use it as the primary visual reference.

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
  const durationMs = Date.now() - generateStart;

  console.log(`\n[generate] Done in ${(durationMs / 1000).toFixed(1)}s — ${tokensIn} in / ${tokensOut} out tokens`);
  if (savedPath) {
    console.log(`[generate] Output: ${savedPath}`);
  } else {
    console.warn("[generate] Warning: model did not call save_file.");
  }

  // ── Report ────────────────────────────────────────────────────────────────

  const generatedRelPath = savedPath ? path.relative(outDir, savedPath) : null;
  const sectionRows = crawlResult.visualArchDoc.sections
    .map(
      (s) =>
        `<tr>
          <td style="padding:0.3rem 0.75rem 0.3rem 0;font-family:monospace;font-size:0.8rem;color:#60a5fa">${escHtml(s.slug)}</td>
          <td style="padding:0.3rem 0.5rem;font-size:0.75rem;background:#374151;color:#d1d5db;border-radius:3px">${escHtml(s.role)}</td>
          <td style="padding:0.3rem 0;font-size:0.8rem;color:#9ca3af">${escHtml(s.description)}</td>
        </tr>`,
    )
    .join("\n");

  const metaRows: [string, string][] = [
    ["URL", urlArg!],
    ["Model", GENERATE_MODEL],
    ["Tokens in", tokensIn.toLocaleString()],
    ["Tokens out", tokensOut.toLocaleString()],
    ["Duration", `${(durationMs / 1000).toFixed(1)}s`],
    ["HTML size", `${(crawlResult.html.length / 1024).toFixed(1)} KB${crawlResult.truncated ? " (truncated)" : ""}`],
    ["Sections", String(crawlResult.visualArchDoc.sections.length)],
  ];

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Generate Test — ${escHtml(urlArg!)}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #111827; color: #e5e7eb; padding: 2rem; line-height: 1.5; }
    h1 { font-size: 1.1rem; font-weight: 700; color: #f9fafb; margin-bottom: 0.25rem; }
    h2 { font-size: 0.85rem; font-weight: 600; color: #9ca3af; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 1rem; }
    .grid { display: grid; grid-template-columns: 320px 1fr; gap: 2rem; align-items: start; }
    .sidebar > * + * { margin-top: 1.5rem; }
    .card { background: #1f2937; border-radius: 8px; padding: 1.25rem; }
    a { color: #60a5fa; }
  </style>
</head>
<body>
  <div style="margin-bottom:1.5rem">
    <h1>${nameArg ? escHtml(nameArg) : "Generate Test"}</h1>
    <p style="color:#9ca3af;font-size:0.85rem;margin-top:0.25rem">${escHtml(urlArg!)}</p>
  </div>

  <div class="grid">
    <div class="sidebar">

      <div class="card">
        <h2>Run Metadata</h2>
        <table><tbody>
          ${metaRows.map(([k, v]) => `<tr><td style="padding:0.3rem 0.75rem 0.3rem 0;color:#9ca3af;font-size:0.8rem;white-space:nowrap">${escHtml(k)}</td><td style="padding:0.3rem 0;font-size:0.8rem;color:#d1d5db;word-break:break-all">${escHtml(v)}</td></tr>`).join("")}
        </tbody></table>
      </div>

      ${generatedRelPath ? `<div class="card"><h2>Generated Page</h2><a href="${escHtml(generatedRelPath)}" style="font-size:0.85rem">${escHtml(path.basename(generatedRelPath))}</a></div>` : `<div class="card"><p style="color:#f87171;font-size:0.85rem">Model did not produce output.</p></div>`}

      <div class="card">
        <h2>Source Screenshot</h2>
        <img src="screenshot.png" style="width:100%;border-radius:4px" />
      </div>

    </div>

    <div>
      <div class="card">
        <h2>Detected Sections (${crawlResult.visualArchDoc.sections.length})</h2>
        <table style="width:100%;border-collapse:collapse"><tbody>
          ${sectionRows}
        </tbody></table>
      </div>
    </div>
  </div>
</body>
</html>`;

  fs.writeFileSync(path.join(outDir, "report.html"), html);
  console.log(`[generate] report.html saved.`);
  console.log(`\n[generate] Open: ${path.join(outDir, "report.html")}\n`);
}

main().catch((err) => { console.error(err); process.exit(1); });
