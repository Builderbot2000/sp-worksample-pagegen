import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import { preprocessPage } from "../src/preprocess";
import type { SectionSpec } from "../src/preprocess";

// ─── Args ─────────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0].startsWith("--")) {
    console.error("Usage: tsx scripts/test-preprocess.ts <url> [--name <label>]");
    process.exit(1);
  }
  const url = args[0];
  let name: string | undefined;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--name" && args[i + 1]) {
      name = args[i + 1];
    }
  }
  return { url, name };
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

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ─── Report builder ───────────────────────────────────────────────────────────

function buildReport(
  url: string,
  sections: SectionSpec[],
  sectionScreenshots: Record<string, Buffer[]>,
  skeletonHtml: string,
): string {
  // Section list rows
  const sectionRows = sections
    .map((s) => {
      const crops = sectionScreenshots[s.slug] ?? [];
      const imgs = crops
        .map(
          (buf, idx) =>
            `<img src="data:image/png;base64,${buf.toString("base64")}"
              alt="${escapeHtml(s.slug)}-${idx}"
              style="max-width:100%;border:1px solid #e5e7eb;border-radius:4px;display:block;" />`,
        )
        .join("<div style='height:6px'></div>");

      return `
        <div style="display:grid;grid-template-columns:220px 1fr;gap:16px;padding:16px 0;border-bottom:1px solid #f3f4f6;">
          <div>
            <div style="font:bold 14px/1.4 monospace;color:#111;">${escapeHtml(s.slug)}</div>
            <div style="font:12px/1.6 sans-serif;color:#6b7280;margin-top:4px;">
              role: <strong>${escapeHtml(s.role)}</strong><br>
              order: ${s.order}<br>
              y: ${s.y}px &nbsp;h: ${s.height}px
            </div>
          </div>
          <div>${imgs || "<em style='color:#9ca3af;font-size:12px;'>no screenshot</em>"}</div>
        </div>`;
    })
    .join("");

  // Escape skeleton HTML for srcdoc attribute
  const srcdoc = skeletonHtml
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Preprocess report — ${escapeHtml(url)}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; background: #f9fafb; color: #111; }
    .page { max-width: 1400px; margin: 0 auto; padding: 32px 24px; }
    h1 { font-size: 18px; font-weight: 700; margin-bottom: 4px; }
    .meta { font-size: 13px; color: #6b7280; margin-bottom: 32px; }
    h2 { font-size: 15px; font-weight: 600; margin-bottom: 16px; color: #374151; border-bottom: 2px solid #e5e7eb; padding-bottom: 8px; }
    .panel { background: #fff; border: 1px solid #e5e7eb; border-radius: 8px; padding: 24px; margin-bottom: 32px; }
    iframe { width: 100%; border: none; border-radius: 4px; background: #fff; }
  </style>
</head>
<body>
  <div class="page">
    <h1>Preprocess Report</h1>
    <p class="meta">URL: ${escapeHtml(url)} &nbsp;·&nbsp; ${sections.length} sections detected</p>

    <div class="panel">
      <h2>Skeleton Preview</h2>
      <iframe srcdoc="${srcdoc}" height="900" sandbox="allow-same-origin"></iframe>
    </div>

    <div class="panel">
      <h2>Detected Sections</h2>
      ${sectionRows || "<p style='color:#9ca3af;font-size:13px;'>No sections detected.</p>"}
    </div>
  </div>
</body>
</html>`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const { url, name } = parseArgs();

  const ts = Date.now();
  const label = name ? slugify(name) : urlSlug(url);
  const runId = `${ts}-${label}-preprocess`;
  const outDir = path.resolve(__dirname, "../output", runId);
  const sectionsDir = path.join(outDir, "sections");

  fs.mkdirSync(sectionsDir, { recursive: true });

  console.log(`\nRun ID: ${runId}`);
  console.log(`Output: ${outDir}\n`);
  console.log("Running preprocessor...");

  const result = await preprocessPage(url);

  // arch.json
  fs.writeFileSync(
    path.join(outDir, "arch.json"),
    JSON.stringify(
      {
        url,
        runId,
        sectionCount: result.sections.length,
        imageCount: result.imageUrls.length,
        fontCount: result.fontFamilies.length,
        svgCount: result.svgs.length,
        truncated: result.truncated,
        sections: result.sections,
        fontFamilies: result.fontFamilies,
        imageUrls: result.imageUrls,
        computedStyles: result.computedStyles,
      },
      null,
      2,
    ),
    "utf-8",
  );

  // skeleton-screenshot.png
  fs.writeFileSync(path.join(outDir, "skeleton-screenshot.png"), result.skeletonScreenshot);

  // skeleton.html
  fs.writeFileSync(path.join(outDir, "skeleton.html"), result.skeletonHtml, "utf-8");

  // Per-section crops
  for (const [slug, crops] of Object.entries(result.sectionScreenshots)) {
    for (let i = 0; i < crops.length; i++) {
      fs.writeFileSync(path.join(sectionsDir, `${slug}-${i}.png`), crops[i]);
    }
  }

  // report.html
  const reportHtml = buildReport(url, result.sections, result.sectionScreenshots, result.skeletonHtml);
  fs.writeFileSync(path.join(outDir, "report.html"), reportHtml, "utf-8");

  console.log(`\nDone.`);
  console.log(`  arch.json                ${result.sections.length} sections`);
  console.log(`  skeleton-screenshot.png`);
  console.log(`  skeleton.html`);
  console.log(`  sections/                ${Object.values(result.sectionScreenshots).flat().length} crops`);
  console.log(`  report.html`);
  console.log(`\n${result.sections.map((s) => `  [${s.order}] ${s.slug} (${s.role}) y=${s.y} h=${s.height}`).join("\n")}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
