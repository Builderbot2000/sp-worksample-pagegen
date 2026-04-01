import type { LogLine, RunRecord } from "./types";
import { Recorder } from "./recorder";

export type { Recorder };

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

export class Logger {
  constructor(private readonly recorder: Recorder) {}

  log(line: LogLine): void {
    this.recorder.write(line);
    process.stdout.write(
      dim(`[${line.phase}] `) + JSON.stringify(line.data) + "\n",
    );
  }

  finalize(record: RunRecord): void {
    this.recorder.finalize(record);
  }
}
