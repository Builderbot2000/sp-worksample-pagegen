import * as fs from "fs";
import * as path from "path";
import type { RunRecord, LogLine } from "../src/observability/types";
import { hydrateScreenshots, generateReport } from "../src/observability/report";
import { screenshotHtmlFile } from "../src/observability/screenshot";

const arg = process.argv[2];

if (!arg) {
  process.stderr.write("Usage: npm run report -- <run-directory>\n");
  process.stderr.write("Example: npm run report -- output/1775259398171-stripe-correction-test\n");
  process.exit(1);
}

const runDir = path.resolve(arg);
const runJsonPath = path.join(runDir, "run.json");

if (!fs.existsSync(runJsonPath)) {
  process.stderr.write(`Error: run.json not found in ${runDir}\n`);
  process.exit(1);
}

async function main() {
  const raw = JSON.parse(fs.readFileSync(runJsonPath, "utf-8")) as RunRecord;

  // ── Regenerate generated-page screenshot from the final HTML ─────────────
  const ndjsonPath = path.join(runDir, "run.ndjson");
  const lines = fs.readFileSync(ndjsonPath, "utf-8").trim().split("\n");
  const completeLog = lines
    .map((l) => JSON.parse(l) as LogLine)
    .find((l): l is Extract<LogLine, { phase: "run:complete" }> => l.phase === "run:complete");

  if (!completeLog?.data.outputFile) throw new Error("run:complete with outputFile not found in run.ndjson");

  const outputFile = completeLog.data.outputFile;
  process.stdout.write(`[report] Screenshotting ${path.relative(runDir, outputFile)}...\n`);
  const buf = await screenshotHtmlFile(outputFile);
  const fidelityDir = path.join(runDir, "fidelity");
  fs.mkdirSync(fidelityDir, { recursive: true });
  fs.writeFileSync(path.join(fidelityDir, "main.png"), buf);
  raw.screenshotPaths ??= { source: "source.png", sections: {} };
  raw.screenshotPaths.fidelityMain = "fidelity/main.png";

  const { record, sourceThumbnail } = hydrateScreenshots(runDir, raw);
  const outPath = generateReport(runDir, record, sourceThumbnail);
  process.stdout.write(`Report written to ${outPath}\n`);
}

main().catch((err) => {
  process.stderr.write(String(err) + "\n");
  process.exit(1);
});
