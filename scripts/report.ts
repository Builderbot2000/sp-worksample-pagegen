import * as fs from "fs";
import * as path from "path";
import type { RunRecord } from "../src/observability/types";
import { hydrateScreenshots, generateReport } from "../src/observability/report";

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

const raw = JSON.parse(fs.readFileSync(runJsonPath, "utf-8")) as RunRecord;
const { record, sourceThumbnail } = hydrateScreenshots(runDir, raw);
const outPath = generateReport(runDir, record, sourceThumbnail);

process.stdout.write(`Report written to ${outPath}\n`);
