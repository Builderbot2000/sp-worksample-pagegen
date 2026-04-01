import type { LogLine, RunRecord } from "./types";
import type { Recorder } from "./recorder";

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

export class Logger {
  private recorder: Recorder;

  constructor(recorder: Recorder) {
    this.recorder = recorder;
  }

  log(line: LogLine): void {
    this.recorder.write(line);
    process.stdout.write(
      dim(`[${line.phase}]`) + " " + JSON.stringify(line.data) + "\n",
    );
  }

  finalize(record: RunRecord): void {
    this.recorder.finalize(record);
  }
}
