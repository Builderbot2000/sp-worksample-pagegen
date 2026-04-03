import type Anthropic from "@anthropic-ai/sdk";
import { resizeForVlm } from "../image";

type ContentBlock = Anthropic.TextBlockParam | Anthropic.ImageBlockParam;

export interface SectionSpec {
  slug: string;
  description: string;
  role: string;
  order: number;
  heightPx: number;
}

export interface SectionUserParams {
  section: SectionSpec;
  screenshots: Buffer[];
  computedStyles: { selector: string; color: string; backgroundColor: string; fontSize: string; fontFamily: string }[];
  fontFamilies: string[];
  imageUrls: string[];
  cssVars?: string;
  shellContext?: { self: string; prev?: string; next?: string };
  corrections?: string[];
  currentScreenshot?: Buffer;
  currentHtml?: string;
}

export const SECTION_SYSTEM = `You are an expert front-end developer. Your sole job is to produce an HTML fragment for one section of a webpage that matches the reference screenshot as faithfully as possible.

The reference screenshot is the absolute ground truth. Reproduce its colours, spacing, typography, layout, and content exactly. All other context (skeleton shell, CSS vars, computed styles) is secondary — use it when it helps, override it when it conflicts with the screenshot.

Your output is inserted as the interior content of a pre-existing shell element in the DOM. Hard structural constraints:
- No <html>, <head>, <body>, <style>, or <script> tags
- No Tailwind config blocks, no @layer declarations, no font imports
- Do not output a root semantic container (section/header/footer/nav/main/article) — the shell element already provides that wrapper
- Use Tailwind utility classes from the CDN`;

export async function buildSectionUserContent(params: SectionUserParams): Promise<ContentBlock[]> {
  const {
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
  } = params;

  const stylesJson = JSON.stringify(computedStyles, null, 2);
  const fontsText = fontFamilies.join(", ");
  const imageUrlsText = imageUrls.join("\n");

  const contentBlocks: ContentBlock[] = [];

  for (const buf of screenshots) {
    const resized = await resizeForVlm(buf);
    contentBlocks.push({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: resized.toString("base64") },
    });
  }

  if (currentScreenshot) {
    const resized = await resizeForVlm(currentScreenshot);
    contentBlocks.push({
      type: "text",
      text: `The image below is the CURRENT (incorrect) reconstruction of section "${section.slug}" — use it to understand exactly what went wrong and how it differs from the source above.`,
    });
    contentBlocks.push({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: resized.toString("base64") },
    });
  }

  const shellContextBlock = shellContext
    ? `<shell_context>
Your section's shell element (already in the DOM — do not re-emit its opening/closing tag, but apply any background, padding, or colour overrides needed to match the screenshot on your outermost interior element):
${shellContext.self}${shellContext.prev ? `

The section immediately above yours in the assembled page:
${shellContext.prev}` : ""}${shellContext.next ? `

The section immediately below yours in the assembled page:
${shellContext.next}` : ""}
</shell_context>\n\n`
    : "";

  contentBlocks.push({
    type: "text",
    text: `The image(s) above show section "${section.slug}" (role: ${section.role}, position ${section.order}) from the source page.
Description: ${section.description}
Source section height: approximately ${section.heightPx}px at 1280px viewport width — match this vertical extent closely.

Your task: generate the interior HTML fragment for this section that matches the screenshot above as closely as possible.

STRUCTURAL CONSTRAINTS (hard rules):
- Output only interior content — no <html>, <head>, <body>, <style>, or <script> tags
- Do not add a root semantic container (<section>, <footer>, <header>, <article>, <nav>, <main>); start directly with interior content
- No Tailwind config blocks, no font imports, no @layer declarations
- Use absolute image URLs from the list below so assets resolve correctly

Everything else — colours, spacing, typography, layout — should match the screenshot exactly. If the shell element's inherited styles conflict with the screenshot, correct them on your outermost wrapper element.

${shellContextBlock}${cssVars ? `<skeleton_css_vars>\n${cssVars}\n</skeleton_css_vars>\n\n` : ""}<computed_styles>
${stylesJson}
</computed_styles>

<fonts>
${fontsText}
</fonts>

<image_urls>
${imageUrlsText}
</image_urls>
${corrections && corrections.length > 0
    ? `\n<corrections>\nThe previous attempt had these visual issues — fix them:\n${corrections.map((i) => `- ${i}`).join("\n")}\n</corrections>\n`
    : ""}${currentHtml
    ? `\n<current_html>\nThis is the HTML fragment currently rendered in the reconstruction above. Modify it surgically to fix the listed issues rather than rewriting from scratch — keep everything that already matches the source.\n${currentHtml}\n</current_html>\n`
    : ""}
Generate the fragment now using the save_section tool.`,
  });

  return contentBlocks;
}
