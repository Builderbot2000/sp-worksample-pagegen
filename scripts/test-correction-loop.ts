/**
 * Correction loop test script.
 *
 * Usage:
 *   npx tsx scripts/test-correction-loop.ts <url> [--name <label>] [--out <dir>] [--max-iter <n>]
 *
 * Crawls <url>, runs the initial generation, then executes up to --max-iter
 * correction iterations (default 4). Writes report.html that shows, for each
 * iteration:
 *   - Aggregate score and section match stats
 *   - Per-section source vs generated screenshot pairs
 *   - Discrepancies found (with NEW / PERSISTS labels from iter 2 onward)
 *   - Sections resolved since the previous iteration
 *
 * Output directory: output/<timestamp>-<name|correction-loop-test>/
 */

import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { crawlAndPreprocess } from "../src/context";
import { renderStream } from "../src/render";
import {
  screenshotSectionsBySlug,
  computeSectionDiscrepancies,
  scoreSeverity,
} from "../src/observability/fidelity";
import { estimateMaxTokens } from "../src/observability/metrics";
import type { VisualArchDoc, SectionDiscrepancy } from "../src/observability/types";

// ── Constants ─────────────────────────────────────────────────────────────────

import { MODELS } from "../src/config";

const GENERATE_MODEL = MODELS.sectionInitial;
const FIX_MODEL = MODELS.sectionCorrection;
const client = new Anthropic();

// ── Args ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const urlArg = args.find((a) => !a.startsWith("--"));

function getFlag(flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : undefined;
}

const maxIter = parseInt(getFlag("--max-iter") ?? "4", 10);
const nameArg = getFlag("--name");
const outArg = getFlag("--out");

if (!urlArg) {
  console.error(
    "Usage: npx tsx scripts/test-correction-loop.ts <url> [--name <label>] [--out <dir>] [--max-iter <n>]",
  );
  process.exit(1);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatArchDoc(archDoc: VisualArchDoc): string {
  const sectionsText = archDoc.sections
    .map((s) => `  ${s.order}. slug: "${s.slug}" | role: ${s.role}\n     ${s.description}`)
    .join("\n");
  const fixedText =
    archDoc.fixedElements.length > 0 ? archDoc.fixedElements.join("; ") : "None";
  return `Background: ${archDoc.backgroundDescription}\nFixed/sticky elements: ${fixedText}\nSections (in visual order):\n${sectionsText}`;
}

// ── Per-iteration record ──────────────────────────────────────────────────────

interface IterData {
  iteration: number;
  aggregateScore: number;
  severity: string;
  matched: number;
  unmatched: number;
  discrepancies: SectionDiscrepancy[];
  sourceScreenshots: Record<string, string>; // slug → base64
  genScreenshots: Record<string, string>;    // slug → base64
}

// ── Report builder ────────────────────────────────────────────────────────────

function severityColor(s: string): string {
  if (s === "low") return "#22c55e";
  if (s === "medium") return "#f59e0b";
  return "#ef4444";
}

function scoreBar(score: number): string {
  const pct = Math.round(score * 100);
  const color = score > 0.85 ? "#22c55e" : score >= 0.6 ? "#f59e0b" : "#ef4444";
  return `<div style="display:flex;align-items:center;gap:8px">
    <div style="flex:1;height:6px;background:#374151;border-radius:3px;overflow:hidden">
      <div style="width:${pct}%;height:100%;background:${color};border-radius:3px"></div>
    </div>
    <span style="color:${color};font-weight:700;font-size:0.9rem;min-width:3ch">${pct}%</span>
  </div>`;
}

function buildReport(url: string, iters: IterData[], archDoc: VisualArchDoc): string {
  const iterCards = iters
    .map((iter, idx) => {
      const prev = idx > 0 ? iters[idx - 1] : null;

      // Map prev discrepancy issues by slug
      const prevIssueSets = new Map<string, Set<string>>();
      const prevDiscSlugs = new Set<string>();
      if (prev) {
        for (const d of prev.discrepancies) {
          prevDiscSlugs.add(d.slug);
          prevIssueSets.set(d.slug, new Set(d.issues));
        }
      }

      const currDiscMap = new Map(iter.discrepancies.map((d) => [d.slug, d]));

      // Resolved = had discrepancies in previous iter, none in current
      const resolvedSlugs = idx > 0
        ? [...prevDiscSlugs].filter((slug) => !currDiscMap.has(slug))
        : [];

      // Interesting = has current discrepancies or was resolved from previous
      const interestingSlugs = new Set([
        ...iter.discrepancies.map((d) => d.slug),
        ...resolvedSlugs,
      ]);

      const passingSlugs = archDoc.sections
        .map((s) => s.slug)
        .filter((slug) => !interestingSlugs.has(slug));

      const sectionCards = archDoc.sections
        .filter((s) => interestingSlugs.has(s.slug))
        .map((s) => {
          const srcB64 = iter.sourceScreenshots[s.slug] ?? "";
          const genB64 = iter.genScreenshots[s.slug] ?? "";
          const disc = currDiscMap.get(s.slug);
          const isResolved = resolvedSlugs.includes(s.slug);
          const wasPrev = prevDiscSlugs.has(s.slug);

          let statusBadge = "";
          let issuesHtml = "";

          if (isResolved) {
            statusBadge = `<span style="background:#064e3b;color:#6ee7b7;padding:2px 8px;border-radius:4px;font-size:0.7rem;font-weight:700">✓ RESOLVED</span>`;
            issuesHtml = `<p style="color:#6ee7b7;font-size:0.8rem;margin:0;padding:0 12px 12px">All issues from the previous iteration were resolved.</p>`;
          } else if (disc) {
            const statusColor = disc.severity === "high" ? "#fca5a5" : "#fcd34d";
            const statusBg = disc.severity === "high" ? "#7f1d1d" : "#451a03";
            const changeTag = wasPrev
              ? `<span style="background:#451a03;color:#fcd34d;padding:2px 6px;border-radius:4px;font-size:0.7rem;font-weight:700;margin-left:6px">PERSISTS</span>`
              : `<span style="background:#7f1d1d;color:#fca5a5;padding:2px 6px;border-radius:4px;font-size:0.7rem;font-weight:700;margin-left:6px">NEW</span>`;
            statusBadge = `<span style="background:${statusBg};color:${statusColor};padding:2px 8px;border-radius:4px;font-size:0.7rem;font-weight:700">${disc.severity.toUpperCase()}</span>${changeTag}`;

            const prevIssues = prevIssueSets.get(s.slug) ?? new Set<string>();
            const issueItems = disc.issues
              .map((issue) => {
                const isCarried = prevIssues.has(issue);
                const dot = isCarried
                  ? `<span style="color:#f59e0b" title="carried over from previous iteration">●</span>`
                  : `<span style="color:#ef4444" title="new this iteration">●</span>`;
                return `<li style="display:flex;gap:6px;align-items:baseline;color:#d1d5db;font-size:0.8rem;margin-bottom:3px">${dot} ${esc(issue)}</li>`;
              })
              .join("");
            issuesHtml = `<div style="padding:0 12px 12px"><ul style="margin:0;padding:0;list-style:none">${issueItems}</ul></div>`;
          }

          const makeImg = (b64: string, label: string) =>
            b64
              ? `<img src="data:image/png;base64,${b64}" style="width:100%;display:block;border-radius:4px">`
              : `<div style="width:100%;height:100px;background:#374151;border-radius:4px;display:flex;align-items:center;justify-content:center;color:#6b7280;font-size:0.75rem">${esc(label)}</div>`;

          return `
<div style="border:1px solid #374151;border-radius:8px;overflow:hidden;margin-bottom:12px">
  <div style="background:#1f2937;padding:10px 14px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">
    <code style="color:#60a5fa;font-size:0.8rem">${esc(s.slug)}</code>
    <span style="background:#374151;color:#9ca3af;padding:1px 6px;border-radius:3px;font-size:0.7rem">${esc(s.role)}</span>
    <div style="flex:1"></div>
    ${statusBadge}
  </div>
  <div style="padding:12px;display:grid;grid-template-columns:1fr 1fr;gap:10px">
    <div>
      <div style="color:#6b7280;font-size:0.65rem;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:4px">Source</div>
      ${makeImg(srcB64, "No screenshot")}
    </div>
    <div>
      <div style="color:#6b7280;font-size:0.65rem;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:4px">Generated</div>
      ${makeImg(genB64, "Section missing")}
    </div>
  </div>
  ${issuesHtml}
</div>`;
        })
        .join("\n");

      const resolvedNote =
        resolvedSlugs.length > 0
          ? `<span style="background:#064e3b;color:#6ee7b7;padding:2px 8px;border-radius:4px;font-size:0.75rem;font-weight:700">↑ ${resolvedSlugs.length} resolved</span>`
          : "";

      const passingNote =
        passingSlugs.length > 0
          ? `<details style="margin-top:8px">
          <summary style="color:#6b7280;font-size:0.8rem;cursor:pointer;user-select:none">${passingSlugs.length} passing section${passingSlugs.length !== 1 ? "s" : ""}</summary>
          <div style="padding-top:8px;display:flex;flex-wrap:wrap;gap:6px">
            ${passingSlugs.map((slug) => `<code style="background:#1f2937;color:#34d399;padding:2px 8px;border-radius:4px;font-size:0.75rem">${esc(slug)}</code>`).join("")}
          </div>
        </details>`
          : "";

      const color = severityColor(iter.severity);

      return `
<section style="background:#111827;border:1px solid #1f2937;border-radius:12px;padding:20px;margin-bottom:24px">
  <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px;flex-wrap:wrap">
    <h2 style="margin:0;font-size:1rem;color:#f9fafb;font-weight:700">Iteration ${iter.iteration}</h2>
    <span style="font-size:1.2rem;font-weight:800;color:${color}">${(iter.aggregateScore * 100).toFixed(1)}%</span>
    <span style="background:${color}22;color:${color};padding:2px 8px;border-radius:4px;font-size:0.75rem;font-weight:700;text-transform:uppercase">${iter.severity}</span>
    <span style="color:#9ca3af;font-size:0.8rem">${iter.matched}/${iter.matched + iter.unmatched} matched</span>
    <span style="color:#9ca3af;font-size:0.8rem">·</span>
    <span style="color:#9ca3af;font-size:0.8rem">${iter.discrepancies.length} discrepanc${iter.discrepancies.length !== 1 ? "ies" : "y"}</span>
    ${resolvedNote}
  </div>
  ${scoreBar(iter.aggregateScore)}
  <div style="margin-top:16px">
    ${
      sectionCards ||
      `<p style="color:#6ee7b7;font-size:0.85rem;margin:0">✓ No discrepancies — all sections look good.</p>`
    }
  </div>
  ${passingNote}
</section>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Correction Loop Report</title>
<style>
  * { box-sizing: border-box; }
  body { background:#0d1117; color:#e5e7eb; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; margin:0; padding:24px; }
  details summary::-webkit-details-marker { display:none; }
  img { max-width:100%; }
</style>
</head>
<body>
<div style="max-width:1100px;margin:0 auto">
  <header style="margin-bottom:32px">
    <h1 style="font-size:1.5rem;font-weight:800;color:#f9fafb;margin:0 0 8px">Correction Loop Report</h1>
    <p style="margin:0;color:#60a5fa;font-size:0.85rem">${esc(url)}</p>
    <p style="margin:4px 0 0;color:#6b7280;font-size:0.8rem">${new Date().toLocaleString()} · ${iters.length} iteration${iters.length !== 1 ? "s" : ""} · ${archDoc.sections.length} sections</p>
  </header>
  ${iterCards}
</div>
</body>
</html>`;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const runSlug = nameArg ? slugify(nameArg) : "correction-loop-test";
  const outDir =
    outArg ??
    path.join(path.resolve(__dirname, "../output"), `${Date.now()}-${runSlug}`);
  const mainDir = path.join(outDir, "main");
  fs.mkdirSync(mainDir, { recursive: true });

  console.log(`\n[correction-loop] Crawling: ${urlArg}`);
  console.log(`[correction-loop] Output:   ${outDir}\n`);

  // ── Crawl ─────────────────────────────────────────────────────────────────

  const crawlResult = await crawlAndPreprocess(urlArg!);
  const archDoc = crawlResult.visualArchDoc;

  console.log(`[correction-loop] ${archDoc.sections.length} sections detected.`);

  // ── Initial generation ────────────────────────────────────────────────────

  const archDocText = formatArchDoc(archDoc);
  const stylesJson = JSON.stringify(crawlResult.computedStyles, null, 2);
  const fontsText = crawlResult.fontFamilies.join(", ");
  const imageUrlsText = crawlResult.imageUrls.join("\n");
  const svgsText = crawlResult.svgs.join("\n");

  let savedPath: string | null = null;

  const saveFile = betaZodTool({
    name: "save_file",
    description:
      "Save the generated HTML page to disk. Call this once with the complete HTML content.",
    inputSchema: z.object({
      filename: z
        .string()
        .describe("A descriptive kebab-case filename, e.g. acme-landing-page.html"),
      content: z.string().describe("The full HTML content of the page"),
    }),
    run: async (input) => {
      const outPath = path.join(mainDir, input.filename);
      fs.writeFileSync(outPath, input.content, "utf-8");
      savedPath = outPath;
      return JSON.stringify({ success: true, file_path: outPath });
    },
  });

  console.log(`[correction-loop] Initial generation with ${GENERATE_MODEL}...`);
  const genStart = Date.now();

  const genRunner = client.beta.messages.toolRunner({
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
            type: "text",
            text: `Create a single-file HTML page that recreates the source page at ${urlArg} using Tailwind CSS (via CDN script tag).

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

  await renderStream(genRunner);
  console.log(
    `\n[correction-loop] Initial generation done in ${((Date.now() - genStart) / 1000).toFixed(1)}s`,
  );

  if (!savedPath) {
    console.error("[correction-loop] Model did not call save_file — aborting.");
    process.exit(1);
  }

  // ── Correction loop ───────────────────────────────────────────────────────

  const iterResults: IterData[] = [];

  for (let i = 0; i < maxIter; i++) {
    console.log(
      `\n[correction-loop] Iteration ${i + 1}/${maxIter} — scoring sections...`,
    );

    const genSections = await screenshotSectionsBySlug({ file: savedPath! }, archDoc);
    const { discrepancies, matched, unmatched, aggregateScore } =
      await computeSectionDiscrepancies(
        crawlResult.sourceSectionScreenshots,
        genSections,
        archDoc,
        { maxTokens: 1024 },
      );
    const severity = scoreSeverity(aggregateScore);

    // Capture screenshots for report
    const sourceScreenshots: Record<string, string> = {};
    const genScreenshots: Record<string, string> = {};
    for (const sec of archDoc.sections) {
      if (crawlResult.sourceSectionScreenshots[sec.slug]?.[0]) {
        sourceScreenshots[sec.slug] =
          crawlResult.sourceSectionScreenshots[sec.slug][0].toString("base64");
      }
      if (genSections[sec.slug]?.[0]) {
        genScreenshots[sec.slug] = genSections[sec.slug][0].toString("base64");
      }
    }

    iterResults.push({
      iteration: i + 1,
      aggregateScore,
      severity,
      matched,
      unmatched,
      discrepancies,
      sourceScreenshots,
      genScreenshots,
    });

    console.log(
      `[correction-loop] score: ${aggregateScore.toFixed(3)} (${severity}) | ${matched}/${matched + unmatched} matched | ${discrepancies.length} discrepanc${discrepancies.length !== 1 ? "ies" : "y"}`,
    );

    if (discrepancies.length === 0) {
      console.log("[correction-loop] Converged — no discrepancies.");
      break;
    }

    // No fix pass after the final iteration
    if (i === maxIter - 1) break;

    // ── Fix pass ──────────────────────────────────────────────────────────

    const currentHtml = fs.readFileSync(savedPath!, "utf-8");
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

    console.log(`[correction-loop] Fix pass with ${FIX_MODEL}...`);

    const fixRunner = client.beta.messages.toolRunner({
      model: FIX_MODEL,
      max_tokens: estimateMaxTokens(currentHtml.length, FIX_MODEL),
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
              source: {
                type: "base64",
                media_type: "image/png",
                data: crawlResult.screenshotBase64,
              },
            },
            {
              type: "text",
              text: `SOURCE page above.\n\n<visual_architecture>\n${archDocText}\n</visual_architecture>\n\n<discrepancies>\n${discrepancyList}\n</discrepancies>\n\nRewrite the complete HTML fixing the listed discrepancies. Each section root MUST keep its data-section-slug and data-section-order attributes.\n\n<current_html>\n${currentHtml}\n</current_html>`,
            },
          ],
        },
      ],
    });

    await renderStream(fixRunner);

    if (!savedPath) {
      console.warn("[correction-loop] Fix pass did not save — stopping loop.");
      break;
    }
  }

  // ── Report ─────────────────────────────────────────────────────────────────

  const report = buildReport(urlArg!, iterResults, archDoc);
  const reportPath = path.join(outDir, "report.html");
  fs.writeFileSync(reportPath, report, "utf-8");
  console.log(`\n[correction-loop] Report: ${reportPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
