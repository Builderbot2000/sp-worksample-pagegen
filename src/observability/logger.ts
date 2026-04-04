import type { LogLine, RunRecord } from "./types";
import type { Recorder } from "./recorder";

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;

function ms(n: number): string {
  if (n < 1000) return `${n}ms`;
  return `${(n / 1000).toFixed(1)}s`;
}

function tok(n: number): string {
  return n.toLocaleString("en-US");
}

function verdictColor(verdict: string, s: string): string {
  if (verdict === "close") return green(s);
  if (verdict === "partial") return yellow(s);
  return red(s);
}

function formatLine(line: LogLine): string {
  const tag = dim(`[${line.phase}]`);
  switch (line.phase) {
    case "run:start":
      return `${tag} ${line.data.runId} — ${line.data.url}`;
    case "run:complete":
      return `${tag} ${line.data.runId} — ${ms(line.data.durationMs)} / $${line.data.estimatedCostUsd.toFixed(4)}`;
    case "preprocess:start":
      return `${tag} ${line.data.url}`;
    case "preprocess:complete":
      return `${tag} ${line.data.sectionCount} sections, ${line.data.imageCount} images, ${line.data.fontCount} fonts (${ms(line.data.durationMs)})`;
    case "skeleton:start":
      return `${tag} ${line.data.model}`;
    case "skeleton:complete":
      return `${tag} ${green("✓")} ${tok(line.data.tokensIn)} in / ${tok(line.data.tokensOut)} out (${ms(line.data.durationMs)})`;
    case "section:start":
      return `${tag} ${line.data.slug} (${line.data.role}, order ${line.data.order})`;
    case "section:complete":
      return `${tag} ${line.data.slug} — ${green("✓")} ${tok(line.data.tokensIn)} in / ${tok(line.data.tokensOut)} out (${ms(line.data.durationMs)})`;
    case "assemble:start":
      return `${tag} merging ${line.data.sectionCount} sections…`;
    case "assemble:complete":
      return `${tag} ${green("✓")} ${(line.data.htmlSizeBytes / 1024).toFixed(0)} KB (${ms(line.data.durationMs)})`;
    case "correction-iter:start":
      return `${tag} iter ${line.data.iteration} — ${line.data.activeSlugs.length} active sections`;
    case "correction-iter:complete": {
      const scoreStr = verdictColor(
        line.data.aggregateScore > 0.85 ? "close" : line.data.aggregateScore >= 0.6 ? "partial" : "distant",
        line.data.aggregateScore.toFixed(3),
      );
      return `${tag} iter ${line.data.iteration} — score ${scoreStr}, ${line.data.sectionsToFix} to fix (${ms(line.data.durationMs)})`;
    }
    case "section-score": {
      const vcolor = verdictColor(line.data.verdict, `${line.data.score.toFixed(3)} ${line.data.verdict}`);
      const issue = line.data.issues[0] ? ` | ${dim(line.data.issues[0])}` : "";
      return `${tag} iter-${line.data.iteration} / ${line.data.slug} — ${vcolor}${issue}`;
    }
    case "section-correction:start":
      return `${tag} iter-${line.data.iteration} / ${line.data.slug} — prev ${line.data.prevScore.toFixed(3)}`;
    case "section-correction:complete":
      return `${tag} iter-${line.data.iteration} / ${line.data.slug} — ${green("✓")} ${tok(line.data.tokensIn)} in / ${tok(line.data.tokensOut)} out (${ms(line.data.durationMs)})`;
    case "fidelity:start":
      return `${tag} computing final metrics…`;
    case "fidelity:complete": {
      const mainStr = verdictColor(
        line.data.mainScore > 0.85 ? "close" : line.data.mainScore >= 0.6 ? "partial" : "distant",
        line.data.mainScore.toFixed(3),
      );
      const blStr = line.data.baselineScore !== undefined
        ? `, baseline: ${line.data.baselineScore.toFixed(3)}`
        : "";
      return `${tag} ${green("✓")} main: ${mainStr}${blStr} (${ms(line.data.durationMs)})`;
    }
    case "baseline:start":
      return `${tag} ${line.data.model}`;
    case "baseline:complete":
      return `${tag} ${green("✓")} ${tok(line.data.tokensIn)} in / ${tok(line.data.tokensOut)} out (${ms(line.data.durationMs)})`;
    default:
      return `${dim(`[${(line as LogLine).phase}]`)} ${JSON.stringify((line as LogLine).data)}`;
  }
}

export class Logger {
  private recorder: Recorder;

  constructor(recorder: Recorder) {
    this.recorder = recorder;
  }

  log(line: LogLine): void {
    this.recorder.write(line);
    process.stdout.write(formatLine(line) + "\n");
  }

  finalize(record: RunRecord): void {
    this.recorder.finalize(record);
  }
}
