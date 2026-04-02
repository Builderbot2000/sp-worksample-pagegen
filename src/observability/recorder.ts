import * as fs from "fs";
import * as path from "path";
import type { LogLine, RunRecord } from "./types";

export class Recorder {
  private stream: fs.WriteStream;
  private runDir: string;

  constructor(runDir: string) {
    this.runDir = runDir;
    fs.mkdirSync(runDir, { recursive: true });
    this.stream = fs.createWriteStream(path.join(runDir, "run.ndjson"), {
      flags: "a",
      encoding: "utf-8",
    });
  }

  write(line: LogLine): void {
    this.stream.write(JSON.stringify(line) + "\n");
  }

  finalize(record: RunRecord): void {
    this.stream.end();

    const stripImages = (r: RunRecord): RunRecord => {
      const { fidelityMetrics, baseline, ...rest } = r;
      const strippedFidelity = fidelityMetrics
        ? (({ sourceScreenshotBase64, mainScreenshotBase64, baselineScreenshotBase64, ...metrics }) => metrics)(fidelityMetrics)
        : undefined;
      const strippedBaseline = baseline
        ? { ...baseline, mainThumbnail: "", baselineThumbnail: "" }
        : undefined;
      return {
        ...rest,
        ...(strippedFidelity !== undefined ? { fidelityMetrics: strippedFidelity } : {}),
        ...(strippedBaseline !== undefined ? { baseline: strippedBaseline } : {}),
      };
    };

    const stripped = stripImages(record);

    fs.writeFileSync(
      path.join(this.runDir, "run.json"),
      JSON.stringify(stripped, null, 2),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(this.runDir, "summary.json"),
      JSON.stringify(stripped, null, 2),
      "utf-8",
    );
  }
}
