import type { BetaToolRunner } from "@anthropic-ai/sdk/lib/tools/BetaToolRunner";

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export interface StreamUsage {
  tokensIn: number;
  tokensOut: number;
}

export async function renderStream(runner: BetaToolRunner<true>): Promise<StreamUsage> {
  let currentBlockType: string | null = null;
  let hadToolUse = false;
  let tokensIn = 0;
  let tokensOut = 0;
  let spinnerFrame = 0;
  let inputJsonChunks = 0;

  for await (const messageStream of runner) {
    for await (const event of messageStream) {
      if (event.type === "message_start") {
        tokensIn += event.message.usage.input_tokens;
      } else if (event.type === "message_delta" && event.usage) {
        tokensOut += event.usage.output_tokens ?? 0;
      } else if (event.type === "content_block_start") {
        if (event.content_block.type === "thinking") {
          currentBlockType = "thinking";
          process.stdout.write(dim("--- thinking ---\n"));
        } else if (event.content_block.type === "tool_use") {
          currentBlockType = "tool_use";
          hadToolUse = true;
          spinnerFrame = 0;
          inputJsonChunks = 0;
          process.stdout.write(
            cyan(`\n🔧 Tool call: ${event.content_block.name} `),
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
          inputJsonChunks++;
          if (inputJsonChunks % 3 === 0) {
            process.stdout.write(
              `\b${yellow(SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length])}`,
            );
            spinnerFrame++;
          }
        }
      } else if (event.type === "content_block_stop") {
        if (currentBlockType === "thinking") {
          process.stdout.write(dim("\n--- /thinking ---\n"));
        } else if (currentBlockType === "tool_use") {
          process.stdout.write(`\b${green("✓")}\n`);
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

  return { tokensIn, tokensOut };
}
