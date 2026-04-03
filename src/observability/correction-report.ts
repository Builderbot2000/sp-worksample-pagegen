import * as fs from "fs";
import * as path from "path";
import { escHtml } from "../utils";
import type { SectionDiscrepancy, VisualArchDoc } from "./types";

export interface CorrectionIterReportParams {
  iter: number;
  maxIter: number;
  url: string;
  aggregateScore: number;
  matched: number;
  unmatched: number;
  sections: VisualArchDoc["sections"];
  discrepancies: SectionDiscrepancy[];
  slugsToFix: Set<string>;
  correctionsDir: string;
  sectionsDir: string;
}

export function buildCorrectionIterReport(params: CorrectionIterReportParams): string {
  const {
    iter,
    maxIter,
    url,
    aggregateScore,
    matched,
    unmatched,
    sections,
    discrepancies,
    slugsToFix,
    correctionsDir,
    sectionsDir,
  } = params;

  const iterScreenshotsDir = path.join(correctionsDir, `iter-${iter}`);

  const sectionCards = sections.map((s) => {
    const disc = discrepancies.find(
      (d) => d.slug.replace(/\s*\([^)]*\)\s*$/, "").trim() === s.slug,
    );
    const score = disc?.score ?? 1;
    const severity = score >= 0.85 ? "low" : score >= 0.6 ? "medium" : "high";
    const isFixed = slugsToFix.has(s.slug);
    const scoreColor = score >= 0.85 ? "#34d399" : score >= 0.6 ? "#fbbf24" : "#f87171";
    const sourceImg = path.relative(correctionsDir, path.join(sectionsDir, `source-${s.slug}.png`));
    const genImg = `iter-${iter}/generated-${s.slug}.png`;
    const hasSource = fs.existsSync(path.join(sectionsDir, `source-${s.slug}.png`));
    const hasGen = fs.existsSync(path.join(iterScreenshotsDir, `generated-${s.slug}.png`));
    return `<div class="section-card${isFixed ? " fixing" : ""}">
  <div class="section-header">
    <span class="section-slug">${escHtml(s.slug)}</span>
    <span class="section-role">${escHtml(s.role)}</span>
    <span class="score-badge" style="background:${scoreColor}20;color:${scoreColor};border:1px solid ${scoreColor}40">${(score * 100).toFixed(0)}% ${escHtml(severity)}</span>
    ${isFixed ? `<span class="badge fixing-badge">FIXING</span>` : ""}
  </div>
  ${disc?.issues?.length ? `<ul class="issues-list">${disc.issues.map((i) => `<li>${escHtml(i)}</li>`).join("")}</ul>` : ""}
  <div class="section-screenshots">
    <div class="screenshot-col">
      <div class="screenshot-label">Source</div>
      ${hasSource ? `<img src="${escHtml(sourceImg)}" />` : `<div class="screenshot-missing">No source</div>`}
    </div>
    <div class="screenshot-col">
      <div class="screenshot-label">Generated (iter ${iter})</div>
      ${hasGen ? `<img src="${escHtml(genImg)}" />` : `<div class="screenshot-missing">No screenshot</div>`}
    </div>
  </div>
</div>`;
  }).join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Correction iter ${iter} — ${escHtml(url)}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #111827; color: #e5e7eb; padding: 2rem; line-height: 1.5; }
    h1 { font-size: 1.1rem; font-weight: 700; color: #f9fafb; margin-bottom: 0.25rem; }
    .badge { display: inline-block; padding: 0.15rem 0.5rem; border-radius: 3px; font-size: 0.7rem; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; }
    .score-badge { display: inline-block; padding: 0.15rem 0.5rem; border-radius: 3px; font-size: 0.7rem; font-weight: 700; }
    .fixing-badge { background: #78350f; color: #fbbf24; }
    .section-card { background: #1f2937; border-radius: 8px; padding: 1.25rem; margin-bottom: 1.5rem; }
    .section-card.fixing { border-left: 3px solid #fbbf24; }
    .section-header { display: flex; align-items: baseline; gap: 0.75rem; margin-bottom: 0.75rem; flex-wrap: wrap; }
    .section-slug { font-family: monospace; font-size: 0.9rem; color: #60a5fa; font-weight: 600; }
    .section-role { font-size: 0.7rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; background: #374151; color: #d1d5db; padding: 0.15rem 0.5rem; border-radius: 3px; }
    .issues-list { font-size: 0.8rem; color: #fca5a5; margin: 0.5rem 0 0.75rem 1rem; }
    .issues-list li + li { margin-top: 0.25rem; }
    .section-screenshots { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin-top: 0.75rem; }
    .screenshot-col { display: flex; flex-direction: column; gap: 0.5rem; }
    .screenshot-label { font-size: 0.7rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: #6b7280; }
    .screenshot-col img { width: 100%; border-radius: 4px; border: 1px solid #374151; display: block; }
    .screenshot-missing { font-size: 0.8rem; color: #6b7280; padding: 1rem; background: #111827; border-radius: 4px; text-align: center; }
    .stat { display: inline-block; margin-right: 1.5rem; font-size: 0.85rem; color: #d1d5db; }
    .stat span { font-weight: 700; color: #f9fafb; }
  </style>
</head>
<body>
  <h1>Correction Iteration ${iter}/${maxIter}</h1>
  <p style="color:#9ca3af;font-size:0.85rem;margin-top:0.25rem;margin-bottom:1.25rem">${escHtml(url)}</p>
  <div style="margin-bottom:1.5rem">
    <span class="stat">Aggregate score <span>${(aggregateScore * 100).toFixed(1)}%</span></span>
    <span class="stat">Matched <span>${matched}</span></span>
    <span class="stat">Unmatched <span>${unmatched}</span></span>
    <span class="stat">Fixing <span>${slugsToFix.size}</span></span>
  </div>
  ${sectionCards}
</body>
</html>`;
}
