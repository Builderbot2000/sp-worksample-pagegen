import * as fs from "fs";
import * as path from "path";
import type { LogLine, RunRecord } from "./types";

export class Recorder {
  private readonly ndjsonPath: string;
  private readonly jsonPath: string;
  private stream: fs.WriteStream;

  constructor(runDir: string) {
    fs.mkdirSync(runDir, { recursive: true });
    this.ndjsonPath = path.join(runDir, "run.ndjson");
    this.jsonPath = path.join(runDir, "run.json");
    this.stream = fs.createWriteStream(this.ndjsonPath, { flags: "a" });
  }

  write(line: LogLine): void {
    this.stream.write(JSON.stringify(line) + "\n");
  }

  finalize(record: RunRecord): void {
    this.stream.end();
    fs.writeFileSync(this.jsonPath, JSON.stringify(record, null, 2), "utf-8");
  }
}
