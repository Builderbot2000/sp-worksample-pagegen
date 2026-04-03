/**
 * Initial generation stage test script.
 *
 * Runs the full 3-stage initial generation pipeline in isolation:
 *   Stage 1 — Skeleton Agent (global elements + empty section shells)
 *   Stage 2 — Section Agents (parallel, one per section)
 *   Stage 3 — Programmatic assembly
 *
 * No fidelity loop, no patching.
 *
 * Usage:
 *   npx tsx scripts/test-generate.ts <url> [--name <label>] [--out <dir>]
 *
 * Outputs:
 *   <out>/main/<page>.html      — assembled generated page
 *   <out>/screenshot.png        — full-page source screenshot
 *   <out>/arch.json             — visual arch doc + crawl metadata
 *   <out>/sections/             — per-section source screenshots (source-<slug>.png)
 *                                 and generated screenshots (generated-<slug>.png)
 *   <out>/report.html           — per-section side-by-side comparison report
 *
 * Defaults to out = output/<timestamp>-<name|generate-test>/
 */

import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import { crawlAndPreprocess } from "../src/context";
import { renderStream } from "../src/render";
import { resizeForVlm } from "../src/image";
import {
  GENERATE_MODEL,
  formatArchDoc,
  assembleSkeleton,
  generateSection,
} from "../src/agent";
import { screenshotSectionsBySlug } from "../src/observability/fidelity";
import { estimateMaxTokens } from "../src/observability/metrics";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";

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

const client = new Anthropic();

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

async function main() {
  const runSlug = nameArg ? slugify(nameArg) : "generate-test";
  const outDir = outArg ?? path.join(path.resolve(__dirname, "../output"), `${Date.now()}-${runSlug}`);
  const mainDir = path.join(outDir, "main");
  const sectionsDir = path.join(outDir, "sections");
  fs.mkdirSync(mainDir, { recursive: true });
  fs.mkdirSync(sectionsDir, { recursive: true });

  console.log(`\n[generate] Crawling: ${urlArg}`);
  console.log(`[generate] Output:   ${outDir}\n`);

  // ── Crawl ─────────────────────────────────────────────────────────────────

  const crawlResult = await crawlAndPreprocess(urlArg!);

  fs.writeFileSync(path.join(outDir, "screenshot.png"), Buffer.from(crawlResult.screenshotBase64, "base64"));
  console.log(`[generate] Full-page screenshot saved.`);

  // Save per-section source screenshots to disk for the report
  for (const section of crawlResult.visualArchDoc.sections) {
    const bufs = crawlResult.sourceSectionScreenshots[section.slug];
    if (bufs?.[0]) {
      fs.writeFileSync(path.join(sectionsDir, `source-${section.slug}.png`), bufs[0]);
    }
  }
  console.log(`[generate] Source section screenshots saved (${crawlResult.visualArchDoc.sections.length}).`);

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

  const archDoc = crawlResult.visualArchDoc;
  const archDocText = formatArchDoc(archDoc);
  const stylesJson = JSON.stringify(crawlResult.computedStyles, null, 2);
  const fontsText = crawlResult.fontFamilies.join(", ");
  const imageUrlsText = crawlResult.imageUrls.join("\n");
  const svgsText = crawlResult.svgs.join("\n");
  const slugList = archDoc.sections.map((s) => `  ${s.order}. "${s.slug}" (${s.role})`).join("\n");

  const generateStart = Date.now();
  let skeletonTokensIn = 0;
  let skeletonTokensOut = 0;
  let sectionTokensIn = 0;
  let sectionTokensOut = 0;

  // ── Stage 1: Skeleton ─────────────────────────────────────────────────────

  console.log(`\n[generate] Stage 1 — skeleton (${GENERATE_MODEL})...`);
  let skeletonHtml: string | null = null;
  let skeletonBasename: string | null = null;

  const saveSkeletonTool = betaZodTool({
    name: "save_file",
    description: "Save the skeleton HTML to disk.",
    inputSchema: z.object({
      filename: z.string().describe("A descriptive kebab-case filename, e.g. acme-skeleton.html"),
      content: z.string().describe("The full skeleton HTML content"),
    }),
    run: async (input) => {
      const outPath = path.join(mainDir, input.filename);
      fs.writeFileSync(outPath, input.content, "utf-8");
      skeletonHtml = input.content;
      skeletonBasename = path.basename(input.filename, ".html").replace(/-skeleton$/, "");
      return JSON.stringify({ success: true, file_path: outPath });
    },
  });

  const screenshotBuf = Buffer.from(crawlResult.screenshotBase64, "base64");
  const resizedFullPage = await resizeForVlm(screenshotBuf);

  const skeletonRunner = client.beta.messages.toolRunner({
    model: GENERATE_MODEL,
    max_tokens: estimateMaxTokens(crawlResult.html.length, GENERATE_MODEL),
    thinking: { type: "disabled" },
    tools: [saveSkeletonTool],
    tool_choice: { type: "tool", name: "save_file" },
    stream: true,
    max_iterations: 1,
    system: `You are an expert front-end developer building a structural skeleton for a multi-agent page generation pipeline.

Your role is Stage 1 of a two-stage process:
- Stage 1 (YOU): Produce the structural skeleton — all global elements complete, section interiors intentionally empty.
- Stage 2 (downstream agents): Fill in each section's interior content independently and in parallel.

SKELETON CONTRACT — strictly enforced:

1. GLOBAL ELEMENTS must be fully rendered:
   - Complete <head>: charset, viewport, title, font imports, Tailwind CDN script tag
   - Tailwind config block (<script>tailwind.config = {...}</script>) with theme.extend containing CSS custom properties for brand colours, fonts, and spacing extracted from the source
   - CSS custom properties in a <style> :root block for any values that cannot be expressed as Tailwind config
   - Navigation / header element: fully rendered with real content (logo, nav links, CTA buttons)
   - All fixed/sticky elements listed in <fixed_elements_html>: use their structure and content as reference, but rewrite using Tailwind utility classes — do not copy source-site class names verbatim as they belong to a different CSS system
   - Page-level layout wrappers (<main>, outer container divs) with correct spacing and background

2. SECTION SHELLS must be empty:
   - One shell element per section listed in the visual architecture spec
   - Each shell's outermost element MUST carry exactly:
       data-section-slug="<slug>"   — verbatim from the spec
       data-section-order="<N>"     — integer 1-based order from the spec
   - Shell interior must contain NO content — no headings, paragraphs, images, or buttons
   - Shell elements must have appropriate semantic tag (section, article, div) and any outer layout classes (e.g. bg-*, py-*) inferred from the source, but nothing inside

3. OUTPUT is a complete, valid, self-contained HTML file using Tailwind CSS via CDN.`,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: "image/jpeg", data: resizedFullPage.toString("base64") },
          },
          {
            type: "text",
            text: `The image above is a screenshot of the source page at ${urlArg}. Use it as a visual reference for global styles, colour palette, typography, and overall layout structure.

Your task is to generate the SKELETON HTML for this page. The skeleton must include all global elements (head, fonts, CSS variables, Tailwind theme config, nav) fully rendered, with one empty shell element for each section listed below. Section shells must be empty — downstream agents will fill in the content.

SECTION SLUGS (one empty shell required for each, in this order):
${slugList}

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

<fixed_elements_html>
${crawlResult.fixedElementsHtml.join("\n\n")}
</fixed_elements_html>

<source_html>
${crawlResult.html}
</source_html>

Produce the skeleton HTML now. Every section shell must have data-section-slug and data-section-order attributes. Section interiors must be completely empty.`,
          },
        ],
      },
    ],
  });

  ({ tokensIn: skeletonTokensIn, tokensOut: skeletonTokensOut } = await renderStream(skeletonRunner));
  console.log(`[generate] Skeleton done — ${skeletonTokensIn} in / ${skeletonTokensOut} out tokens`);

  // ── Stage 2: Section Agents (parallel) ────────────────────────────────────

  const sectionResults: { slug: string; fragment: string; tokensIn: number; tokensOut: number }[] = [];

  if (skeletonHtml) {
    console.log(`\n[generate] Stage 2 — ${archDoc.sections.length} section agents (parallel)...`);
    const results = await Promise.all(
      archDoc.sections.map((section, i) =>
        generateSection(
          section,
          { prev: archDoc.sections[i - 1]?.slug, next: archDoc.sections[i + 1]?.slug },
          crawlResult.sourceSectionScreenshots[section.slug] ?? [],
          crawlResult.computedStyles,
          crawlResult.fontFamilies,
          crawlResult.imageUrls,
          urlArg!,
        ),
      ),
    );
    for (const r of results) {
      sectionResults.push(r);
      sectionTokensIn += r.tokensIn;
      sectionTokensOut += r.tokensOut;
    }
    console.log(`[generate] Sections done — ${sectionTokensIn} in / ${sectionTokensOut} out tokens`);

    // ── Stage 3: Assembly ────────────────────────────────────────────────────

    console.log(`\n[generate] Stage 3 — assembling...`);
    const assembledHtml = assembleSkeleton(skeletonHtml, sectionResults);
    const assembledFilename = `${skeletonBasename ?? "page"}.html`;
    const assembledPath = path.join(mainDir, assembledFilename);
    fs.writeFileSync(assembledPath, assembledHtml, "utf-8");
    console.log(`[generate] Assembled — ${assembledPath}`);

    // ── Screenshot generated sections ────────────────────────────────────────

    console.log(`\n[generate] Screenshotting generated sections...`);
    const generatedSectionScreenshots = await screenshotSectionsBySlug(
      { file: assembledPath },
      archDoc,
    );
    for (const [slug, bufs] of Object.entries(generatedSectionScreenshots)) {
      if (bufs[0]) {
        fs.writeFileSync(path.join(sectionsDir, `generated-${slug}.png`), bufs[0]);
      }
    }
    console.log(`[generate] Generated section screenshots saved.`);
  }

  const totalDurationMs = Date.now() - generateStart;
  const totalTokensIn = skeletonTokensIn + sectionTokensIn;
  const totalTokensOut = skeletonTokensOut + sectionTokensOut;

  console.log(`\n[generate] Done in ${(totalDurationMs / 1000).toFixed(1)}s — ${totalTokensIn} in / ${totalTokensOut} out tokens total`);

  // ── Report ────────────────────────────────────────────────────────────────

  const assembledRelPath = (() => {
    const p = path.join(mainDir, `${skeletonBasename ?? "page"}.html`);
    return fs.existsSync(p) ? path.relative(outDir, p) : null;
  })();

  const metaRows: [string, string][] = [
    ["URL", urlArg!],
    ["Model", GENERATE_MODEL],
    ["Skeleton tokens in", skeletonTokensIn.toLocaleString()],
    ["Skeleton tokens out", skeletonTokensOut.toLocaleString()],
    ["Section tokens in", sectionTokensIn.toLocaleString()],
    ["Section tokens out", sectionTokensOut.toLocaleString()],
    ["Duration", `${(totalDurationMs / 1000).toFixed(1)}s`],
    ["HTML size", `${(crawlResult.html.length / 1024).toFixed(1)} KB${crawlResult.truncated ? " (truncated)" : ""}`],
    ["Sections", String(archDoc.sections.length)],
  ];

  const sectionCards = archDoc.sections.map((s) => {
    const sourceImg = path.join(sectionsDir, `source-${s.slug}.png`);
    const generatedImg = path.join(sectionsDir, `generated-${s.slug}.png`);
    const sourceRelPath = fs.existsSync(sourceImg)
      ? path.relative(outDir, sourceImg)
      : null;
    const generatedRelPath = fs.existsSync(generatedImg)
      ? path.relative(outDir, generatedImg)
      : null;
    const sectionResult = sectionResults.find((r) => r.slug === s.slug);

    return `<div class="section-card">
  <div class="section-header">
    <span class="section-slug">${escHtml(s.slug)}</span>
    <span class="section-role">${escHtml(s.role)}</span>
    <span class="section-desc">${escHtml(s.description)}</span>
    ${sectionResult ? `<span class="section-tokens">${(sectionResult.tokensIn + sectionResult.tokensOut).toLocaleString()} tokens</span>` : ""}
  </div>
  <div class="section-screenshots">
    <div class="screenshot-col">
      <div class="screenshot-label">Source</div>
      ${sourceRelPath ? `<img src="${escHtml(sourceRelPath)}" />` : `<div class="screenshot-missing">No source screenshot</div>`}
    </div>
    <div class="screenshot-col">
      <div class="screenshot-label">Generated</div>
      ${generatedRelPath ? `<img src="${escHtml(generatedRelPath)}" />` : `<div class="screenshot-missing">No generated screenshot</div>`}
    </div>
  </div>
</div>`;
  }).join("\n");

  const reportHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Generate Test — ${escHtml(urlArg!)}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #111827; color: #e5e7eb; padding: 2rem; line-height: 1.5; }
    h1 { font-size: 1.1rem; font-weight: 700; color: #f9fafb; margin-bottom: 0.25rem; }
    h2 { font-size: 0.85rem; font-weight: 600; color: #9ca3af; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 1rem; }
    .layout { display: grid; grid-template-columns: 280px 1fr; gap: 2rem; align-items: start; }
    .sidebar > * + * { margin-top: 1.5rem; }
    .card { background: #1f2937; border-radius: 8px; padding: 1.25rem; }
    a { color: #60a5fa; }
    .badge { display: inline-block; padding: 0.15rem 0.5rem; border-radius: 3px; font-size: 0.7rem; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; background: #1e3a5f; color: #93c5fd; }
    /* Section cards */
    .section-card { background: #1f2937; border-radius: 8px; padding: 1.25rem; margin-bottom: 1.5rem; }
    .section-header { display: flex; align-items: baseline; gap: 0.75rem; margin-bottom: 1rem; flex-wrap: wrap; }
    .section-slug { font-family: monospace; font-size: 0.9rem; color: #60a5fa; font-weight: 600; }
    .section-role { font-size: 0.7rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; background: #374151; color: #d1d5db; padding: 0.15rem 0.5rem; border-radius: 3px; }
    .section-desc { font-size: 0.8rem; color: #9ca3af; flex: 1; }
    .section-tokens { font-size: 0.75rem; color: #6b7280; white-space: nowrap; }
    .section-screenshots { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
    .screenshot-col { display: flex; flex-direction: column; gap: 0.5rem; }
    .screenshot-label { font-size: 0.7rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: #6b7280; }
    .screenshot-col img { width: 100%; border-radius: 4px; border: 1px solid #374151; display: block; }
    .screenshot-missing { font-size: 0.8rem; color: #6b7280; padding: 1rem; background: #111827; border-radius: 4px; text-align: center; }
  </style>
</head>
<body>
  <div style="margin-bottom:1.5rem;display:flex;align-items:baseline;gap:0.75rem">
    <h1>${nameArg ? escHtml(nameArg) : "Generate Test"}</h1>
    <span class="badge">3-Stage Pipeline</span>
  </div>
  <p style="color:#9ca3af;font-size:0.85rem;margin-top:-0.75rem;margin-bottom:1.5rem">${escHtml(urlArg!)}</p>

  <div class="layout">
    <div class="sidebar">
      <div class="card">
        <h2>Run Metadata</h2>
        <table><tbody>
          ${metaRows.map(([k, v]) => `<tr><td style="padding:0.3rem 0.75rem 0.3rem 0;color:#9ca3af;font-size:0.8rem;white-space:nowrap">${escHtml(k)}</td><td style="padding:0.3rem 0;font-size:0.8rem;color:#d1d5db;word-break:break-all">${escHtml(v)}</td></tr>`).join("\n          ")}
        </tbody></table>
      </div>

      ${assembledRelPath
        ? `<div class="card"><h2>Generated Page</h2><a href="${escHtml(assembledRelPath)}" style="font-size:0.85rem">${escHtml(path.basename(assembledRelPath))}</a></div>`
        : `<div class="card"><p style="color:#f87171;font-size:0.85rem">Assembly did not produce output.</p></div>`}

      <div class="card">
        <h2>Source Screenshot</h2>
        <img src="screenshot.png" style="width:100%;border-radius:4px" />
      </div>
    </div>

    <div>
      <h2 style="margin-bottom:1rem">Section Comparison (${archDoc.sections.length})</h2>
      ${sectionCards || `<div class="card"><p style="color:#6b7280;font-size:0.85rem">No sections.</p></div>`}
    </div>
  </div>
</body>
</html>`;

  fs.writeFileSync(path.join(outDir, "report.html"), reportHtml);
  console.log(`[generate] report.html saved.`);
  console.log(`\n[generate] Open: ${path.join(outDir, "report.html")}\n`);
}

main().catch((err) => { console.error(err); process.exit(1); });
