import * as fs from "fs";
import * as path from "path";
import { escHtml } from "../../utils";
import type { LogLine, RunRecord } from "../types";
import { scoreColor } from "../report-utils";
import { parseEventStream } from "./parser";
import { vizStyles } from "./styles";
import { buildHtmlShell } from "./html-shell";
import { buildStateLogic } from "./client-state";
import { buildRenderLogic } from "./client-renderers";

export { parseEventStream };

export function generateVisualizer(runDir: string, events: LogLine[], record: RunRecord): string {
  if (events.length === 0) return "";

  const title = record.name ?? record.runId;
  const durationMs = record.completedAt - record.startedAt;
  const lastIter = record.iterations[record.iterations.length - 1];
  const finalScore = record.fidelityMetrics?.mainVlmScore.score ?? lastIter?.vlmScore;
  const finalScoreStr = finalScore !== undefined ? finalScore.toFixed(3) : "—";
  const finalScoreColor = finalScore !== undefined ? scoreColor(finalScore) : "#6b7280";

  const hasFidelity = events.some((e) => e.phase === "fidelity:start");
  const hasCorrection = events.some((e) => e.phase === "correction-iter:start");

  const runMeta = {
    runId: record.runId,
    name: record.name ?? null,
    url: record.url,
    startedAt: record.startedAt,
    completedAt: record.completedAt,
    estimatedCostUsd: record.estimatedCostUsd,
    screenshotPaths: record.screenshotPaths ?? null,
    hasFidelity,
    hasCorrection,
  };

  const safeJson = (v: unknown) =>
    JSON.stringify(v).replace(/<\/script>/gi, "<\\/script>");

  const eventsJson = safeJson(events);
  const runMetaJson = safeJson(runMeta);

  const skelEv = events.find(e => e.phase === "skeleton:complete");
  const skelFile = skelEv?.data?.outputFile as string | undefined;
  let skeletonHtmlContent = "";
  if (skelFile) {
    try { skeletonHtmlContent = fs.readFileSync(path.join(runDir, skelFile), "utf-8").slice(0, 30000); } catch { /* best-effort */ }
  }
  const skeletonHtmlJson = safeJson(skeletonHtmlContent);

  const slideLabels = ["Start", "Preprocess", "Skeleton", "Sections", "Assembly", ...(hasFidelity ? ["End"] : [])];
  const slidePills = slideLabels
    .map((lbl, i) => `<button class="pill" data-slide="${i}" onclick="manualGoToSlide(${i})">${escHtml(lbl)}</button>`)
    .join("");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${escHtml(title)} — Pipeline Visualizer</title>
  <script src="https://cdn.jsdelivr.net/npm/gsap@3/dist/gsap.min.js"></script>
  <style>${vizStyles}</style>
</head>
<body>
${buildHtmlShell({
    title,
    url: record.url,
    slidePills,
    eventCount: events.length,
    hasFidelity,
    finalScoreStr,
    finalScoreColor,
    estimatedCostUsd: record.estimatedCostUsd,
    durationMs,
  })}
<script>
var EVENTS = ${eventsJson};
var RUN_META = ${runMetaJson};
var SKELETON_HTML = ${skeletonHtmlJson};
${buildStateLogic(slideLabels.length)}
${buildRenderLogic()}
</script>
</body>
</html>`;

  const outPath = path.join(runDir, "visualizer.html");
  fs.writeFileSync(outPath, html, "utf-8");
  process.stdout.write(`Visualizer: ${outPath}\n`);
  return outPath;
}
