/**
 * Preprocessing layer test script.
 *
 * Usage:
 *   npx tsx scripts/test-preprocess.ts <url> [--name <label>] [--out <dir>]
 *
 * Runs crawlAndPreprocess() in isolation and writes:
 *   <out>/arch.json          — full CrawlResult (sans screenshot buffers)
 *   <out>/screenshot.png     — full-page screenshot
 *   <out>/sections/<slug>-0.png  — per-section screenshots (stitched for tall sections)
 *   <out>/report.html        — visual HTML report
 *
 * Defaults to out = output/<timestamp>-<name|preprocess-test>/
 */

import * as fs from "fs";
import * as path from "path";
import { crawlAndPreprocess } from "../src/context";
import { escHtml } from "../src/utils";

// ── Parse args ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const urlArg = args.find((a) => !a.startsWith("--"));
const outIndex = args.indexOf("--out");
const outArg = outIndex !== -1 ? args[outIndex + 1] : undefined;
const nameIndex = args.indexOf("--name");
const nameArg = nameIndex !== -1 ? args[nameIndex + 1] : undefined;

if (!urlArg) {
  console.error("Usage: npx tsx scripts/test-preprocess.ts <url> [--name <label>] [--out <dir>]");
  process.exit(1);
}

async function main() {
const slug = nameArg
  ? nameArg.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
  : "preprocess-test";
const outDir = outArg ?? path.join(path.resolve(__dirname, "../output"), `${Date.now()}-${slug}`);
fs.mkdirSync(path.join(outDir, "sections"), { recursive: true });

// ── Run ───────────────────────────────────────────────────────────────────────

console.log(`\n[preprocess] Crawling: ${urlArg}`);
console.log(`[preprocess] Output:   ${outDir}\n`);

const result = await crawlAndPreprocess(urlArg!);

// ── Save full-page screenshot ─────────────────────────────────────────────────

fs.writeFileSync(
  path.join(outDir, "screenshot.png"),
  Buffer.from(result.screenshotBase64, "base64"),
);
console.log(`[preprocess] Full-page screenshot saved.`);

// ── Save section screenshots ──────────────────────────────────────────────────

for (const [slug, bufs] of Object.entries(result.sourceSectionScreenshots)) {
  bufs.forEach((buf, idx) => {
    const file = path.join(outDir, "sections", `${slug}-${idx}.png`);
    fs.writeFileSync(file, buf);
  });
}
const sectionCount = result.visualArchDoc.sections.length;
console.log(`[preprocess] ${sectionCount} sections, ${Object.values(result.sourceSectionScreenshots).flat().length} section screenshots saved.`);

// ── Save arch.json ────────────────────────────────────────────────────────────

const archJson = {
  visualArchDoc: result.visualArchDoc,
  scrollHeight: result.scrollHeight,
  truncated: result.truncated,
  htmlBytes: result.html.length,
  imageUrls: result.imageUrls,
  fontFamilies: result.fontFamilies,
  computedStyles: result.computedStyles,
  svgCount: result.svgs.length,
};
fs.writeFileSync(path.join(outDir, "arch.json"), JSON.stringify(archJson, null, 2));
console.log(`[preprocess] arch.json saved.`);

// ── Build HTML report ─────────────────────────────────────────────────────────

function sectionCards(): string {
  return result.visualArchDoc.sections
    .map((sec) => {
      const screenshots = result.sourceSectionScreenshots[sec.slug] ?? [];
      const imgs = screenshots
        .map((_, idx) => {
          const relPath = `sections/${sec.slug}-${idx}.png`;
          return `<img src="${escHtml(relPath)}" style="width:100%;border-radius:4px;display:block;margin-bottom:0.5rem" />`;
        })
        .join("");

      return `
      <div style="background:#1f2937;border-radius:8px;overflow:hidden">
        <div style="padding:0.75rem 1rem;border-bottom:1px solid #374151;display:flex;gap:1rem;align-items:baseline">
          <span style="font-family:monospace;font-size:0.8rem;color:#60a5fa;font-weight:600">${escHtml(sec.slug)}</span>
          <span style="font-size:0.7rem;background:#374151;color:#d1d5db;padding:0.1rem 0.4rem;border-radius:3px">${escHtml(sec.role)}</span>
          <span style="font-size:0.7rem;color:#9ca3af;margin-left:auto">order ${sec.order}</span>
        </div>
        <div style="padding:0.75rem 1rem">
          <p style="font-size:0.8rem;color:#d1d5db;margin:0 0 0.75rem">${escHtml(sec.description)}</p>
          ${imgs}
        </div>
      </div>`;
    })
    .join("\n");
}

function fixedElementRows(): string {
  if (result.visualArchDoc.fixedElements.length === 0) {
    return `<tr><td colspan="1" style="color:#6b7280;font-style:italic;padding:0.4rem 0">none detected</td></tr>`;
  }
  return result.visualArchDoc.fixedElements
    .map((fe) => `<tr><td style="padding:0.3rem 0;font-size:0.8rem;color:#d1d5db;font-family:monospace">${escHtml(fe)}</td></tr>`)
    .join("");
}

function metaRows(): string {
  const rows: [string, string][] = [
    ["URL", urlArg!],
    ["Scroll height", `${result.scrollHeight}px`],
    ["HTML", `${(result.html.length / 1024).toFixed(1)} KB${result.truncated ? " (truncated)" : ""}`],
    ["Images", String(result.imageUrls.length)],
    ["Fonts", result.fontFamilies.join(", ") || "—"],
    ["SVGs", String(result.svgs.length)],
    ["Sections detected", String(sectionCount)],
  ];
  return rows
    .map(
      ([k, v]) =>
        `<tr><td style="padding:0.3rem 0.75rem 0.3rem 0;color:#9ca3af;font-size:0.8rem;white-space:nowrap">${escHtml(k)}</td><td style="padding:0.3rem 0;font-size:0.8rem;color:#d1d5db;word-break:break-all">${escHtml(v)}</td></tr>`,
    )
    .join("");
}

const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Preprocess Test — ${escHtml(urlArg!)}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #111827; color: #e5e7eb; padding: 2rem; line-height: 1.5; }
    h1 { font-size: 1.1rem; font-weight: 700; color: #f9fafb; margin-bottom: 0.25rem; }
    h2 { font-size: 0.85rem; font-weight: 600; color: #9ca3af; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 1rem; }
    .grid { display: grid; grid-template-columns: 340px 1fr; gap: 2rem; align-items: start; }
    .sidebar > * + * { margin-top: 1.5rem; }
    .card { background: #1f2937; border-radius: 8px; padding: 1.25rem; }
    .sections-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 1rem; }
  </style>
</head>
<body>
  <div style="margin-bottom:1.5rem">
    <h1>${nameArg ? escHtml(nameArg) : "Preprocessing Test"}</h1>
    <p style="color:#9ca3af;font-size:0.85rem;margin-top:0.25rem">${escHtml(urlArg!)}</p>
  </div>

  <div class="grid">
    <div class="sidebar">

      <div class="card">
        <h2>Crawl Metadata</h2>
        <table><tbody>${metaRows()}</tbody></table>
      </div>

      <div class="card">
        <h2>Fixed / Sticky Elements</h2>
        <table><tbody>${fixedElementRows()}</tbody></table>
      </div>

      <div class="card">
        <h2>Full-page Screenshot</h2>
        <img src="screenshot.png" style="width:100%;border-radius:4px" />
      </div>

    </div>

    <div>
      <h2>Sections (${sectionCount})</h2>
      <div class="sections-grid">
        ${sectionCards()}
      </div>
    </div>
  </div>
</body>
</html>`;

fs.writeFileSync(path.join(outDir, "report.html"), html);
console.log(`[preprocess] report.html saved.`);
console.log(`\n[preprocess] Done. Open: ${path.join(outDir, "report.html")}\n`);
}

main().catch((err) => { console.error(err); process.exit(1); });
