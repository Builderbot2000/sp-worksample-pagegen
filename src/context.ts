import puppeteer from "puppeteer";
import Anthropic from "@anthropic-ai/sdk";
import type { VisualArchDoc, SectionSpec } from "./observability/types";

const VIEWPORT = { width: 1280, height: 900 };
const MAX_HTML_CHARS = 80_000;
const MAX_SCREENSHOT_HEIGHT = 7800;
// ~150% of viewport height — sections taller than this get two screenshots
const SECTION_TALL_THRESHOLD = 1350;
// Hard cap on sections passed to the VLM arch-doc call
const MAX_SECTIONS = 20;

const client = new Anthropic();

export interface ComputedStyleEntry {
  selector: string;
  color: string;
  backgroundColor: string;
  fontSize: string;
  fontFamily: string;
}

export interface CrawlResult {
  html: string;
  truncated: boolean;
  screenshotBase64: string;
  scrollHeight: number;
  computedStyles: ComputedStyleEntry[];
  imageUrls: string[];
  fontFamilies: string[];
  svgs: string[];
  visualArchDoc: VisualArchDoc;
  sourceSectionScreenshots: Record<string, Buffer[]>;
}

// ─── VLM system prompt for architecture doc ───────────────────────────────────

const ARCH_DOC_SYSTEM = `You are a web page visual architect. You will be shown a full-page screenshot followed by per-section screenshots with their slug candidates derived from the DOM.

Your task is to enrich the visual architecture document with descriptions and roles.

Respond with ONLY a JSON object — no prose, no markdown fences:
{
  "fixedElements": ["<description of each fixed or sticky UI element visible across the page>"],
  "backgroundDescription": "<overall background color scheme and any global decorative patterns>",
  "sections": [
    {
      "slug": "<use the provided slug candidate; improve it only if it is generic like 'section-1' or 'div-3'>",
      "description": "<detailed description of the section's visual content and layout>",
      "role": "<functional role, e.g. hero, navbar, pricing, testimonials, cta, features, footer>"
    }
  ]
}

Preserve slug candidates exactly unless they are clearly non-descriptive. Sections must appear in the same order as presented.`;

// ─── Main crawl function ──────────────────────────────────────────────────────

export async function crawlAndPreprocess(url: string): Promise<CrawlResult> {
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport(VIEWPORT);
    await page.goto(url, { waitUntil: "networkidle2", timeout: 30_000 });

    // ── Full-page screenshot ─────────────────────────────────────────────────
    const scrollHeight = await page.evaluate(() => document.documentElement.scrollHeight);
    const captureHeight = Math.min(scrollHeight, MAX_SCREENSHOT_HEIGHT);
    const screenshotBuf = await page.screenshot({
      type: "png",
      clip: { x: 0, y: 0, width: VIEWPORT.width, height: captureHeight },
    });
    const screenshotBase64 = Buffer.from(screenshotBuf).toString("base64");

    // ── HTML ─────────────────────────────────────────────────────────────────
    const rawHtml = await page.content();
    const truncated = rawHtml.length > MAX_HTML_CHARS;
    const html = truncated
      ? rawHtml.slice(0, MAX_HTML_CHARS) + "\n<!-- truncated -->"
      : rawHtml;

    // ── Assets (images, fonts, styles, SVGs) ─────────────────────────────────
    const extracted = await page.evaluate(() => {
      const imgUrls: string[] = Array.from(document.querySelectorAll("img[src]"))
        .map((el) => (el as HTMLImageElement).src)
        .filter((src) => src.startsWith("http"));
      document.querySelectorAll("[style]").forEach((el) => {
        const bg = (el as HTMLElement).style.backgroundImage;
        const match = bg?.match(/url\(["']?(https?[^"')]+)/);
        if (match) imgUrls.push(match[1]);
      });
      const uniqueImageUrls = Array.from(new Set(imgUrls)).slice(0, 30);

      const fontSelectors = ["body", "h1", "h2", "h3", "nav", "footer", "header", "p", "button", "a"];
      const rawFamilies = fontSelectors
        .map((sel) => {
          const el = document.querySelector(sel);
          if (!el) return null;
          return getComputedStyle(el).fontFamily.split(",")[0].replace(/['"]/g, "").trim();
        })
        .filter((f): f is string => Boolean(f));
      const uniqueFontFamilies = Array.from(new Set(rawFamilies)).slice(0, 10);

      const styleTargets: Array<{ sel: string; label: string }> = [
        { sel: "body", label: "body" },
        { sel: "h1", label: "h1" },
        { sel: "h2", label: "h2" },
        { sel: "h3", label: "h3" },
        { sel: "nav", label: "nav" },
        { sel: 'button,[role="button"],[type="submit"],[type="button"]', label: "primary-cta" },
      ];
      const computedStyles = styleTargets
        .map(({ sel, label }) => {
          const el = document.querySelector(sel);
          if (!el) return null;
          const cs = getComputedStyle(el);
          return {
            selector: label,
            color: cs.color,
            backgroundColor: cs.backgroundColor,
            fontSize: cs.fontSize,
            fontFamily: cs.fontFamily.split(",")[0].replace(/['"]/g, "").trim(),
          };
        })
        .filter((s): s is NonNullable<typeof s> => s !== null);

      const svgs = Array.from(document.querySelectorAll("svg")).slice(0, 5).map((s) => s.outerHTML);

      return { uniqueImageUrls, uniqueFontFamilies, computedStyles, svgs };
    });

    // ── Bounding box detection ────────────────────────────────────────────────
    // Runs entirely inside the browser context; SECTION_TALL_THRESHOLD passed
    // as a parameter since page.evaluate cannot close over Node variables.
    const rawSections = await page.evaluate((tallThreshold: number) => {
      const SEMANTIC = "section, article, main, header, footer, nav";

      function isFixedOrSticky(el: Element): boolean {
        const pos = getComputedStyle(el).position;
        return pos === "fixed" || pos === "sticky";
      }

      function deriveSlugCandidate(el: Element, order: number): string {
        const tag = el.tagName.toLowerCase();
        if (el.id) {
          const s = el.id.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50);
          if (s) return s;
        }
        const aria = el.getAttribute("aria-label");
        if (aria) {
          const s = aria.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50);
          if (s) return s;
        }
        const h = el.querySelector("h1,h2,h3,h4,h5,h6");
        if (h?.textContent) {
          const s = h.textContent.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50);
          if (s) return s;
        }
        return `${tag}-${order}`;
      }

      function collectFromList(
        list: Element[],
      ): Array<{ tag: string; slugCandidate: string; y: number; height: number }> {
        const results: Array<{ tag: string; slugCandidate: string; y: number; height: number }> = [];
        let order = 1;
        for (const el of list) {
          if (isFixedOrSticky(el)) continue;
          const rect = el.getBoundingClientRect();
          const y = rect.top + window.scrollY;
          const height = rect.height;
          if (height < 50) continue;

          if (height > tallThreshold) {
            // Recursive descent: find direct semantic children (non-fixed/sticky)
            const directSemanticChildren = Array.from(
              el.querySelectorAll(
                ":scope > section, :scope > article, :scope > main, :scope > header, :scope > footer, :scope > nav",
              ),
            ).filter((c) => !isFixedOrSticky(c));
            if (directSemanticChildren.length > 0) {
              results.push(...collectFromList(directSemanticChildren));
              continue;
            }
          }

          results.push({
            tag: el.tagName.toLowerCase(),
            slugCandidate: deriveSlugCandidate(el, order),
            y,
            height,
          });
          order++;
        }
        return results;
      }

      // Top-level semantic elements: those without a semantic ancestor
      const allSemantic = Array.from(document.querySelectorAll(SEMANTIC));
      const topLevel = allSemantic.filter((el) => !el.parentElement?.closest(SEMANTIC));
      const seed = topLevel.length > 0 ? topLevel : allSemantic;
      return collectFromList(seed).sort((a, b) => a.y - b.y);
    }, SECTION_TALL_THRESHOLD);

    // ── Deduplicate slugs and cap at MAX_SECTIONS ─────────────────────────────
    const seenSlugs = new Map<string, number>();
    const dedupedSections = rawSections.slice(0, MAX_SECTIONS).map((s) => {
      let slug = s.slugCandidate;
      const count = seenSlugs.get(slug) ?? 0;
      if (count > 0) slug = `${slug}-${count + 1}`;
      seenSlugs.set(s.slugCandidate, (seenSlugs.get(s.slugCandidate) ?? 0) + 1);
      return { ...s, slug };
    });

    // ── Screenshot each section ───────────────────────────────────────────────
    const sourceSectionScreenshots: Record<string, Buffer[]> = {};
    for (const sec of dedupedSections) {
      const screenshots: Buffer[] = [];
      const clipY = Math.max(0, Math.min(sec.y, scrollHeight - VIEWPORT.height));
      const buf1 = await page.screenshot({
        type: "png",
        clip: { x: 0, y: clipY, width: VIEWPORT.width, height: VIEWPORT.height },
      });
      screenshots.push(Buffer.from(buf1));

      if (sec.height > SECTION_TALL_THRESHOLD) {
        const clipY2 = Math.max(
          0,
          Math.min(sec.y + VIEWPORT.height, scrollHeight - VIEWPORT.height),
        );
        const buf2 = await page.screenshot({
          type: "png",
          clip: { x: 0, y: clipY2, width: VIEWPORT.width, height: VIEWPORT.height },
        });
        screenshots.push(Buffer.from(buf2));
      }
      sourceSectionScreenshots[sec.slug] = screenshots;
    }

    // ── VLM: enrich arch doc with descriptions and roles ─────────────────────
    const userContent: Anthropic.MessageParam["content"] = [
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: screenshotBase64 },
      },
      { type: "text", text: "Full-page screenshot above. Now reviewing per-section screenshots:" },
    ];

    for (let i = 0; i < dedupedSections.length; i++) {
      const sec = dedupedSections[i];
      const imgs = sourceSectionScreenshots[sec.slug];
      if (!imgs || imgs.length === 0) continue;
      for (const buf of imgs) {
        userContent.push({
          type: "image",
          source: { type: "base64", media_type: "image/png", data: buf.toString("base64") },
        });
      }
      userContent.push({
        type: "text",
        text: `Section ${i + 1}: slug candidate "${sec.slug}" (${sec.tag}) — screenshot(s) above.`,
      });
    }
    userContent.push({
      type: "text",
      text: `Produce the visual architecture document for these ${dedupedSections.length} sections. Respond with JSON only.`,
    });

    // Fallback arch doc built from DOM data alone
    let archDocSections: SectionSpec[] = dedupedSections.map((s, i) => ({
      slug: s.slug,
      description: "",
      role: s.tag,
      order: i + 1,
    }));
    let fixedElements: string[] = [];
    let backgroundDescription = "";

    try {
      const archResponse = await client.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 2048,
        system: ARCH_DOC_SYSTEM,
        messages: [{ role: "user", content: userContent }],
      });

      const text = archResponse.content.find((b) => b.type === "text")?.text ?? "";
      const cleaned = text.replace(/^```[^\n]*\n?|```$/gm, "").trim();
      const parsed = JSON.parse(cleaned) as {
        fixedElements?: unknown;
        backgroundDescription?: unknown;
        sections?: Array<{ slug?: unknown; description?: unknown; role?: unknown }>;
      };

      if (Array.isArray(parsed.fixedElements)) {
        fixedElements = (parsed.fixedElements as unknown[]).filter(
          (s): s is string => typeof s === "string",
        );
      }
      if (typeof parsed.backgroundDescription === "string") {
        backgroundDescription = parsed.backgroundDescription;
      }
      if (Array.isArray(parsed.sections)) {
        archDocSections = dedupedSections.map((s, i) => {
          const vlmSection = (
            parsed.sections as Array<{ slug?: unknown; description?: unknown; role?: unknown }>
          )[i];
          return {
            slug:
              typeof vlmSection?.slug === "string" && vlmSection.slug.trim()
                ? vlmSection.slug.trim()
                : s.slug,
            description:
              typeof vlmSection?.description === "string" ? vlmSection.description : "",
            role: typeof vlmSection?.role === "string" ? vlmSection.role : s.tag,
            order: i + 1,
          };
        });
      }
    } catch {
      // VLM failed — fall back to DOM-derived info only
    }

    // Re-key screenshots to final (VLM-possibly-updated) slugs
    const finalSectionScreenshots: Record<string, Buffer[]> = {};
    for (let i = 0; i < dedupedSections.length; i++) {
      const originalSlug = dedupedSections[i].slug;
      const finalSlug = archDocSections[i]?.slug ?? originalSlug;
      const imgs = sourceSectionScreenshots[originalSlug];
      if (imgs) finalSectionScreenshots[finalSlug] = imgs;
    }

    return {
      html,
      truncated,
      screenshotBase64,
      scrollHeight,
      computedStyles: extracted.computedStyles,
      imageUrls: extracted.uniqueImageUrls,
      fontFamilies: extracted.uniqueFontFamilies,
      svgs: extracted.svgs,
      visualArchDoc: { sections: archDocSections, fixedElements, backgroundDescription },
      sourceSectionScreenshots: finalSectionScreenshots,
    };
  } finally {
    await browser.close();
  }
}
