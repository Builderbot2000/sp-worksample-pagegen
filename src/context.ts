import puppeteer from "puppeteer";
import type { DomInfo } from "./observability/types";
import { CHUNK_HARD_CAP } from "./observability/fidelity";

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
  screenshotFoldBase64: string;
  screenshotWideBase64: string;
  scrollHeight: number;
  screenshotChunksBase64: Array<{ heading: string; screenshot: string }>;
  domInfo: DomInfo;
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

    // Anthropic image API limit: 8000px per dimension. Cap height to stay safe.
    const MAX_SCREENSHOT_HEIGHT = 7800;

    // First-fold clip (1280×900) — used as VLM scoring reference in the fidelity
    // loop so convergence is stable and comparable across pages of any length.
    const screenshotFoldBuffer = await page.screenshot({
      type: "png",
      clip: { x: 0, y: 0, width: VIEWPORT.width, height: VIEWPORT.height },
    });
    const screenshotFoldBase64 = Buffer.from(screenshotFoldBuffer).toString("base64");

    // Full-page screenshot (capped) — passed to the model so it sees all sections.
    const scrollHeight = await page.evaluate(() => document.documentElement.scrollHeight);
    const captureHeight = Math.min(scrollHeight, MAX_SCREENSHOT_HEIGHT);
    const screenshotBuffer = await page.screenshot({
      type: "png",
      clip: { x: 0, y: 0, width: VIEWPORT.width, height: captureHeight },
    });
    const screenshotBase64 = Buffer.from(screenshotBuffer).toString("base64");

    // Wide-viewport screenshot at 1920px for responsive fidelity checks
    await page.setViewport({ width: 1920, height: 1080 });
    const wideScrollHeight = await page.evaluate(() => document.documentElement.scrollHeight);
    const wideCaptureHeight = Math.min(wideScrollHeight, MAX_SCREENSHOT_HEIGHT);
    const screenshotWideBuffer = await page.screenshot({
      type: "png",
      clip: { x: 0, y: 0, width: 1920, height: wideCaptureHeight },
    });
    const screenshotWideBase64 = Buffer.from(screenshotWideBuffer).toString("base64");
    await page.setViewport(VIEWPORT);

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

      // ── DOM info (mirrors screenshotAndExtract for composite scoring) ──────
      const headingEls = Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6"));
      const headings = headingEls.map((el) => ({
        tag: el.tagName.toLowerCase(),
        text: (el.textContent ?? "").trim().slice(0, 200),
        y: el.getBoundingClientRect().top + window.scrollY,
      }));
      const domInfo = {
        headings,
        paragraphs: document.querySelectorAll("p").length,
        images: document.querySelectorAll("img,svg,picture").length,
        buttons: document.querySelectorAll(
          'button,a[role="button"],[type="button"],[type="submit"]',
        ).length,
        sections: document.querySelectorAll(
          "section,article,main,aside,nav,header,footer",
        ).length,
        links: document.querySelectorAll("a[href]").length,
        totalTextLength: (document.body.innerText ?? "").length,
      };

      return { uniqueImageUrls, uniqueFontFamilies, computedStyles, svgs, domInfo };
    });

    // ── Heading-anchored chunk screenshots ────────────────────────────────────
    // Always fold (y=0) plus one chunk per h1/h2 heading, de-duped +
    // capped at CHUNK_HARD_CAP. Source chunks are taken once and reused
    // across all scoring iterations.
    const screenshotChunksBase64: Array<{ heading: string; screenshot: string }> = [];

    screenshotChunksBase64.push({
      heading: "FOLD",
      screenshot: screenshotFoldBase64,
    });

    const h1h2 = extracted.domInfo.headings
      .filter((h) => h.tag === "h1" || h.tag === "h2")
      .sort((a, b) => a.y - b.y);

    const maxHeadingChunks = CHUNK_HARD_CAP - 1;
    const step = h1h2.length > maxHeadingChunks ? h1h2.length / maxHeadingChunks : 1;
    let lastY = -Infinity;
    let idx = 0;
    while (screenshotChunksBase64.length < CHUNK_HARD_CAP && idx < h1h2.length) {
      const heading = h1h2[Math.min(Math.floor(idx * step), h1h2.length - 1)];
      idx++;
      if (heading.y - lastY < 100) continue;
      const clipY = Math.min(heading.y, scrollHeight - VIEWPORT.height);
      const chunkBuf = await page.screenshot({
        type: "png",
        clip: { x: 0, y: Math.max(0, clipY), width: VIEWPORT.width, height: VIEWPORT.height },
      });
      screenshotChunksBase64.push({
        heading: heading.text,
        screenshot: Buffer.from(chunkBuf).toString("base64"),
      });
      lastY = heading.y;
    }

    return {
      html,
      truncated,
      screenshotBase64,
      screenshotFoldBase64,
      screenshotWideBase64,
      scrollHeight,
      screenshotChunksBase64,
      domInfo: extracted.domInfo,
      computedStyles: extracted.computedStyles,
      imageUrls: extracted.uniqueImageUrls,
      fontFamilies: extracted.uniqueFontFamilies,
      svgs: extracted.svgs,
    };
  } finally {
    await browser.close();
  }
}
