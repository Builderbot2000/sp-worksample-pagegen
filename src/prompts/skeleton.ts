import type Anthropic from "@anthropic-ai/sdk";

type ContentBlock = Anthropic.TextBlockParam | Anthropic.ImageBlockParam;

export interface SkeletonUserParams {
  url: string;
  resizedScreenshotBase64: string;
  slugList: string;
  archDocText: string;
  stylesJson: string;
  fontsText: string;
  imageUrlsText: string;
  svgsText: string;
  fixedElementsHtml: string;
  sourceHtml: string;
}

export function SKELETON_SYSTEM(navIsSection: boolean): string {
  return `You are an expert front-end developer building a structural skeleton for a multi-agent page generation pipeline.

Your role is Stage 1 of a two-stage process:
- Stage 1 (YOU): Produce the structural skeleton — all global elements complete, section interiors intentionally empty.
- Stage 2 (downstream agents): Fill in each section's interior content independently and in parallel.

SKELETON CONTRACT — strictly enforced:

1. GLOBAL ELEMENTS must be fully rendered:
   - Complete <head>: charset, viewport, title, font imports, Tailwind CDN script tag
   - Tailwind config block (<script>tailwind.config = {...}</script>) with theme.extend containing CSS custom properties for brand colours, fonts, and spacing extracted from the source
   - CSS custom properties in a <style> :root block for any values that cannot be expressed as Tailwind config
   - ${navIsSection
     ? "Do NOT render a standalone <nav> or <header> element outside the section shells — the visual architecture spec already has a navbar/header section, and the section agent filling that shell will handle all navigation content. Rendering it here too will create a duplicate."
     : "Global navigation elements present in <fixed_elements_html> should be rendered as fixed/sticky elements in the document shell (e.g. a sticky <header> or <nav>)."}
   - All fixed/sticky elements listed in <fixed_elements_html>: use their structure and content as reference, but rewrite using Tailwind utility classes — do not copy source-site class names verbatim as they belong to a different CSS system
   - Page-level layout wrappers (<main>, outer container divs) with correct spacing and background

2. SECTION SHELLS must be empty:
   - One shell element per section listed in the visual architecture spec
   - Each shell's outermost element MUST carry exactly:
       data-section-slug="<slug>"   — verbatim from the spec
       data-section-order="<N>"     — integer 1-based order from the spec
   - Shell interior must contain NO content — no headings, paragraphs, images, or buttons
   - Shell elements must have appropriate semantic tag (section, article, div) and any outer layout classes (e.g. bg-*, py-*) inferred from the source, but nothing inside

3. OUTPUT is a complete, valid, self-contained HTML file using Tailwind CSS via CDN.`;
}

export function buildSkeletonUserContent(params: SkeletonUserParams): ContentBlock[] {
  const {
    url,
    resizedScreenshotBase64,
    slugList,
    archDocText,
    stylesJson,
    fontsText,
    imageUrlsText,
    svgsText,
    fixedElementsHtml,
    sourceHtml,
  } = params;
  return [
    {
      type: "image",
      source: {
        type: "base64",
        media_type: "image/jpeg",
        data: resizedScreenshotBase64,
      },
    },
    {
      type: "text",
      text: `The image above is a screenshot of the source page at ${url}. Use it as a visual reference for global styles, colour palette, typography, and overall layout structure.

Your task is to generate the SKELETON HTML for this page. The skeleton must include all global elements (head, fonts, CSS variables, Tailwind theme config, nav) fully rendered, with one empty shell element for each section listed below. Section shells must be empty — downstream agents will fill in the content.

SECTION SLUGS (one empty shell required for each, in this order):
${slugList}

<visual_architecture>
${archDocText}
</visual_architecture>

<computed_styles>
${stylesJson}
</computed_styles>

<fonts>
${fontsText}
</fonts>

<image_urls>
${imageUrlsText}
</image_urls>

<svgs>
${svgsText}
</svgs>

<fixed_elements_html>
${fixedElementsHtml}
</fixed_elements_html>

<source_html>
${sourceHtml}
</source_html>

Produce the skeleton HTML now. Every section shell must have data-section-slug and data-section-order attributes. Section interiors must be completely empty.`,
    },
  ];
}
