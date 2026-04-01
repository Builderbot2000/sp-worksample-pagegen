import * as fs from "fs";
import * as path from "path";
import type { RunRecord, IterationRecord, Severity } from "./types";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

function formatDate(ts: number): string {
  return new Date(ts).toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

function severityColor(severity: Severity): string {
  if (severity === "high") return "#ef4444";
  if (severity === "medium") return "#f59e0b";
  return "#22c55e";
}

function scoreBarWidth(score: number): number {
  return Math.round(Math.max(0, Math.min(1, score)) * 100);
}

function scoreColor(score: number): string {
  if (score > 0.85) return "#22c55e";
  if (score >= 0.6) return "#f59e0b";
  return "#ef4444";
}

// ─── Section builders ─────────────────────────────────────────────────────────

function buildIterationRows(record: RunRecord): string {
  if (record.iterations.length === 0) {
    return `<tr><td colspan="5" style="text-align:center;color:#6b7280;padding:1.5rem 0">No iterations recorded</td></tr>`;
  }
  return record.iterations
    .map((iter: IterationRecord) => {
      const color = severityColor(iter.severity);
      const barWidth = scoreBarWidth(iter.overallScore);
      return `
      <tr>
        <td style="padding:0.6rem 1rem;text-align:center;font-variant-numeric:tabular-nums">${iter.iteration}</td>
        <td style="padding:0.6rem 1rem">
          <div style="display:flex;align-items:center;gap:0.5rem">
            <div style="flex:1;background:#1f2937;border-radius:3px;height:8px;overflow:hidden">
              <div style="width:${barWidth}%;height:100%;background:${color};border-radius:3px"></div>
            </div>
            <span style="font-variant-numeric:tabular-nums;font-size:0.875rem;color:${color}">${iter.overallScore.toFixed(3)}</span>
          </div>
        </td>
        <td style="padding:0.6rem 1rem;color:${color};font-weight:600;font-size:0.875rem">${iter.severity}</td>
        <td style="padding:0.6rem 1rem;font-variant-numeric:tabular-nums;font-size:0.875rem;color:#9ca3af">${iter.diffPixels.toLocaleString()}</td>
        <td style="padding:0.6rem 1rem;text-align:center;font-size:0.875rem;color:#9ca3af">${iter.discrepancyCount}</td>
      </tr>`;
    })
    .join("\n");
}

function buildMetricsComparison(record: RunRecord): string {
  if (!record.baseline) return "";
  const b = record.baseline;
  const durationMs = record.completedAt - record.startedAt;

  const metrics = [
    {
      label: "Fidelity Score",
      main: b.mainScore,
      baseline: b.baselineScore,
      fmt: (v: number) => v.toFixed(3),
      higherIsBetter: true,
      max: 1,
    },
    {
      label: "Processing Time",
      main: durationMs,
      baseline: b.baselineDurationMs,
      fmt: (v: number) => formatDuration(v),
      higherIsBetter: false,
      max: Math.max(durationMs, b.baselineDurationMs),
    },
    {
      label: "Est. Cost",
      main: record.estimatedCostUsd,
      baseline: b.baselineCostUsd,
      fmt: (v: number) => `$${v.toFixed(3)}`,
      higherIsBetter: false,
      max: Math.max(record.estimatedCostUsd, b.baselineCostUsd),
    },
  ];

  const rows = metrics
    .map(({ label, main, baseline, fmt, higherIsBetter, max }) => {
      const mainWins = higherIsBetter ? main >= baseline : main <= baseline;
      const delta =
        baseline !== 0 ? ((main - baseline) / baseline) * 100 : 0;
      const deltaSign = delta >= 0 ? "+" : "";
      const deltaColor = mainWins ? "#22c55e" : "#ef4444";
      const mainPct = max !== 0 ? Math.round((main / max) * 100) : 0;
      const basePct = max !== 0 ? Math.round((baseline / max) * 100) : 0;

      return `
      <div style="margin-bottom:1.5rem">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.5rem">
          <span style="font-weight:600;color:#e5e7eb">${escapeHtml(label)}</span>
          <span style="font-size:0.8rem;font-weight:600;color:${deltaColor};background:${deltaColor}22;padding:0.1rem 0.5rem;border-radius:999px">${deltaSign}${delta.toFixed(1)}%</span>
        </div>
        <div style="position:relative;height:28px;background:#111827;border-radius:4px;overflow:hidden">
          <div style="position:absolute;left:0;top:0;height:100%;width:${basePct}%;background:#8b5cf6;border-radius:4px;opacity:0.7"></div>
          <div style="position:absolute;left:0;top:0;height:100%;width:${mainPct}%;background:#3b82f6;border-radius:4px"></div>
        </div>
        <div style="display:flex;justify-content:space-between;margin-top:0.3rem;font-size:0.8rem;color:#6b7280">
          <span><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#3b82f6;margin-right:4px"></span>Experimental: ${fmt(main)}</span>
          <span><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#8b5cf6;margin-right:4px"></span>Baseline: ${fmt(baseline)}</span>
        </div>
      </div>`;
    })
    .join("\n");

  return `
  <section style="margin-bottom:2rem">
    <h2 style="font-size:1rem;font-weight:600;color:#9ca3af;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:1rem">Performance Comparison</h2>
    <div style="background:#1f2937;border-radius:8px;padding:1.5rem">
      ${rows}
    </div>
  </section>`;
}

function buildComparisonSection(
  record: RunRecord,
  sourceThumbnail?: string,
): string {
  if (!record.baseline) return "";
  const b = record.baseline;
  const durationMs = record.completedAt - record.startedAt;
  const mainWins = b.mainScore >= b.baselineScore;

  const winStyle = `border:2px solid #22c55e;background:#052e1620;`;
  const neutralStyle = `border:1px solid #374151;`;

  const sourceCard = sourceThumbnail
    ? `
    <div style="flex:1;background:#1f2937;border-radius:8px;padding:1.25rem;${neutralStyle}">
      <div style="font-size:0.75rem;font-weight:600;color:#6b7280;text-transform:uppercase;margin-bottom:0.75rem">Source</div>
      <img src="data:image/png;base64,${sourceThumbnail}" style="width:100%;max-height:400px;object-fit:contain;object-position:top;border-radius:4px" />
    </div>`
    : "";

  const mainCard = `
    <div style="flex:1;background:#1f2937;border-radius:8px;padding:1.25rem;${mainWins ? winStyle : neutralStyle}">
      <div style="font-size:0.75rem;font-weight:600;color:${mainWins ? "#22c55e" : "#6b7280"};text-transform:uppercase;margin-bottom:0.75rem">Experimental${mainWins ? " ✓" : ""}</div>
      <div style="font-size:1.5rem;font-weight:700;color:${scoreColor(b.mainScore)};margin-bottom:0.25rem">${b.mainScore.toFixed(3)}</div>
      <div style="font-size:0.8rem;color:#6b7280;margin-bottom:0.1rem">$${b.mainCostUsd.toFixed(3)}</div>
      <div style="font-size:0.8rem;color:#6b7280;margin-bottom:0.75rem">${formatDuration(durationMs)}</div>
      ${b.mainThumbnail ? `<div style="overflow:auto;max-height:400px"><img src="data:image/png;base64,${b.mainThumbnail}" style="width:100%;border-radius:4px" /></div>` : ""}
    </div>`;

  const baselineCard = `
    <div style="flex:1;background:#1f2937;border-radius:8px;padding:1.25rem;${!mainWins ? winStyle : neutralStyle}">
      <div style="font-size:0.75rem;font-weight:600;color:${!mainWins ? "#22c55e" : "#6b7280"};text-transform:uppercase;margin-bottom:0.75rem">Baseline${!mainWins ? " ✓" : ""}</div>
      <div style="font-size:1.5rem;font-weight:700;color:${scoreColor(b.baselineScore)};margin-bottom:0.25rem">${b.baselineScore.toFixed(3)}</div>
      <div style="font-size:0.8rem;color:#6b7280;margin-bottom:0.1rem">$${b.baselineCostUsd.toFixed(3)}</div>
      <div style="font-size:0.8rem;color:#6b7280;margin-bottom:0.75rem">${formatDuration(b.baselineDurationMs)}</div>
      ${b.baselineThumbnail ? `<div style="overflow:auto;max-height:400px"><img src="data:image/png;base64,${b.baselineThumbnail}" style="width:100%;border-radius:4px" /></div>` : ""}
    </div>`;

  const scoreDelta = b.mainScore - b.baselineScore;
  const costDelta = b.mainCostUsd - b.baselineCostUsd;
  const scoreDeltaColor = scoreDelta >= 0 ? "#22c55e" : "#ef4444";
  const costDeltaColor = costDelta <= 0 ? "#22c55e" : "#ef4444";

  return `
  <section style="margin-bottom:2rem">
    <h2 style="font-size:1rem;font-weight:600;color:#9ca3af;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:1rem">Baseline Comparison</h2>
    <div style="display:flex;gap:1rem;margin-bottom:1rem">
      ${sourceCard}
      ${mainCard}
      ${baselineCard}
    </div>
    <div style="display:flex;gap:1rem">
      <div style="flex:1;background:#1f2937;border-radius:6px;padding:0.75rem 1rem;display:flex;justify-content:space-between;align-items:center">
        <span style="font-size:0.875rem;color:#9ca3af">Score delta</span>
        <span style="font-weight:700;color:${scoreDeltaColor}">${scoreDelta >= 0 ? "+" : ""}${scoreDelta.toFixed(3)}</span>
      </div>
      <div style="flex:1;background:#1f2937;border-radius:6px;padding:0.75rem 1rem;display:flex;justify-content:space-between;align-items:center">
        <span style="font-size:0.875rem;color:#9ca3af">Cost delta</span>
        <span style="font-weight:700;color:${costDeltaColor}">${costDelta >= 0 ? "+" : ""}$${costDelta.toFixed(3)}</span>
      </div>
    </div>
  </section>`;
}

// ─── Main export ──────────────────────────────────────────────────────────────

export function generateReport(
  runDir: string,
  record: RunRecord,
  sourceThumbnail?: string,
): string {
  const durationMs = record.completedAt - record.startedAt;
  const lastIter = record.iterations[record.iterations.length - 1];
  const finalScore = lastIter?.overallScore;
  const finalScoreDisplay =
    finalScore !== undefined ? finalScore.toFixed(3) : "—";
  const finalScoreColor =
    finalScore !== undefined ? scoreColor(finalScore) : "#6b7280";

  const displayName = record.name
    ? `${escapeHtml(record.name)} — ${escapeHtml(record.runId)}`
    : escapeHtml(record.runId);

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${record.name ? escapeHtml(record.name) + " — " : ""}Page Gen Report</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #111827; color: #e5e7eb; padding: 2rem; line-height: 1.5; }
    a { color: #60a5fa; }
    table { width: 100%; border-collapse: collapse; }
    th { text-align: left; padding: 0.6rem 1rem; font-size: 0.75rem; font-weight: 600; color: #6b7280; text-transform: uppercase; letter-spacing: 0.05em; border-bottom: 1px solid #374151; }
    tr:nth-child(even) { background: #1a2332; }
  </style>
</head>
<body>
  <div style="max-width:900px;margin:0 auto">

    <header style="margin-bottom:2rem">
      <h1 style="font-size:1.5rem;font-weight:700;color:#f9fafb;margin-bottom:0.25rem">${displayName}</h1>
      <p style="color:#6b7280;font-size:0.875rem">Page Generation Report</p>
    </header>

    <section style="margin-bottom:2rem">
      <h2 style="font-size:1rem;font-weight:600;color:#9ca3af;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:1rem">Run Metadata</h2>
      <div style="background:#1f2937;border-radius:8px;padding:1.25rem;display:grid;grid-template-columns:1fr 1fr;gap:0.75rem">
        <div>
          <div style="font-size:0.75rem;color:#6b7280;margin-bottom:0.2rem">URL</div>
          <a href="${escapeHtml(record.url)}" style="font-size:0.875rem">${escapeHtml(record.url)}</a>
        </div>
        <div>
          <div style="font-size:0.75rem;color:#6b7280;margin-bottom:0.2rem">Run ID</div>
          <span style="font-size:0.875rem;font-family:monospace">${escapeHtml(record.runId)}</span>
        </div>
        <div>
          <div style="font-size:0.75rem;color:#6b7280;margin-bottom:0.2rem">Started</div>
          <span style="font-size:0.875rem">${formatDate(record.startedAt)}</span>
        </div>
        <div>
          <div style="font-size:0.75rem;color:#6b7280;margin-bottom:0.2rem">Completed</div>
          <span style="font-size:0.875rem">${formatDate(record.completedAt)}</span>
        </div>
        <div>
          <div style="font-size:0.75rem;color:#6b7280;margin-bottom:0.2rem">Duration</div>
          <span style="font-size:0.875rem">${formatDuration(durationMs)}</span>
        </div>
        <div>
          <div style="font-size:0.75rem;color:#6b7280;margin-bottom:0.2rem">Iterations</div>
          <span style="font-size:0.875rem">${record.iterations.length}</span>
        </div>
      </div>
    </section>

    <section style="margin-bottom:2rem">
      <h2 style="font-size:1rem;font-weight:600;color:#9ca3af;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:1rem">Summary</h2>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:1rem">
        <div style="background:#1f2937;border-radius:8px;padding:1.25rem">
          <div style="font-size:0.75rem;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:0.5rem">Final Score</div>
          <div style="font-size:2rem;font-weight:700;color:${finalScoreColor}">${finalScoreDisplay}</div>
        </div>
        <div style="background:#1f2937;border-radius:8px;padding:1.25rem">
          <div style="font-size:0.75rem;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:0.5rem">Est. Cost</div>
          <div style="font-size:2rem;font-weight:700;color:#f9fafb">$${record.estimatedCostUsd.toFixed(3)}</div>
        </div>
        <div style="background:#1f2937;border-radius:8px;padding:1.25rem">
          <div style="font-size:0.75rem;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:0.5rem">Duration</div>
          <div style="font-size:2rem;font-weight:700;color:#f9fafb">${formatDuration(durationMs)}</div>
        </div>
      </div>
    </section>

    <section style="margin-bottom:2rem">
      <h2 style="font-size:1rem;font-weight:600;color:#9ca3af;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:1rem">Iterations</h2>
      <div style="background:#1f2937;border-radius:8px;overflow:hidden">
        <table>
          <thead>
            <tr>
              <th style="width:3rem">#</th>
              <th>Score</th>
              <th>Severity</th>
              <th>Diff Pixels</th>
              <th style="width:7rem">Discrepancies</th>
            </tr>
          </thead>
          <tbody>
            ${buildIterationRows(record)}
          </tbody>
        </table>
      </div>
    </section>

    ${buildMetricsComparison(record)}
    ${buildComparisonSection(record, sourceThumbnail)}

  </div>
</body>
</html>`;

  const outPath = path.join(runDir, "report.html");
  fs.writeFileSync(outPath, html, "utf-8");
  process.stdout.write(`Report: ${outPath}\n`);
  return outPath;
}
