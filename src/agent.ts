import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { renderStream } from "./render";

const client = new Anthropic();

const OUTPUT_DIR = path.resolve(__dirname, "..", "output");

async function fetchPage(url: string) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  return res.text();
}

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

  const sourceHtml = await fetchPage(url);

  const maxChars = 80_000;
  const truncated =
    sourceHtml.length > maxChars
      ? sourceHtml.slice(0, maxChars) + "\n<!-- truncated -->"
      : sourceHtml;

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
        content: `Create a single-file HTML page that recreates this page's content and visual design using Tailwind CSS (via CDN script tag). 
        
The page MUST:

- Be a complete, self-contained HTML file
- Use the Tailwind CSS CDN (<script src="https://cdn.tailwindcss.com"></script>)
- Faithfully reproduce the layout, content, and visual style of the source page
- Be responsive and well-structured

Use descriptive kebab-case filename based on the source page's title or domain.

Here is the HTML source of a webpage at ${url}:

<source_html>
${truncated}
</source_html>`,
      },
    ],
  });

  await renderStream(runner);

  return savedPath;
}
