import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { renderStream } from "../render";
import { SECTION_SYSTEM, buildSectionUserContent } from "../prompts/section";

const GENERATE_MODEL = "claude-sonnet-4-6";
const SECTION_MAX_TOKENS = 8_000;

const client = new Anthropic();

export async function generateSection(
  section: { slug: string; description: string; role: string; order: number; heightPx: number },
  _neighborSlugs: { prev?: string; next?: string },
  screenshots: Buffer[],
  computedStyles: { selector: string; color: string; backgroundColor: string; fontSize: string; fontFamily: string }[],
  fontFamilies: string[],
  imageUrls: string[],
  _url: string,
  cssVars?: string,
  shellContext?: { self: string; prev?: string; next?: string },
  corrections?: string[],
  currentScreenshot?: Buffer,
  currentHtml?: string,
): Promise<{ slug: string; fragment: string; tokensIn: number; tokensOut: number }> {
  let fragment: string | null = null;

  const saveSectionTool = betaZodTool({
    name: "save_section",
    description:
      "Output the HTML fragment for this section's interior content. Call this once with the complete fragment.",
    inputSchema: z.object({
      slug: z.string().describe("The section slug this fragment is for"),
      content: z
        .string()
        .describe(
          "The interior HTML fragment — no document wrappers, style tags, or script tags",
        ),
    }),
    run: async (input) => {
      fragment = input.content;
      return JSON.stringify({ success: true, slug: input.slug });
    },
  });

  const contentBlocks = await buildSectionUserContent({
    section,
    screenshots,
    computedStyles,
    fontFamilies,
    imageUrls,
    cssVars,
    shellContext,
    corrections,
    currentScreenshot,
    currentHtml,
  });

  const sectionRunner = client.beta.messages.toolRunner({
    model: GENERATE_MODEL,
    max_tokens: SECTION_MAX_TOKENS,
    thinking: { type: "disabled" },
    tools: [saveSectionTool],
    tool_choice: { type: "tool", name: "save_section" },
    stream: true,
    max_iterations: 2,
    system: SECTION_SYSTEM,
    messages: [
      {
        role: "user",
        content: contentBlocks,
      },
    ],
  });

  const { tokensIn, tokensOut } = await renderStream(sectionRunner);
  return { slug: section.slug, fragment: fragment ?? "", tokensIn, tokensOut };
}
