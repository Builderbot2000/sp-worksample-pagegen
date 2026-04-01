import type { BetaToolRunner } from "@anthropic-ai/sdk/lib/tools/BetaToolRunner";

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;

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
