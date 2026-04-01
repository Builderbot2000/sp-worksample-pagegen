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

export type ComputedStyles = Record<string, Record<string, string>>;

export interface EnrichedContext {
  html: string;
  screenshotChunks: string[];
  computedStyles: ComputedStyles;
  absoluteImageUrls: string[];
  fontFamilies: string[];
  inlineSvgs: string[];
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

    return { html, screenshotChunks, computedStyles, absoluteImageUrls, fontFamilies, inlineSvgs };
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
