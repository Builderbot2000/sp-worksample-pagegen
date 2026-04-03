import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { resizeForVlm } from "./image";
import { renderStream } from "./render";
import { crawlAndPreprocess } from "./context";
import { Recorder } from "./observability/recorder";
import { Logger } from "./observability/logger";
import { estimateCost, estimateMaxTokens } from "./observability/metrics";
import { collectFidelityMetrics } from "./observability/fidelity";
import { generateReport } from "./observability/report";
import type { RunRecord, FidelityMode, VisualArchDoc } from "./observability/types";

const BASELINE_MODEL = "claude-haiku-4-5";
export const GENERATE_MODEL = "claude-sonnet-4-6";

const client = new Anthropic();

// ─── Fidelity budget ──────────────────────────────────────────────────────────

export interface FidelityBudget {
  /** Hard cap for initial generation. null = use estimateMaxTokens() dynamically. */
  generateMaxTokens: number | null;
}

const FIDELITY_BUDGETS: Record<FidelityMode, FidelityBudget> = {
  minimal:  { generateMaxTokens: 8_000  },
  fast:     { generateMaxTokens: 12_000 },
  balanced: { generateMaxTokens: null   },
  high:     { generateMaxTokens: null   },
  maximal:  { generateMaxTokens: null   },
};

const OUTPUT_DIR = path.resolve(__dirname, "..", "output");

export interface GenerateOptions {
  name?: string;
  fidelity?: FidelityMode;
  baseline?: boolean;
  open?: boolean;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function urlSlug(url: string): string {
  try {
    const u = new URL(url);
    return slugify(u.hostname + u.pathname);
  } catch {
    return slugify(url);
  }
}

export function formatArchDoc(archDoc: VisualArchDoc): string {
  const sectionsText = archDoc.sections
    .map((s) => `  ${s.order}. slug: "${s.slug}" | role: ${s.role}\n     ${s.description}`)
    .join("\n");
  const fixedText =
    archDoc.fixedElements.length > 0 ? archDoc.fixedElements.join("; ") : "None";
  return `Background: ${archDoc.backgroundDescription}
Fixed/sticky elements: ${fixedText}
Sections (in visual order):
${sectionsText}`;
}

// ─── Parallel section pipeline helpers ───────────────────────────────────────

const SECTION_MAX_TOKENS = 8_000;

/**
 * Insert generated section fragments into the skeleton HTML.
 * Matches each fragment to its shell by data-section-slug and replaces
 * the shell's interior. Unmatched slugs are logged as warnings.
 */
export function assembleSkeleton(
  skeletonHtml: string,
  fragments: { slug: string; fragment: string }[],
): string {
  let html = skeletonHtml;
  const missing: string[] = [];
  for (const { slug, fragment } of fragments) {
    const escapedSlug = slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Match opening tag containing data-section-slug="<slug>", any interior, closing tag.
    // \2 backreference enforces the same tag name on the closing element.
    const re = new RegExp(
      `(<([a-zA-Z][a-zA-Z0-9]*)(?:[^>]*)data-section-slug="${escapedSlug}"(?:[^>]*)>)[\\s\\S]*?(<\\/\\2>)`,
    );
    const next = html.replace(re, `$1\n${fragment}\n$3`);
    if (next === html) {
      missing.push(slug);
    } else {
      html = next;
    }
  }
  if (missing.length > 0) {
    console.warn(`[assemble] No shell found for slug(s): ${missing.join(", ")}`);
  }
  return html;
}

/**
 * Generate the interior HTML fragment for a single section.
 * Runs independently so all section agents can execute in parallel —
 * every section is generated at output position zero, eliminating attention decay.
 */
/** Extract the :root CSS custom-property block from skeleton HTML (if present). */
function extractRootCssVars(html: string): string {
  const styleMatch = html.match(/<style[^>]*>([\s\S]*?)<\/style>/i);
  if (!styleMatch) return "";
  const rootMatch = styleMatch[1].match(/(:root\s*\{[^}]*\})/);
  return rootMatch ? rootMatch[1].trim() : "";
}

/**
 * Extract the opening tag of a section shell from the skeleton HTML.
 * Returns just the opening tag string, e.g. `<section class="bg-[#0a2540] py-24" data-section-slug="hero">`.
 */
function extractShellTag(skeletonHtml: string, slug: string): string | undefined {
  const escapedSlug = slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = skeletonHtml.match(
    new RegExp(`<[a-zA-Z][a-zA-Z0-9]*(?:[^>]*)data-section-slug="${escapedSlug}"(?:[^>]*)>`),
  );
  return match?.[0];
}

export async function generateSection(
  section: { slug: string; description: string; role: string; order: number; heightPx: number },
  neighborSlugs: { prev?: string; next?: string },
  screenshots: Buffer[],
  computedStyles: { selector: string; color: string; backgroundColor: string; fontSize: string; fontFamily: string }[],
  fontFamilies: string[],
  imageUrls: string[],
  url: string,
  cssVars?: string,
  shellContext?: { self: string; prev?: string; next?: string },
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

  const stylesJson = JSON.stringify(computedStyles, null, 2);
  const fontsText = fontFamilies.join(", ");
  const imageUrlsText = imageUrls.join("\n");

  type ContentBlock = Anthropic.TextBlockParam | Anthropic.ImageBlockParam;
  const contentBlocks: ContentBlock[] = [];

  for (const buf of screenshots) {
    const resized = await resizeForVlm(buf);
    contentBlocks.push({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: resized.toString("base64") },
    });
  }

  const shellContextBlock = shellContext
    ? `<shell_context>
Your section's shell element (already in the DOM — do NOT redeclare its tag, background, or padding):
${shellContext.self}${shellContext.prev ? `

Shell of the section immediately above yours:
${shellContext.prev}` : ""}${shellContext.next ? `

Shell of the section immediately below yours:
${shellContext.next}` : ""}
</shell_context>\n\n`
    : "";

  contentBlocks.push({
    type: "text",
    text: `The image(s) above show section "${section.slug}" (role: ${section.role}, position ${section.order}) from the source page.
Description: ${section.description}
Source section height: approximately ${section.heightPx}px at 1280px viewport width — match this vertical extent closely.

Your task: generate the interior HTML fragment for this section.

FRAGMENT RULES — strictly enforced:
- Output ONLY interior content (headings, paragraphs, images, buttons, layout divs)
- No <html>, <head>, <body>, <style>, or <script> tags
- No Tailwind config block, no font imports, no CSS custom property declarations
- Do NOT add a root semantic container (<section>, <footer>, <header>, <article>, <nav>, <main>) — the shell element in <shell_context> already provides that wrapper; start directly with interior content
- Do NOT redeclare background color, padding, or margin that is already set on your shell element
- Use Tailwind utility classes and the CSS custom properties defined in <skeleton_css_vars> below — do not hardcode hex colours that are already named tokens
- Use absolute image URLs from the list below so assets resolve correctly
- Faithfully reproduce the section's layout, typography, content, and visual style from the screenshot(s)

${shellContextBlock}${cssVars ? `<skeleton_css_vars>\n${cssVars}\n</skeleton_css_vars>\n\n` : ""}<computed_styles>
${stylesJson}
</computed_styles>

<fonts>
${fontsText}
</fonts>

<image_urls>
${imageUrlsText}
</image_urls>

Generate the fragment now using the save_section tool.`,
  });

  const sectionRunner = client.beta.messages.toolRunner({
    model: GENERATE_MODEL,
    max_tokens: SECTION_MAX_TOKENS,
    thinking: { type: "disabled" },
    tools: [saveSectionTool],
    tool_choice: { type: "tool", name: "save_section" },
    stream: true,
    max_iterations: 1,
    system: `You are an expert front-end developer generating interior content for a single section of a webpage.

You are Stage 2 of a parallel section generation pipeline:
- Stage 1 (Skeleton Agent): produced the HTML document shell with all global elements (head, fonts, CSS custom properties, Tailwind config, nav) and empty section shells with data-section-slug attributes.
- Stage 2 (YOU): fill in the interior content for one specific section.

Your output must be a self-contained HTML fragment ready for insertion into an empty section shell:
- Use Tailwind utility classes from the CDN
- Inherit CSS custom properties defined in the skeleton's :root block (do not redeclare them)
- No document-level wrappers — pure interior content only`,
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

async function runBaseline(
  url: string,
  outDir: string,
  truncatedHtml: string,
): Promise<{ savedPath: string | null; tokensIn: number; tokensOut: number; durationMs: number }> {
  fs.mkdirSync(outDir, { recursive: true });
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
      const outPath = path.join(outDir, input.filename);
      fs.writeFileSync(outPath, input.content, "utf-8");
      savedPath = outPath;
      return JSON.stringify({ success: true, file_path: outPath });
    },
  });

  const start = Date.now();
  const runner = client.beta.messages.toolRunner({
    model: BASELINE_MODEL,
    max_tokens: estimateMaxTokens(truncatedHtml.length, BASELINE_MODEL),
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
${truncatedHtml}
</source_html>`,
      },
    ],
  });

  const { tokensIn, tokensOut } = await renderStream(runner);
  return { savedPath, tokensIn, tokensOut, durationMs: Date.now() - start };
}

export async function generatePage(url: string, opts: GenerateOptions = {}): Promise<string | null> {
  const startedAt = Date.now();
  const runId = `${startedAt}-${opts.name ? slugify(opts.name) : urlSlug(url)}`;
  const runDir = path.join(OUTPUT_DIR, runId);
  const mainDir = path.join(runDir, "main");
  fs.mkdirSync(mainDir, { recursive: true });

  const recorder = new Recorder(runDir);
  const logger = new Logger(recorder);

  let savedPath: string | null = null;

  const crawlResult = await crawlAndPreprocess(url);
  const archDoc = crawlResult.visualArchDoc;

  const budget = FIDELITY_BUDGETS[opts.fidelity ?? "balanced"];
  const sectionCount = archDoc.sections.length;

  logger.log({
    phase: "fetch",
    timestamp: Date.now(),
    data: {
      url,
      htmlBytes: crawlResult.html.length,
      truncated: crawlResult.truncated,
      enriched: true,
      imageCount: crawlResult.imageUrls.length,
      fontCount: crawlResult.fontFamilies.length,
      sectionCount,
      fidelityMode: opts.fidelity ?? "balanced",
    },
  });

  const generateStart = Date.now();

  const stylesJson = JSON.stringify(crawlResult.computedStyles, null, 2);
  const fontsText = crawlResult.fontFamilies.join(", ");
  const imageUrlsText = crawlResult.imageUrls.join("\n");
  const svgsText = crawlResult.svgs.join("\n");
  const archDocText = formatArchDoc(archDoc);

  const slugList = archDoc.sections
    .map((s) => `  ${s.order}. "${s.slug}" (${s.role})`)
    .join("\n");

  // ── Stage 1: Skeleton Agent ──────────────────────────────────────────────
  // Produces global elements (head, fonts, CSS vars, Tailwind config, nav) +
  // empty labelled section shells — no interior content.
  console.log(`\n[gen] Stage 1 — skeleton (${GENERATE_MODEL})...`);
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

  // Whether any section shell already covers the page's primary navigation.
  // When true the skeleton must NOT also render a standalone global nav — the
  // section agent filling that shell will own it.  When false (e.g. the nav
  // is fixed/sticky and therefore NOT in the section list), the skeleton
  // should render it as a global fixed element from fixed_elements_html.
  const navIsSection = archDoc.sections.some(
    (s) => s.role === "navbar" || s.role === "header",
  );

  const screenshotBuf = Buffer.from(crawlResult.screenshotBase64, "base64");
  const resizedFullPage = await resizeForVlm(screenshotBuf);

  const skeletonRunner = client.beta.messages.toolRunner({
    model: GENERATE_MODEL,
    max_tokens:
      budget.generateMaxTokens ?? estimateMaxTokens(crawlResult.html.length, GENERATE_MODEL),
    thinking: { type: "disabled" },
    tools: [saveSkeletonTool],
    tool_choice: { type: "tool", name: "save_file" },
    stream: true,
    max_iterations: 1,
    system: `You are an expert front-end developer building a structural skeleton for a multi-agent page generation pipeline.

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

3. OUTPUT is a complete, valid, self-contained HTML file using Tailwind CSS via CDN.`,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/jpeg",
              data: resizedFullPage.toString("base64"),
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
${crawlResult.fixedElementsHtml.join("\n\n")}
</fixed_elements_html>

<source_html>
${crawlResult.html}
</source_html>

Produce the skeleton HTML now. Every section shell must have data-section-slug and data-section-order attributes. Section interiors must be completely empty.`,
          },
        ],
      },
    ],
  });

  const { tokensIn: skeletonIn, tokensOut: skeletonOut } = await renderStream(skeletonRunner);
  console.log(`[gen] Skeleton done — ${skeletonIn} in / ${skeletonOut} out tokens`);

  // ── Stage 2: Section Agents (parallel) ──────────────────────────────────
  // Each agent fills one section independently at output position zero —
  // eliminates attention decay from single-pass full-page generation.
  let sectionFragments: { slug: string; fragment: string }[] = [];
  let sectionTokensIn = 0;
  let sectionTokensOut = 0;

  if (skeletonHtml) {
    const skeleton = skeletonHtml;
    console.log(`\n[gen] Stage 2 — ${archDoc.sections.length} section agents (parallel)...`);
    const rootCssVars = extractRootCssVars(skeleton);
    const sectionResults = await Promise.all(
      archDoc.sections.map((section, i) => {
        const selfTag = extractShellTag(skeleton, section.slug);
        const prevTag = i > 0 ? extractShellTag(skeleton, archDoc.sections[i - 1].slug) : undefined;
        const nextTag = i < archDoc.sections.length - 1 ? extractShellTag(skeleton, archDoc.sections[i + 1].slug) : undefined;
        const shellContext = selfTag
          ? { self: selfTag, prev: prevTag, next: nextTag }
          : undefined;
        return generateSection(
          section,
          {
            prev: archDoc.sections[i - 1]?.slug,
            next: archDoc.sections[i + 1]?.slug,
          },
          crawlResult.sourceSectionScreenshots[section.slug] ?? [],
          crawlResult.computedStyles,
          crawlResult.fontFamilies,
          crawlResult.imageUrls,
          url,
          rootCssVars || undefined,
          shellContext,
        );
      }),
    );

    for (const r of sectionResults) {
      sectionFragments.push({ slug: r.slug, fragment: r.fragment });
      sectionTokensIn += r.tokensIn;
      sectionTokensOut += r.tokensOut;
    }
    console.log(
      `[gen] Sections done — ${sectionTokensIn} in / ${sectionTokensOut} out tokens (${sectionResults.length} agents)`,
    );

    // ── Stage 3: Programmatic Assembly ────────────────────────────────────
    console.log(`\n[gen] Stage 3 — assembling...`);
    const assembledHtml = assembleSkeleton(skeleton, sectionFragments);
    const assembledFilename = `${skeletonBasename ?? "page"}.html`;
    const assembledPath = path.join(mainDir, assembledFilename);
    fs.writeFileSync(assembledPath, assembledHtml, "utf-8");
    savedPath = assembledPath;
    console.log(`[gen] Assembled — ${assembledPath}`);
  }

  const generateDurationMs = Date.now() - generateStart;

  logger.log({
    phase: "generate",
    timestamp: Date.now(),
    data: {
      model: GENERATE_MODEL,
      tokensIn: skeletonIn + sectionTokensIn,
      tokensOut: skeletonOut + sectionTokensOut,
      durationMs: generateDurationMs,
      outputFile: savedPath ?? "",
    },
  });

  const generateTokensIn = skeletonIn + sectionTokensIn;
  const generateTokensOut = skeletonOut + sectionTokensOut;

  // ─── Run record ──────────────────────────────────────────────────────────────
  const record: RunRecord = {
    runId,
    ...(opts.name ? { name: opts.name } : {}),
    url,
    startedAt,
    completedAt: 0,
    iterations: [],
    estimatedCostUsd: 0,
  };

  // ─── Cost + record finalisation ─────────────────────────────────────────────
  record.completedAt = Date.now();
  record.estimatedCostUsd = estimateCost(GENERATE_MODEL, generateTokensIn, generateTokensOut);

  let baselineSavedPath: string | null = null;

  if (opts.baseline) {
    const baselineDir = path.join(runDir, "baseline");
    console.log("\n[baseline] Running baseline agent...");
    const bl = await runBaseline(url, baselineDir, crawlResult.html);
    baselineSavedPath = bl.savedPath;
    record.baseline = {
      baselineScore: 0,
      baselineCostUsd: estimateCost(BASELINE_MODEL, bl.tokensIn, bl.tokensOut),
      baselineDurationMs: bl.durationMs,
      baselineThumbnail: "",
      mainScore: 0,
      mainCostUsd: record.estimatedCostUsd,
      mainDurationMs: generateDurationMs,
      mainThumbnail: "",
    };
    console.log(`[baseline] Saved to ${bl.savedPath}`);
  }

  if (savedPath) {
    console.log("\n[fidelity] Computing final fidelity metrics...");
    try {
      const fidelity = await collectFidelityMetrics(
        { screenshotBase64: crawlResult.screenshotBase64, sectionScreenshots: crawlResult.sourceSectionScreenshots },
        archDoc,
        savedPath,
        baselineSavedPath ?? undefined,
      );
      record.fidelityMetrics = fidelity;
      if (record.baseline) {
        record.baseline.mainScore = fidelity.mainVlmScore.score;
        record.baseline.mainThumbnail = fidelity.mainScreenshotBase64;
        if (fidelity.baselineVlmScore) {
          record.baseline.baselineScore = fidelity.baselineVlmScore.score;
        }
        if (fidelity.baselineScreenshotBase64) {
          record.baseline.baselineThumbnail = fidelity.baselineScreenshotBase64;
        }
      }
    } catch (err) {
      console.error("[fidelity] Failed to collect fidelity metrics:", err);
    }
  }

  logger.finalize(record);
  generateReport(
    runDir,
    record,
    record.fidelityMetrics?.sourceScreenshotBase64,
  );

  return savedPath;
}

