/**
 * Skeleton generation stage test script.
 *
 * Tests Stage 1 of the parallel section generation architecture:
 * the Skeleton Agent produces a complete HTML document with all global elements
 * (head, font imports, CSS custom properties, Tailwind config, nav, layout wrappers)
 * and empty labelled section shells — no section interior content.
 *
 * Usage:
 *   npx tsx scripts/test-skeleton.ts <url> [--name <label>] [--out <dir>]
 *
 * Outputs:
 *   <out>/main/<page>.html    — skeleton HTML (reviewable checkpoint)
 *   <out>/screenshot.png      — full-page source screenshot
 *   <out>/arch.json           — visual arch doc + crawl metadata
 *   <out>/report.html         — visual report (source screenshot + skeleton link + section shell table)
 *
 * Defaults to out = output/<timestamp>-<name|skeleton-test>/
 */

import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { crawlAndPreprocess } from "../src/context";
import { renderStream } from "../src/render";
import { resizeForVlm } from "../src/image";
import { estimateMaxTokens } from "../src/observability/metrics";
import { escHtml, slugify } from "../src/utils";
import { formatArchDoc } from "../src/pipeline/assembly";
import { SKELETON_SYSTEM, buildSkeletonUserContent } from "../src/prompts/skeleton";

// ── Parse args ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const urlArg = args.find((a) => !a.startsWith("--"));
const outIndex = args.indexOf("--out");
const outArg = outIndex !== -1 ? args[outIndex + 1] : undefined;
const nameIndex = args.indexOf("--name");
const nameArg = nameIndex !== -1 ? args[nameIndex + 1] : undefined;

if (!urlArg) {
  console.error(
    "Usage: npx tsx scripts/test-skeleton.ts <url> [--name <label>] [--out <dir>]",
  );
  process.exit(1);
}

const SKELETON_MODEL = "claude-sonnet-4-6";
const client = new Anthropic();

async function main() {
  const runSlug = nameArg ? slugify(nameArg) : "skeleton-test";
  const outDir =
    outArg ??
    path.join(
      path.resolve(__dirname, "../output"),
      `${Date.now()}-${runSlug}`,
    );
  const mainDir = path.join(outDir, "main");
  fs.mkdirSync(mainDir, { recursive: true });

  console.log(`\n[skeleton] Crawling: ${urlArg}`);
  console.log(`[skeleton] Output:   ${outDir}\n`);

  // ── Crawl ─────────────────────────────────────────────────────────────────

  const crawlResult = await crawlAndPreprocess(urlArg!);

  fs.writeFileSync(
    path.join(outDir, "screenshot.png"),
    Buffer.from(crawlResult.screenshotBase64, "base64"),
  );
  console.log(`[skeleton] Full-page screenshot saved.`);

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
  fs.writeFileSync(
    path.join(outDir, "arch.json"),
    JSON.stringify(archJson, null, 2),
  );
  console.log(
    `[skeleton] arch.json saved. ${crawlResult.visualArchDoc.sections.length} sections detected.`,
  );

  // ── Resize full-page screenshot for VLM input ─────────────────────────────

  const screenshotBuf = Buffer.from(crawlResult.screenshotBase64, "base64");
  const resizedScreenshot = await resizeForVlm(screenshotBuf);
  console.log(`[skeleton] Screenshot resized for VLM input.`);

  // ── Skeleton generation ───────────────────────────────────────────────────────────────────────────

  const archDocText = formatArchDoc(crawlResult.visualArchDoc);
  const slugList = crawlResult.visualArchDoc.sections
    .map((s) => `  ${s.order}. "${s.slug}" (${s.role})`)
    .join('\n');
  const navIsSection = crawlResult.visualArchDoc.sections.some(
    (s) => s.role === 'navbar' || s.role === 'header',
  );

  let savedPath: string | null = null;

  const saveFile = betaZodTool({
    name: 'save_file',
    description: 'Save the generated skeleton HTML to disk. Call this once with the complete skeleton HTML.',
    inputSchema: z.object({
      filename: z.string().describe('A descriptive kebab-case filename, e.g. acme-landing-page-skeleton.html'),
      content: z.string().describe('The full skeleton HTML content'),
    }),
    run: async (input) => {
      const outPath = path.join(mainDir, input.filename);
      fs.writeFileSync(outPath, input.content, 'utf-8');
      savedPath = outPath;
      return JSON.stringify({ success: true, file_path: outPath });
    },
  });

  console.log(`[skeleton] Calling ${SKELETON_MODEL}...`);
  const skeletonStart = Date.now();

  const runner = client.beta.messages.toolRunner({
    model: SKELETON_MODEL,
    max_tokens: estimateMaxTokens(crawlResult.html.length, SKELETON_MODEL),
    thinking: { type: 'disabled' },
    tools: [saveFile],
    tool_choice: { type: 'tool', name: 'save_file' },
    stream: true,
    max_iterations: 1,
    system: SKELETON_SYSTEM(navIsSection),
    messages: [
      {
        role: 'user',
        content: buildSkeletonUserContent({
          url: urlArg!,
          resizedScreenshotBase64: resizedScreenshot.toString('base64'),
          slugList,
          archDocText,
          stylesJson: JSON.stringify(crawlResult.computedStyles, null, 2),
          fontsText: crawlResult.fontFamilies.join(', '),
          imageUrlsText: crawlResult.imageUrls.join('\n'),
          svgsText: crawlResult.svgs.join('\n'),
          fixedElementsHtml: crawlResult.fixedElementsHtml.join('\n\n'),
          sourceHtml: crawlResult.html,
        }),
      },
    ],
  });

    const { tokensIn, tokensOut } = await renderStream(runner);
  const durationMs = Date.now() - skeletonStart;

  console.log(
    `\n[skeleton] Done in ${(durationMs / 1000).toFixed(1)}s — ${tokensIn} in / ${tokensOut} out tokens`,
  );
  if (savedPath) {
    console.log(`[skeleton] Output: ${savedPath}`);
  } else {
    console.warn("[skeleton] Warning: model did not call save_file.");
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
    ["Model", SKELETON_MODEL],
    ["Tokens in", tokensIn.toLocaleString()],
    ["Tokens out", tokensOut.toLocaleString()],
    ["Duration", `${(durationMs / 1000).toFixed(1)}s`],
    [
      "HTML size",
      `${(crawlResult.html.length / 1024).toFixed(1)} KB${crawlResult.truncated ? " (truncated)" : ""}`,
    ],
    ["Sections", String(crawlResult.visualArchDoc.sections.length)],
    ["Stage", "1 — Skeleton"],
  ];

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Skeleton Test — ${escHtml(urlArg!)}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #111827; color: #e5e7eb; padding: 2rem; line-height: 1.5; }
    h1 { font-size: 1.1rem; font-weight: 700; color: #f9fafb; margin-bottom: 0.25rem; }
    h2 { font-size: 0.85rem; font-weight: 600; color: #9ca3af; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 1rem; }
    .grid { display: grid; grid-template-columns: 320px 1fr; gap: 2rem; align-items: start; }
    .sidebar > * + * { margin-top: 1.5rem; }
    .card { background: #1f2937; border-radius: 8px; padding: 1.25rem; }
    a { color: #60a5fa; }
    .badge { display: inline-block; padding: 0.15rem 0.5rem; border-radius: 3px; font-size: 0.7rem; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; background: #1e3a5f; color: #93c5fd; }
  </style>
</head>
<body>
  <div style="margin-bottom:1.5rem;display:flex;align-items:baseline;gap:0.75rem">
    <h1>${nameArg ? escHtml(nameArg) : "Skeleton Test"}</h1>
    <span class="badge">Stage 1 — Skeleton</span>
  </div>
  <p style="color:#9ca3af;font-size:0.85rem;margin-top:-0.75rem;margin-bottom:1.5rem">${escHtml(urlArg!)}</p>

  <div class="grid">
    <div class="sidebar">

      <div class="card">
        <h2>Run Metadata</h2>
        <table><tbody>
          ${metaRows.map(([k, v]) => `<tr><td style="padding:0.3rem 0.75rem 0.3rem 0;color:#9ca3af;font-size:0.8rem;white-space:nowrap">${escHtml(k)}</td><td style="padding:0.3rem 0;font-size:0.8rem;color:#d1d5db;word-break:break-all">${escHtml(v)}</td></tr>`).join("")}
        </tbody></table>
      </div>

      ${
        generatedRelPath
          ? `<div class="card"><h2>Skeleton Output</h2><a href="${escHtml(generatedRelPath)}" style="font-size:0.85rem">${escHtml(path.basename(generatedRelPath))}</a><p style="color:#6b7280;font-size:0.75rem;margin-top:0.5rem">Global elements rendered, section shells empty.</p></div>`
          : `<div class="card"><p style="color:#f87171;font-size:0.85rem">Model did not produce output.</p></div>`
      }

      <div class="card">
        <h2>Source Screenshot</h2>
        <img src="screenshot.png" style="width:100%;border-radius:4px" />
      </div>

    </div>

    <div>
      <div class="card">
        <h2>Section Shells (${crawlResult.visualArchDoc.sections.length})</h2>
        <p style="color:#6b7280;font-size:0.75rem;margin-bottom:1rem">Each shell must appear in the skeleton with <code style="color:#a5b4fc">data-section-slug</code> and <code style="color:#a5b4fc">data-section-order</code> — empty interior.</p>
        <table style="width:100%;border-collapse:collapse"><tbody>
          ${sectionRows}
        </tbody></table>
      </div>
    </div>
  </div>
</body>
</html>`;

  fs.writeFileSync(path.join(outDir, "report.html"), html);
  console.log(`[skeleton] report.html saved.`);
  console.log(`\n[skeleton] Open: ${path.join(outDir, "report.html")}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
