import Anthropic from "@anthropic-ai/sdk";
import type { Severity } from "../observability/types";
import type { PageScore } from "./score";

const client = new Anthropic();

export interface Discrepancy {
  issue: string;
  severity: Exclude<Severity, "low">;
}

/**
 * Compares the full-page source and generated screenshots by sending
 * chunked images to Claude and asking it to identify what components
 * appear to be missing or out of position.
 *
 * Claude does not score — pixelmatch already established that something
 * is wrong. Claude only articulates *what* is wrong spatially.
 */
export async function captionPage(score: PageScore): Promise<{
  discrepancies: Discrepancy[];
  tokensIn: number;
  tokensOut: number;
}> {
  const content: Anthropic.MessageParam["content"] = [];

  // Interleave source / generated / diff chunks so Claude sees them in context
  // Cap at 3 chunks to stay within reasonable image limits
  const numChunks = Math.min(3, score.sourceChunks.length);

  for (let i = 0; i < numChunks; i++) {
    content.push({
      type: "text",
      text: `\n--- Page section ${i + 1} of ${numChunks} ---\nSource:`,
    });
    content.push({
      type: "image",
      source: {
        type: "base64",
        media_type: "image/png",
        data: score.sourceChunks[i].toString("base64"),
      },
    });
    content.push({ type: "text", text: "Generated:" });
    content.push({
      type: "image",
      source: {
        type: "base64",
        media_type: "image/png",
        data: score.generatedChunks[i].toString("base64"),
      },
    });
    content.push({ type: "text", text: "Pixel diff (red = mismatch):" });
    content.push({
      type: "image",
      source: {
        type: "base64",
        media_type: "image/png",
        data: score.diffChunks[i].toString("base64"),
      },
    });
  }

  content.push({
    type: "text",
    text: `The generated page above has a pixel fidelity score of ${score.score.toFixed(3)} (${score.severity}).

Compare the source sections with the generated sections. Identify visual components that are:
- Missing from the generated page entirely
- Present but in the wrong position relative to the source
- Present but wrong in appearance (wrong color, size, layout, or content)

Return ONLY a JSON array with no surrounding text or markdown. Each item must have:
  "issue": a concise description of what is wrong and where on the page
  "severity": "high" if the component is missing or completely wrong, "medium" if it exists but is noticeably off

Example: [{"issue":"hero background image absent, replaced with solid color","severity":"high"},{"issue":"navigation links misaligned — stacked vertically instead of horizontal","severity":"medium"}]`,
  });

  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    messages: [{ role: "user", content }],
  });

  const tokensIn = response.usage.input_tokens;
  const tokensOut = response.usage.output_tokens;

  const rawText =
    response.content.find((b) => b.type === "text")?.text ?? "[]";

  let discrepancies: Discrepancy[] = [];
  try {
    discrepancies = JSON.parse(rawText) as Discrepancy[];
  } catch {
    process.stderr.write(
      `[caption] Failed to parse Claude response as JSON: ${rawText}\n`,
    );
  }

  return { discrepancies, tokensIn, tokensOut };
}
