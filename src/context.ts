import puppeteer from "puppeteer";

const STYLE_SELECTORS = [
  "body",
  "h1",
  "h2",
  "h3",
  "h4",
  "p",
  "nav",
  "header",
  "footer",
  "main",
  "section",
  "article",
  "button",
  "a",
] as const;

const STYLE_PROPERTIES = [
  "color",
  "background-color",
  "font-family",
  "font-size",
  "font-weight",
  "padding",
  "margin",
  "line-height",
  "letter-spacing",
  "display",
  "grid-template-columns",
  "flex-direction",
  "flex-wrap",
  "gap",
  "max-width",
] as const;

const GENERIC_FONT_FAMILIES = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-serif",
  "ui-sans-serif",
  "ui-monospace",
  "ui-rounded",
  "math",
  "emoji",
  "fangsong",
]);

const MAX_HTML_CHARS = 80_000;
const MAX_SECTION_HTML_CHARS = 40_000;

export type ComputedStyles = Record<string, Record<string, string>>;

export interface PageSection {
  id: string;
  html: string;
  screenshotChunks: string[];
  top: number;
  height: number;
}

export interface EnrichedContext {
  html: string;
  screenshotChunks: string[];
  computedStyles: ComputedStyles;
  absoluteImageUrls: string[];
  fontFamilies: string[];
  inlineSvgs: string[];
  sections: PageSection[];
}

interface RawSection {
  selector: string;
  outerHTML: string;
  top: number;
  height: number;
}

async function extractPageSections(
  page: Awaited<ReturnType<Awaited<ReturnType<typeof puppeteer.launch>>["newPage"]>>,
): Promise<PageSection[]> {
  await page.evaluate(() => window.scrollTo(0, 0));

  const rawSections: RawSection[] = await page.evaluate(() => {
    const MIN_HEIGHT = 80;
    const MAX_SECTIONS = 20;
    const results: { selector: string; outerHTML: string; top: number; height: number }[] = [];

    // Header
    const header = document.querySelector("header");
    if (header) {
      const rect = header.getBoundingClientRect();
      const top = rect.top + window.scrollY;
      const height = (header as HTMLElement).scrollHeight || rect.height;
      if (height >= MIN_HEIGHT) results.push({ selector: "header", outerHTML: header.outerHTML, top, height });
    }

    // Nav only if not inside header
    const nav = document.querySelector("nav");
    if (nav && !header?.contains(nav)) {
      const rect = nav.getBoundingClientRect();
      const top = rect.top + window.scrollY;
      const height = (nav as HTMLElement).scrollHeight || rect.height;
      if (height >= MIN_HEIGHT) results.push({ selector: "nav", outerHTML: nav.outerHTML, top, height });
    }

    // Main children, or fallback top-level landmark elements
    const main = document.querySelector("main");
    if (main) {
      let added = 0;
      for (const child of Array.from(main.children)) {
        if (added >= MAX_SECTIONS) break;
        const rect = child.getBoundingClientRect();
        const height = (child as HTMLElement).scrollHeight || rect.height;
        if (height >= MIN_HEIGHT) {
          const top = rect.top + window.scrollY;
          results.push({ selector: "main > *", outerHTML: child.outerHTML, top, height });
          added++;
        }
      }
    } else {
      const candidates = Array.from(
        document.querySelectorAll("body > section, body > article, body > div[class]"),
      );
      const filtered = candidates.filter(
        (el) => !candidates.some((other) => other !== el && other.contains(el)),
      );
      for (const el of filtered.slice(0, MAX_SECTIONS)) {
        const rect = el.getBoundingClientRect();
        const top = rect.top + window.scrollY;
        const height = (el as HTMLElement).scrollHeight || rect.height;
        if (height >= MIN_HEIGHT) results.push({ selector: "body > *", outerHTML: el.outerHTML, top, height });
      }
    }

    // Footer
    const footer = document.querySelector("footer");
    if (footer) {
      const rect = footer.getBoundingClientRect();
      const top = rect.top + window.scrollY;
      const height = (footer as HTMLElement).scrollHeight || rect.height;
      if (height >= MIN_HEIGHT) results.push({ selector: "footer", outerHTML: footer.outerHTML, top, height });
    }

    results.sort((a, b) => a.top - b.top);
    return results;
  });

  if (rawSections.length < 2) return [];

  const sections: PageSection[] = [];
  for (let i = 0; i < rawSections.length; i++) {
    const raw = rawSections[i];
    const id = `section-${i + 1}`;
    const html =
      raw.outerHTML.length > MAX_SECTION_HTML_CHARS
        ? raw.outerHTML.slice(0, MAX_SECTION_HTML_CHARS) + "<!-- truncated -->"
        : raw.outerHTML;

    // Screenshot up to 3 chunks of 900px each, using page coordinates (no scroll needed)
    const MAX_SECTION_CHUNKS = 3;
    const chunkH = 900;
    const numChunks = Math.min(MAX_SECTION_CHUNKS, Math.ceil(raw.height / chunkH));
    const screenshotChunks: string[] = [];
    for (let c = 0; c < numChunks; c++) {
      const yOffset = Math.round(raw.top) + c * chunkH;
      const chunkHeight = Math.min(chunkH, Math.round(raw.top + raw.height) - yOffset);
      if (chunkHeight <= 0) break;
      const chunk = await page.screenshot({
        encoding: "base64",
        clip: { x: 0, y: yOffset, width: 1440, height: chunkHeight },
      });
      screenshotChunks.push(chunk);
    }

    sections.push({ id, html, screenshotChunks, top: raw.top, height: raw.height });
  }

  return sections;
}

export async function enrichContext(url: string): Promise<EnrichedContext> {
  const browser = await puppeteer.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    await page.goto(url, { waitUntil: "networkidle2" });

    // Viewport-sized screenshot chunks (1440×900 each, max 5 chunks)
    const pageHeight = await page.evaluate(
      () => document.documentElement.scrollHeight,
    );
    const chunkHeight = 900;
    const maxChunks = 5;
    const numChunks = Math.min(maxChunks, Math.ceil(pageHeight / chunkHeight));
    const screenshotChunks: string[] = [];
    for (let i = 0; i < numChunks; i++) {
      const yOffset = i * chunkHeight;
      const height = Math.min(chunkHeight, pageHeight - yOffset);
      const chunk = await page.screenshot({
        encoding: "base64",
        clip: { x: 0, y: yOffset, width: 1440, height },
      });
      screenshotChunks.push(chunk);
    }

    // Page HTML, truncated if needed
    const rawHtml = await page.content();
    const html =
      rawHtml.length > MAX_HTML_CHARS
        ? rawHtml.slice(0, MAX_HTML_CHARS) + "\n<!-- truncated -->"
        : rawHtml;

    // Computed styles for key selectors
    const computedStyles: ComputedStyles = await page.evaluate(
      (selectors, properties) => {
        const result: Record<string, Record<string, string>> = {};
        for (const selector of selectors) {
          const el = document.querySelector(selector);
          if (!el) continue;
          const styles = window.getComputedStyle(el);
          const props: Record<string, string> = {};
          for (const prop of properties) {
            const value = styles.getPropertyValue(prop);
            if (value) props[prop] = value;
          }
          if (Object.keys(props).length > 0) result[selector] = props;
        }
        return result;
      },
      [...STYLE_SELECTORS],
      [...STYLE_PROPERTIES],
    );

    // Absolute image URLs
    const absoluteImageUrls: string[] = await page.evaluate(() => {
      const imgs = Array.from(document.querySelectorAll("img"));
      const seen = new Set<string>();
      const urls: string[] = [];
      for (const img of imgs) {
        const src = img.src;
        if (src && src.startsWith("http") && !seen.has(src)) {
          seen.add(src);
          urls.push(src);
        }
      }
      return urls;
    });

    // Inline SVGs — top-level only (not nested inside another SVG), capped at 20 KB each
    const MAX_SVG_BYTES = 20_000;
    const MAX_SVG_COUNT = 15;
    const inlineSvgs: string[] = await page.evaluate(
      (maxBytes: number, maxCount: number) => {
        // 'body svg:not(svg svg)' selects SVG elements that are NOT descendants of another SVG
        const svgEls = Array.from(
          document.querySelectorAll("body svg:not(svg svg)"),
        ) as SVGElement[];
        const results: string[] = [];
        for (const el of svgEls) {
          if (results.length >= maxCount) break;
          const markup = el.outerHTML;
          if (markup.length <= maxBytes) results.push(markup);
        }
        return results;
      },
      MAX_SVG_BYTES,
      MAX_SVG_COUNT,
    );

    // Derive font families from computed styles
    const fontFamilies = deriveFontFamilies(computedStyles);

    // Semantic section segmentation
    const sections = await extractPageSections(page);

    return { html, screenshotChunks, computedStyles, absoluteImageUrls, fontFamilies, inlineSvgs, sections };
  } finally {
    await browser.close();
  }
}

function deriveFontFamilies(computedStyles: ComputedStyles): string[] {
  const seen = new Set<string>();
  const families: string[] = [];

  for (const props of Object.values(computedStyles)) {
    const fontFamily = props["font-family"];
    if (!fontFamily) continue;
    // Each font-family value is a comma-separated list; take the first token
    const first = fontFamily.split(",")[0].trim().replace(/['"]/g, "");
    if (first && !GENERIC_FONT_FAMILIES.has(first.toLowerCase()) && !seen.has(first)) {
      seen.add(first);
      families.push(first);
    }
  }

  return families;
}
