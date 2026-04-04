import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { resizeForVlm } from "../image";
import { renderStream } from "../render";
import { estimateMaxTokens } from "../observability/metrics";
import { SKELETON_SYSTEM, buildSkeletonUserContent } from "../prompts/skeleton";
import { formatArchDoc } from "./assembly";
import type { CrawlResult } from "../context";
import { MODELS } from "../config";

const GENERATE_MODEL = MODELS.skeleton;

const client = new Anthropic();

export interface SkeletonResult {
  skeletonHtml: string;
  skeletonBasename: string;
  tokensIn: number;
  tokensOut: number;
}

export async function runSkeletonAgent(params: {
  url: string;
  crawlResult: CrawlResult;
  mainDir: string;
}): Promise<SkeletonResult | null> {
  const { url, crawlResult, mainDir } = params;
  const archDoc = crawlResult.visualArchDoc;

  let skeletonHtml: string | null = null;
  let skeletonBasename: string | null = null;

  const saveSkeletonTool = betaZodTool({
    name: "save_file",
    description: "Save the skeleton HTML to disk.",
    inputSchema: z.object({
      filename: z
        .string()
        .describe("A descriptive kebab-case filename, e.g. acme-skeleton.html"),
      content: z.string().describe("The full skeleton HTML content"),
    }),
    run: async (input) => {
      const outPath = path.join(mainDir, input.filename);
      fs.writeFileSync(outPath, input.content, "utf-8");
      skeletonHtml = input.content;
      skeletonBasename = path.basename(input.filename, ".html").replace(/-skeleton$/, "");
      return JSON.stringify({ success: true, file_path: outPath });
    },
  });

  const navIsSection = archDoc.sections.some(
    (s) => s.role === "navbar" || s.role === "header",
  );

  const screenshotBuf = Buffer.from(crawlResult.screenshotBase64, "base64");
  const resizedFullPage = await resizeForVlm(screenshotBuf);

  const archDocText = formatArchDoc(archDoc);
  const slugList = archDoc.sections
    .map((s) => `  ${s.order}. "${s.slug}" (${s.role})`)
    .join("\n");

  const runner = client.beta.messages.toolRunner({
    model: GENERATE_MODEL,
    max_tokens: estimateMaxTokens(crawlResult.html.length, GENERATE_MODEL),
    thinking: { type: "disabled" },
    tools: [saveSkeletonTool],
    tool_choice: { type: "tool", name: "save_file" },
    stream: true,
    max_iterations: 1,
    system: SKELETON_SYSTEM(navIsSection),
    messages: [
      {
        role: "user",
        content: buildSkeletonUserContent({
          url,
          resizedScreenshotBase64: resizedFullPage.toString("base64"),
          slugList,
          archDocText,
          stylesJson: JSON.stringify(crawlResult.computedStyles, null, 2),
          fontsText: crawlResult.fontFamilies.join(", "),
          imageUrlsText: crawlResult.imageUrls.join("\n"),
          svgsText: crawlResult.svgs.join("\n"),
          fixedElementsHtml: crawlResult.fixedElementsHtml.join("\n\n"),
          sourceHtml: crawlResult.html,
        }),
      },
    ],
  });

  const { tokensIn, tokensOut } = await renderStream(runner);

  if (!skeletonHtml) {
    return null;
  }

  return {
    skeletonHtml,
    skeletonBasename: skeletonBasename ?? "page",
    tokensIn,
    tokensOut,
  };
}
