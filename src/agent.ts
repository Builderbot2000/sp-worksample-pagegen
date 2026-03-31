import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { renderStream } from "./render";
import { enrichContext } from "./context";

const client = new Anthropic();

const OUTPUT_DIR = path.resolve(__dirname, "..", "output");

export async function generatePage(url: string): Promise<string | null> {
  let savedPath: string | null = null;

  const saveFile = betaZodTool({
    name: "save_file",
    description:
      "Save the generated HTML page to disk. Call this once with the complete HTML content.",
    inputSchema: z.object({
      filename: z
        .string()
        .describe(
          "A descriptive kebab-case filename based on the source page, e.g. acme-landing-page.html",
        ),
      content: z.string().describe("The full HTML content of the page"),
    }),
    run: async (input) => {
      const outPath = path.join(OUTPUT_DIR, input.filename);
      
      fs.mkdirSync(OUTPUT_DIR, { recursive: true });
      fs.writeFileSync(outPath, input.content, "utf-8");
      
      savedPath = outPath;
      
      const result = JSON.stringify({ success: true, file_path: outPath });
      return result;
    },
  });

  const { html, screenshotChunks, computedStyles, absoluteImageUrls, fontFamilies } =
    await enrichContext(url);

  const runner = client.beta.messages.toolRunner({
    model: "claude-haiku-4-5",
    max_tokens: 16000,
    tools: [saveFile],
    tool_choice: { type: "tool", name: "save_file" },
    stream: true,
    max_iterations: 1,
    system: `You are a helpful assistant that generates HTML pages from source HTML.`,
    messages: [
      {
        role: "user",
        content: [
          ...screenshotChunks.map((data) => ({
            type: "image" as const,
            source: {
              type: "base64" as const,
              media_type: "image/png" as const,
              data,
            },
          })),
          {
            type: "text",
            text: `Create a single-file HTML page that recreates this page's content and visual design using Tailwind CSS (via CDN script tag).

The page MUST:

- Be a complete, self-contained HTML file
- Use the Tailwind CSS CDN (<script src="https://cdn.tailwindcss.com"></script>)
- Faithfully reproduce the layout, content, and visual style of the source page as shown in the viewport screenshots above (each image is a 1440×900px slice of the page from top to bottom)
- Be responsive and well-structured

Use descriptive kebab-case filename based on the source page's title or domain.

**Fonts**
The following non-generic font families were detected on the source page. Import each one via a Google Fonts <link> tag in the <head> and apply them to the appropriate elements:
${fontFamilies.length > 0 ? fontFamilies.map((f) => `- ${f}`).join("\n") : "- (none detected — use system fonts)"}

**Computed styles** (use these to match colors, spacing, and typography exactly):
\`\`\`json
${JSON.stringify(computedStyles, null, 2)}
\`\`\`

**Image URLs** (use these exact absolute URLs as src attributes for <img> tags — do not use placeholder images):
${absoluteImageUrls.length > 0 ? absoluteImageUrls.map((u) => `- ${u}`).join("\n") : "- (none detected)"}

Here is the HTML source of the page at ${url}:

<source_html>
${html}
</source_html>`,
          },
        ],
      },
    ],
  });

  await renderStream(runner);

  return savedPath;
}
