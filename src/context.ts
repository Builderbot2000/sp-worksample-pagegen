import puppeteer from "puppeteer";

const VIEWPORT = { width: 1280, height: 900 };
const MAX_HTML_CHARS = 80_000;

export interface ComputedStyleEntry {
  selector: string;
  color: string;
  backgroundColor: string;
  fontSize: string;
  fontFamily: string;
}

export interface EnrichedContext {
  html: string;
  truncated: boolean;
  screenshotBase64: string;
  computedStyles: ComputedStyleEntry[];
  imageUrls: string[];
  fontFamilies: string[];
  svgs: string[];
}

export async function enrichContext(url: string): Promise<EnrichedContext> {
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport(VIEWPORT);

    await page.goto(url, {
      waitUntil: "networkidle2",
      timeout: 30_000,
    });

    // Screenshot
    const screenshotBuffer = await page.screenshot({
      type: "png",
      clip: { x: 0, y: 0, ...VIEWPORT },
    });
    const screenshotBase64 = Buffer.from(screenshotBuffer).toString("base64");

    // HTML
    const rawHtml = await page.content();
    const truncated = rawHtml.length > MAX_HTML_CHARS;
    const html = truncated
      ? rawHtml.slice(0, MAX_HTML_CHARS) + "\n<!-- truncated -->"
      : rawHtml;

    // Extract context via a single evaluate call
    const extracted = await page.evaluate(() => {
      // ── Image URLs ────────────────────────────────────────────────────────
      const imgUrls: string[] = Array.from(document.querySelectorAll("img[src]"))
        .map((el) => (el as HTMLImageElement).src)
        .filter((src) => src.startsWith("http"));

      // background-image urls from inline styles
      document.querySelectorAll("[style]").forEach((el) => {
        const bg = (el as HTMLElement).style.backgroundImage;
        const match = bg?.match(/url\(["']?(https?[^"')]+)/);
        if (match) imgUrls.push(match[1]);
      });

      const uniqueImageUrls = Array.from(new Set(imgUrls)).slice(0, 30);

      // ── Font families ─────────────────────────────────────────────────────
      const fontSelectors = [
        "body",
        "h1",
        "h2",
        "h3",
        "nav",
        "footer",
        "header",
        "p",
        "button",
        "a",
      ];
      const rawFamilies = fontSelectors
        .map((sel) => {
          const el = document.querySelector(sel);
          if (!el) return null;
          return getComputedStyle(el).fontFamily.split(",")[0].replace(/['"]/g, "").trim();
        })
        .filter((f): f is string => Boolean(f));
      const uniqueFontFamilies = Array.from(new Set(rawFamilies)).slice(0, 10);

      // ── Computed styles ───────────────────────────────────────────────────
      const styleTargets: Array<{ sel: string; label: string }> = [
        { sel: "body", label: "body" },
        { sel: "h1", label: "h1" },
        { sel: "h2", label: "h2" },
        { sel: "h3", label: "h3" },
        { sel: "nav", label: "nav" },
        {
          sel: 'button,[role="button"],[type="submit"],[type="button"]',
          label: "primary-cta",
        },
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

      // ── SVGs ──────────────────────────────────────────────────────────────
      const svgs = Array.from(document.querySelectorAll("svg"))
        .slice(0, 5)
        .map((s) => s.outerHTML);

      return { uniqueImageUrls, uniqueFontFamilies, computedStyles, svgs };
    });

    return {
      html,
      truncated,
      screenshotBase64,
      computedStyles: extracted.computedStyles,
      imageUrls: extracted.uniqueImageUrls,
      fontFamilies: extracted.uniqueFontFamilies,
      svgs: extracted.svgs,
    };
  } finally {
    await browser.close();
  }
}
