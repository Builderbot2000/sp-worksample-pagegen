import type { BetaToolRunner } from "@anthropic-ai/sdk/lib/tools/BetaToolRunner";
import type { PageScore } from "./diff/score";

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

export async function renderStream(runner: BetaToolRunner<true>) {
  let currentBlockType: string | null = null;
  let hadToolUse = false;

  for await (const messageStream of runner) {
    for await (const event of messageStream) {
      if (event.type === "content_block_start") {
        if (event.content_block.type === "thinking") {
          currentBlockType = "thinking";
          process.stdout.write(dim("--- thinking ---\n"));
        } else if (event.content_block.type === "tool_use") {
          currentBlockType = "tool_use";
          hadToolUse = true;
          process.stdout.write(
            cyan(`\n🔧 Tool call: ${event.content_block.name}\n`),
          );
        } else if (event.content_block.type === "text") {
          currentBlockType = "text";
        }
      } else if (event.type === "content_block_delta") {
        if (event.delta.type === "thinking_delta") {
          process.stdout.write(dim(event.delta.thinking));
        } else if (event.delta.type === "text_delta") {
          process.stdout.write(event.delta.text);
        } else if (event.delta.type === "input_json_delta") {
          process.stdout.write(yellow("."));
        }
      } else if (event.type === "content_block_stop") {
        if (currentBlockType === "thinking") {
          process.stdout.write(dim("\n--- /thinking ---\n"));
        } else if (currentBlockType === "tool_use") {
          process.stdout.write(green(" ✓\n"));
        }
        currentBlockType = null;
      }
    }

    if (hadToolUse) {
      const toolResponse = await runner.generateToolResponse();
      if (toolResponse) {
        const results = Array.isArray(toolResponse.content)
          ? toolResponse.content
          : [toolResponse.content];
        for (const result of results) {
          const text =
            typeof result === "string"
              ? result
              : "content" in result
                ? String(result.content)
                : JSON.stringify(result);
          process.stdout.write(green(`  → ${text}\n`));
        }
      }
      hadToolUse = false;
    }

    process.stdout.write("\n");
  }
}

export function printIterationHeader(n: number, max: number): void {
  process.stdout.write(`\n${bold(cyan(`🔄 Fix iteration ${n}/${max}`))}\n`);
}

export function printPageScore(score: PageScore): void {
  const col =
    score.severity === "high"
      ? red
      : score.severity === "medium"
        ? yellow
        : green;
  process.stdout.write(
    `\n  Fidelity: ${col(score.score.toFixed(3))} ${dim(`(${score.severity})`)}  ${dim(`${score.diffPixels.toLocaleString()} px differ`)}\n`,
  );
}

export function printFinalSummary(overallScores: number[]): void {
  if (overallScores.length === 0) return;

  const SPARKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
  const max = Math.max(...overallScores);
  const min = Math.min(...overallScores);
  const range = max - min || 1;
  const spark = overallScores
    .map((s) => {
      const idx = Math.round(((s - min) / range) * (SPARKS.length - 1));
      return SPARKS[idx];
    })
    .join("");

  const final = overallScores[overallScores.length - 1];
  process.stdout.write(
    `\n${bold("Fidelity:")} ${spark}  final score ${bold(green(final.toFixed(3)))}\n`,
  );
}
