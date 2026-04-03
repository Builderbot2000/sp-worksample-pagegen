import puppeteer from "puppeteer";
import { PNG } from "pngjs";
import type { VisualArchDoc, SectionSpec } from "./observability/types";

function stitchVertically(buffers: Buffer[]): Buffer {
  if (buffers.length === 1) return buffers[0];
  const pngs = buffers.map((b) => PNG.sync.read(b));
  const width = pngs[0].width;
  const totalHeight = pngs.reduce((sum, p) => sum + p.height, 0);
  const out = new PNG({ width, height: totalHeight });
  let yOffset = 0;
  for (const p of pngs) {
    PNG.bitblt(p, out, 0, 0, width, p.height, 0, yOffset);
    yOffset += p.height;
  }
  return PNG.sync.write(out);
}

const VIEWPORT = { width: 1280, height: 900 };
const MAX_HTML_CHARS = 80_000;
const MAX_SCREENSHOT_HEIGHT = 7800;
// ~150% of viewport height — sections taller than this get two screenshots
const SECTION_TALL_THRESHOLD = 1350;
// Hard cap on detected sections
const MAX_SECTIONS = 20;


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
  /** outerHTML of top-level fixed/sticky elements, truncated to 3 KB each. */
  fixedElementsHtml: string[];
}

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

      // Helper methods use object method shorthand to avoid esbuild __name injection
      // (which would reference a Node-side helper that doesn't exist in the browser).
      const h = {
        isFixedOrSticky(el: Element): boolean {
          const pos = getComputedStyle(el).position;
          return pos === "fixed" || pos === "sticky";
        },

        deriveSlugCandidate(el: Element, order: number): string {
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
          const heading = el.querySelector("h1,h2,h3,h4,h5,h6");
          if (heading?.textContent) {
            const s = heading.textContent.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50);
            if (s) return s;
          }
          return `${tag}-${order}`;
        },

        collectFromList(
          list: Element[],
        ): Array<{ tag: string; slugCandidate: string; role: string; description: string; y: number; height: number }> {
          const results: Array<{ tag: string; slugCandidate: string; role: string; description: string; y: number; height: number }> = [];
          let order = 1;
          for (const el of list) {
            if (h.isFixedOrSticky(el)) continue;
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
              ).filter((c) => !h.isFixedOrSticky(c));
              if (directSemanticChildren.length > 0) {
                results.push(...h.collectFromList(directSemanticChildren));
                continue;
              }
            }

            // ── Role inference ────────────────────────────────────────────────
            const tag = el.tagName.toLowerCase();
            const ariaRole = el.getAttribute("role") ?? "";
            const classList = Array.from(el.classList).join(" ").toLowerCase();
            const idLower = (el.id ?? "").toLowerCase();
            const combinedHint = `${tag} ${ariaRole} ${classList} ${idLower}`;

            let role = tag;
            if (tag === "nav" || /\bnav(bar|igation)?\b/.test(combinedHint)) role = "navbar";
            else if (tag === "header" || /\bheader\b/.test(combinedHint)) role = "header";
            else if (tag === "footer" || /\bfooter\b/.test(combinedHint)) role = "footer";
            else if (/\bhero\b/.test(combinedHint)) role = "hero";
            else if (/\bpric(e|ing)\b/.test(combinedHint)) role = "pricing";
            else if (/\bfeature(s)?\b/.test(combinedHint)) role = "features";
            else if (/\btestimoni(al|als|es)\b/.test(combinedHint)) role = "testimonials";
            else if (/\bfaq\b/.test(combinedHint)) role = "faq";
            else if (/\bcta\b|\bcall.to.action\b/.test(combinedHint)) role = "cta";
            else if (/\bcontact\b/.test(combinedHint)) role = "contact";
            else if (/\bteam\b/.test(combinedHint)) role = "team";
            else if (/\bblog\b|\barticle\b/.test(combinedHint)) role = "blog";
            else if (/\bgaller(y|ies)\b/.test(combinedHint)) role = "gallery";
            else if (/\bbanner\b/.test(combinedHint)) role = "banner";

            // ── Description from heading + lead text ─────────────────────────
            const headingEl = el.querySelector("h1,h2,h3,h4,h5,h6");
            const headingText = headingEl?.textContent?.trim().slice(0, 120) ?? "";
            const paraEl = el.querySelector("p");
            const paraText = paraEl?.textContent?.trim().slice(0, 160) ?? "";
            const description = headingText
              ? paraText
                ? `${headingText} — ${paraText}`
                : headingText
              : paraText || `${role} section`;

            results.push({
              tag,
              slugCandidate: h.deriveSlugCandidate(el, order),
              role,
              description,
              y,
              height,
            });
            order++;
          }
          return results;
        },
      };

      // Top-level semantic elements: those without a semantic ancestor
      const allSemantic = Array.from(document.querySelectorAll(SEMANTIC));
      const topLevel = allSemantic.filter((el) => !el.parentElement?.closest(SEMANTIC));
      const seed = topLevel.length > 0 ? topLevel : allSemantic;
      return h.collectFromList(seed).sort((a, b) => a.y - b.y);
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
      const crops: Buffer[] = [];
      const clipY = Math.max(0, Math.min(sec.y, scrollHeight - VIEWPORT.height));
      const buf1 = await page.screenshot({
        type: "png",
        clip: { x: 0, y: clipY, width: VIEWPORT.width, height: VIEWPORT.height },
      });
      crops.push(Buffer.from(buf1));

      if (sec.height > SECTION_TALL_THRESHOLD) {
        const clipY2 = Math.max(
          0,
          Math.min(sec.y + VIEWPORT.height, scrollHeight - VIEWPORT.height),
        );
        const buf2 = await page.screenshot({
          type: "png",
          clip: { x: 0, y: clipY2, width: VIEWPORT.width, height: VIEWPORT.height },
        });
        crops.push(Buffer.from(buf2));
      }
      sourceSectionScreenshots[sec.slug] = [stitchVertically(crops)];
    }

    // ── Fixed/sticky elements for the arch doc ────────────────────────────────
    const fixedElements = await page.evaluate(() => {
      return Array.from(document.querySelectorAll("*"))
        .filter((el) => {
          const pos = getComputedStyle(el).position;
          return pos === "fixed" || pos === "sticky";
        })
        .slice(0, 10)
        .map((el) => {
          const tag = el.tagName.toLowerCase();
          const role = el.getAttribute("role") ?? "";
          const label = el.getAttribute("aria-label") ?? "";
          const heading = el.querySelector("h1,h2,h3,h4,h5,h6")?.textContent?.trim().slice(0, 60) ?? "";
          const hint = label || heading || el.id || Array.from(el.classList).slice(0, 3).join(" ");
          return `${tag}${role ? `[role=${role}]` : ""}${hint ? ` — ${hint}` : ""}`;
        });
    });

    // ── outerHTML of top-level fixed/sticky elements ──────────────────────────
    // Only elements whose initial bounding rect starts within the viewport
    // (top < VIEWPORT.height) are considered global — mid-page sticky elements
    // that only appear on scroll belong inside sections, not the global shell.
    const fixedElementsHtml = await page.evaluate((viewportHeight: number) => {
      const MAX_CHARS = 3000;
      const all = Array.from(document.querySelectorAll("*")).filter((el) => {
        const pos = getComputedStyle(el).position;
        return pos === "fixed" || pos === "sticky";
      });
      // Keep only top-level (parent not also fixed/sticky)
      const topLevel = all.filter((el) => {
        const parent = el.parentElement;
        if (!parent) return true;
        const parentPos = getComputedStyle(parent).position;
        return parentPos !== "fixed" && parentPos !== "sticky";
      });
      // Filter to elements visible at page load (initial rect top within viewport)
      const initialViewport = topLevel.filter((el) => {
        const rect = el.getBoundingClientRect();
        return rect.top < viewportHeight;
      });
      return initialViewport.slice(0, 5).map((el) => {
        const h = el.outerHTML;
        return h.length > MAX_CHARS ? h.slice(0, MAX_CHARS) + "<!-- truncated -->" : h;
      });
    }, VIEWPORT.height);

    // ── Build arch doc from DOM data ──────────────────────────────────────────
    const archDocSections: SectionSpec[] = dedupedSections.map((s, i) => ({
      slug: s.slug,
      description: s.description,
      role: s.role,
      order: i + 1,
    }));

    return {
      html,
      truncated,
      screenshotBase64,
      scrollHeight,
      computedStyles: extracted.computedStyles,
      imageUrls: extracted.uniqueImageUrls,
      fontFamilies: extracted.uniqueFontFamilies,
      svgs: extracted.svgs,
      visualArchDoc: { sections: archDocSections, fixedElements, backgroundDescription: "" },
      sourceSectionScreenshots,
      fixedElementsHtml,
    };
  } finally {
    await browser.close();
  }
}
