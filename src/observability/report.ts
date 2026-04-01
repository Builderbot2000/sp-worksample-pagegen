import * as fs from "fs";
import * as path from "path";
import type { RunRecord } from "./types";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s % 60)}s`;
}

function formatDate(ts: number): string {
  return new Date(ts).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
}

function severityColor(severity: string): string {
  switch (severity) {
    case "high": return "#ef4444";
    case "medium": return "#f59e0b";
    case "low": return "#22c55e";
    default: return "#6b7280";
  }
}

function scoreBarWidth(score: number): number {
  return Math.round(score * 100);
}

function buildIterationRows(record: RunRecord): string {
  if (record.iterations.length === 0) {
    return `<tr><td colspan="5" style="text-align:center;color:#6b7280;padding:16px;">No iterations recorded</td></tr>`;
  }
  return record.iterations
    .map(
      (it) => `
      <tr>
        <td>${it.iteration}</td>
        <td>
          <div style="display:flex;align-items:center;gap:8px;">
            <div style="flex:1;background:#e5e7eb;border-radius:4px;height:12px;overflow:hidden;">
              <div style="width:${scoreBarWidth(it.overallScore)}%;height:100%;background:${severityColor(it.severity)};border-radius:4px;"></div>
            </div>
            <span style="font-variant-numeric:tabular-nums;">${it.overallScore.toFixed(3)}</span>
          </div>
        </td>
        <td><span style="color:${severityColor(it.severity)};font-weight:600;">${it.severity}</span></td>
        <td style="font-variant-numeric:tabular-nums;">${it.diffPixels.toLocaleString()}</td>
        <td>${it.discrepancyCount}</td>
      </tr>`,
    )
    .join("");
}

function buildComparisonSection(record: RunRecord, sourceThumbnail?: string): string {
  if (!record.baseline) return "";

  const b = record.baseline;
  const mainWins = b.mainScore >= b.baselineScore;
  const scoreDelta = b.mainScore - b.baselineScore;
  const costDelta = b.mainCostUsd - b.baselineCostUsd;

  const sourceCard = sourceThumbnail
    ? `<div style="border:2px solid #6b7280;border-radius:12px;padding:20px;background:#f9fafb;">
          <h3 style="margin:0 0 12px;color:#111;">Source (actual website)</h3>
          <div style="margin-bottom:16px;font-size:13px;color:#6b7280;">Reference screenshot</div>
          <div style="width:100%;max-height:400px;overflow-y:auto;border:1px solid #e5e7eb;border-radius:8px;">
            <img src="data:image/png;base64,${sourceThumbnail}" alt="Source website" style="width:100%;display:block;" />
          </div>
        </div>`
    : "";

  return `
    <div class="section">
      <h2>Baseline Comparison</h2>
      <div style="display:grid;grid-template-columns:${sourceThumbnail ? "1fr 1fr 1fr" : "1fr 1fr"};gap:24px;">
        ${sourceCard}

        <!-- Main card -->
        <div style="border:2px solid ${mainWins ? "#22c55e" : "#e5e7eb"};border-radius:12px;padding:20px;background:${mainWins ? "#f0fdf4" : "#fff"};">
          <h3 style="margin:0 0 12px;color:#111;">Main (Sonnet 4-6)</h3>
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:16px;">
            <div>
              <div style="font-size:12px;color:#6b7280;text-transform:uppercase;">Score</div>
              <div style="font-size:24px;font-weight:700;color:${b.mainScore > 0.85 ? "#22c55e" : b.mainScore > 0.6 ? "#f59e0b" : "#ef4444"};">${b.mainScore.toFixed(3)}</div>
            </div>
            <div>
              <div style="font-size:12px;color:#6b7280;text-transform:uppercase;">Cost</div>
              <div style="font-size:24px;font-weight:700;">$${b.mainCostUsd.toFixed(3)}</div>
            </div>
            <div>
              <div style="font-size:12px;color:#6b7280;text-transform:uppercase;">Duration</div>
              <div style="font-size:24px;font-weight:700;">${formatDuration(b.mainDurationMs)}</div>
            </div>
          </div>
          <div style="width:100%;max-height:400px;overflow-y:auto;border:1px solid #e5e7eb;border-radius:8px;">
            <img src="data:image/png;base64,${b.mainThumbnail}" alt="Main output" style="width:100%;display:block;" />
          </div>
        </div>

        <!-- Baseline card -->
        <div style="border:2px solid ${!mainWins ? "#22c55e" : "#e5e7eb"};border-radius:12px;padding:20px;background:${!mainWins ? "#f0fdf4" : "#fff"};">
          <h3 style="margin:0 0 12px;color:#111;">Baseline (Haiku 4-5)</h3>
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:16px;">
            <div>
              <div style="font-size:12px;color:#6b7280;text-transform:uppercase;">Score</div>
              <div style="font-size:24px;font-weight:700;color:${b.baselineScore > 0.85 ? "#22c55e" : b.baselineScore > 0.6 ? "#f59e0b" : "#ef4444"};">${b.baselineScore.toFixed(3)}</div>
            </div>
            <div>
              <div style="font-size:12px;color:#6b7280;text-transform:uppercase;">Cost</div>
              <div style="font-size:24px;font-weight:700;">$${b.baselineCostUsd.toFixed(3)}</div>
            </div>
            <div>
              <div style="font-size:12px;color:#6b7280;text-transform:uppercase;">Duration</div>
              <div style="font-size:24px;font-weight:700;">${formatDuration(b.baselineDurationMs)}</div>
            </div>
          </div>
          <div style="width:100%;max-height:400px;overflow-y:auto;border:1px solid #e5e7eb;border-radius:8px;">
            <img src="data:image/png;base64,${b.baselineThumbnail}" alt="Baseline output" style="width:100%;display:block;" />
          </div>
        </div>
      </div>

      <!-- Delta summary -->
      <div style="margin-top:16px;padding:16px;background:#f9fafb;border-radius:8px;display:flex;gap:32px;justify-content:center;">
        <div style="text-align:center;">
          <div style="font-size:12px;color:#6b7280;">Score Delta</div>
          <div style="font-size:20px;font-weight:700;color:${scoreDelta >= 0 ? "#22c55e" : "#ef4444"};">
            ${scoreDelta >= 0 ? "+" : ""}${scoreDelta.toFixed(3)}
          </div>
        </div>
        <div style="text-align:center;">
          <div style="font-size:12px;color:#6b7280;">Cost Delta</div>
          <div style="font-size:20px;font-weight:700;color:${costDelta <= 0 ? "#22c55e" : "#ef4444"};">
            ${costDelta >= 0 ? "+" : ""}$${costDelta.toFixed(3)}
          </div>
        </div>
      </div>
    </div>`;
}

function buildMetricsComparison(record: RunRecord): string {
  if (!record.baseline) return "";
  const b = record.baseline;

  const MAIN_COLOR = "#3b82f6";
  const BASE_COLOR = "#8b5cf6";

  const metrics = [
    {
      label: "Fidelity Score",
      sublabel: "higher is better",
      main: b.mainScore,
      baseline: b.baselineScore,
      higherIsBetter: true,
      format: (v: number) => v.toFixed(3),
    },
    {
      label: "Processing Time",
      sublabel: "lower is better",
      main: b.mainDurationMs,
      baseline: b.baselineDurationMs,
      higherIsBetter: false,
      format: (v: number) => formatDuration(v),
    },
    {
      label: "Est. Cost",
      sublabel: "token proxy \u00b7 lower is better",
      main: b.mainCostUsd,
      baseline: b.baselineCostUsd,
      higherIsBetter: false,
      format: (v: number) => `$${v.toFixed(4)}`,
    },
  ];

  const rows = metrics
    .map((m) => {
      const maxVal = Math.max(m.main, m.baseline);
      if (maxVal === 0) return "";

      const mainPct = Math.round((m.main / maxVal) * 100);
      const basePct = Math.round((m.baseline / maxVal) * 100);

      const delta = ((m.main - m.baseline) / (m.baseline || 1)) * 100;
      const mainWins = m.higherIsBetter ? m.main >= m.baseline : m.main <= m.baseline;
      const deltaStr = `${delta >= 0 ? "+" : ""}${delta.toFixed(1)}%`;
      const deltaColor = mainWins ? "#22c55e" : "#ef4444";
      const deltaBg = mainWins ? "#f0fdf4" : "#fef2f2";
      const deltaBorder = mainWins ? "#bbf7d0" : "#fecaca";

      // Larger bar renders behind at low opacity; smaller bar in front at high opacity
      const mainIsLarger = mainPct >= basePct;
      const bgBar = mainIsLarger
        ? `<div style="position:absolute;inset:0;width:${mainPct}%;background:${MAIN_COLOR};opacity:0.22;border-radius:8px;"></div>`
        : `<div style="position:absolute;inset:0;width:${basePct}%;background:${BASE_COLOR};opacity:0.22;border-radius:8px;"></div>`;
      const fgBar = mainIsLarger
        ? `<div style="position:absolute;inset:0;width:${basePct}%;background:${BASE_COLOR};opacity:0.8;border-radius:8px;"></div>`
        : `<div style="position:absolute;inset:0;width:${mainPct}%;background:${MAIN_COLOR};opacity:0.8;border-radius:8px;"></div>`;

      return `
        <div>
          <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px;flex-wrap:wrap;gap:6px;">
            <div>
              <span style="font-weight:600;font-size:14px;color:#111827;">${m.label}</span>
              <span style="font-size:11px;color:#9ca3af;margin-left:6px;">${m.sublabel}</span>
            </div>
            <span style="font-size:12px;font-weight:700;color:${deltaColor};background:${deltaBg};padding:2px 8px;border-radius:999px;border:1px solid ${deltaBorder};">${deltaStr} main vs baseline</span>
          </div>
          <div style="position:relative;height:32px;border-radius:8px;overflow:hidden;background:#f3f4f6;">
            ${bgBar}
            ${fgBar}
          </div>
          <div style="display:flex;gap:20px;margin-top:6px;font-size:12px;color:#374151;">
            <span><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${MAIN_COLOR};margin-right:4px;vertical-align:middle;"></span>Main (Sonnet\u00a04-6): <strong>${m.format(m.main)}</strong></span>
            <span><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${BASE_COLOR};margin-right:4px;vertical-align:middle;"></span>Baseline (Haiku\u00a04-5): <strong>${m.format(m.baseline)}</strong></span>
          </div>
        </div>`;
    })
    .join("");

  return `
    <div class="section">
      <h2>Performance Comparison</h2>
      <div style="display:flex;flex-direction:column;gap:24px;margin-top:4px;">
        ${rows}
      </div>
    </div>`;
}

export function generateReport(runDir: string, record: RunRecord, sourceThumbnail?: Buffer): string {
  const durationMs = record.completedAt - record.startedAt;
  const finalScore =
    record.iterations.length > 0
      ? record.iterations[record.iterations.length - 1].overallScore
      : null;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Run Report — ${escapeHtml(record.runId)}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #f3f4f6; color: #111827; line-height: 1.5;
      padding: 32px 16px;
    }
    .container { max-width: 1200px; margin: 0 auto; }
    h1 { font-size: 24px; font-weight: 700; margin-bottom: 4px; }
    h2 { font-size: 18px; font-weight: 600; margin-bottom: 16px; color: #374151; }
    h3 { font-size: 15px; font-weight: 600; }
    .subtitle { font-size: 14px; color: #6b7280; margin-bottom: 24px; }
    .section {
      background: #fff; border-radius: 12px; padding: 24px;
      margin-bottom: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.08);
    }
    .kpi-grid {
      display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
      gap: 16px; margin-bottom: 8px;
    }
    .kpi { text-align: center; }
    .kpi-label { font-size: 12px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.05em; }
    .kpi-value { font-size: 28px; font-weight: 700; font-variant-numeric: tabular-nums; }
    table { width: 100%; border-collapse: collapse; font-size: 14px; }
    th { text-align: left; font-weight: 600; color: #6b7280; font-size: 12px; text-transform: uppercase;
         letter-spacing: 0.05em; padding: 8px 12px; border-bottom: 2px solid #e5e7eb; }
    td { padding: 10px 12px; border-bottom: 1px solid #f3f4f6; }
    tr:last-child td { border-bottom: none; }
    .meta-grid { display: grid; grid-template-columns: 120px 1fr; gap: 6px 16px; font-size: 14px; }
    .meta-label { font-weight: 600; color: #6b7280; }
    .meta-value { color: #111827; word-break: break-all; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Run Report</h1>
    <div class="subtitle">${escapeHtml(record.runId)}</div>

    <!-- Run Metadata -->
    <div class="section">
      <h2>Run Metadata</h2>
      <div class="meta-grid">
        <div class="meta-label">URL</div>
        <div class="meta-value"><a href="${escapeHtml(record.url)}" target="_blank">${escapeHtml(record.url)}</a></div>
        <div class="meta-label">Started</div>
        <div class="meta-value">${formatDate(record.startedAt)}</div>
        <div class="meta-label">Completed</div>
        <div class="meta-value">${formatDate(record.completedAt)}</div>
        <div class="meta-label">Duration</div>
        <div class="meta-value">${formatDuration(durationMs)}</div>
        <div class="meta-label">Iterations</div>
        <div class="meta-value">${record.iterations.length}</div>
      </div>
    </div>

    <!-- KPIs -->
    <div class="section">
      <h2>Summary</h2>
      <div class="kpi-grid">
        <div class="kpi">
          <div class="kpi-label">Final Score</div>
          <div class="kpi-value" style="color:${finalScore !== null ? (finalScore > 0.85 ? "#22c55e" : finalScore > 0.6 ? "#f59e0b" : "#ef4444") : "#6b7280"};">
            ${finalScore !== null ? finalScore.toFixed(3) : "—"}
          </div>
        </div>
        <div class="kpi">
          <div class="kpi-label">Est. Cost</div>
          <div class="kpi-value">$${record.estimatedCostUsd.toFixed(3)}</div>
        </div>
        <div class="kpi">
          <div class="kpi-label">Duration</div>
          <div class="kpi-value">${formatDuration(durationMs)}</div>
        </div>
      </div>
    </div>

    <!-- Iteration Timeline -->
    <div class="section">
      <h2>Iterations</h2>
      <table>
        <thead>
          <tr>
            <th style="width:60px;">#</th>
            <th>Score</th>
            <th style="width:90px;">Severity</th>
            <th style="width:120px;">Diff Pixels</th>
            <th style="width:110px;">Discrepancies</th>
          </tr>
        </thead>
        <tbody>
          ${buildIterationRows(record)}
        </tbody>
      </table>
    </div>

    ${buildMetricsComparison(record)}
    ${buildComparisonSection(record, sourceThumbnail?.toString("base64"))}
  </div>
</body>
</html>`;

  const reportPath = path.join(runDir, "report.html");
  fs.writeFileSync(reportPath, html, "utf-8");
  process.stdout.write(`\n📋 Report saved to ${reportPath}\n`);
  return reportPath;
}
