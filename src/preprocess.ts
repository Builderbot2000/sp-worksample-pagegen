import puppeteer from "puppeteer";
import type { ComputedStyleEntry } from "./context";

// ─── Constants ────────────────────────────────────────────────────────────────

const VIEWPORT = { width: 1280, height: 900 };
const MAX_HTML_CHARS = 80_000;
const MAX_SCREENSHOT_HEIGHT = 7_800;
const MAX_SECTIONS = 20;
const MIN_SECTION_H = 80;
const MAX_SECTION_H = 1_350; // ~150% of viewport height

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SectionSpec {
  slug: string;
  role: string;
  order: number; // 1-based
  y: number; // absolute top offset in px
  height: number;
}

export interface PreprocessResult {
  html: string;
  truncated: boolean;
  computedStyles: ComputedStyleEntry[];
  imageUrls: string[];
  fontFamilies: string[];
  svgs: string[];
  sections: SectionSpec[];
  sectionScreenshots: Record<string, Buffer[]>;
  skeletonScreenshot: Buffer;
  skeletonHtml: string;
}

interface RawSection {
  slug: string;
  role: string;
  y: number;
  height: number;
}

// ─── Browser-side scripts (plain strings — never transformed by esbuild) ──────

// Returns RawSection[] and tags each root with data-section-slug.
// Constants are interpolated at call time so no closure deps are needed.
function detectSectionsScript(
  viewportW: number,
  viewportH: number,
  maxH: number,
  minH: number,
  maxCount: number,
): string {
  return `
(function() {
  var VIEWPORT_W = ${viewportW};
  var MAX_H = ${maxH};
  var MIN_H = ${minH};
  var MAX_COUNT = ${maxCount};

  var ROLE_KEYWORDS = [
    [/nav|navigation|menu|topbar|header/i, "navbar"],
    [/hero|banner|jumbotron|splash|above-the-fold/i, "hero"],
    [/feature|product|offering|benefit|why/i, "features"],
    [/pricing|plan|tier|subscription/i, "pricing"],
    [/cta|call-to-action|action|signup|subscribe/i, "cta"],
    [/logo|brand|partner|client|trust/i, "logo-grid"],
    [/testimonial|review|quote|social-proof/i, "testimonials"],
    [/faq|question|accordion/i, "faq"],
    [/footer/i, "footer"]
  ];

  function inferRole(el) {
    var tokens = [el.className, el.id, el.getAttribute("aria-label"), el.tagName.toLowerCase()]
      .filter(Boolean).join(" ");
    for (var i = 0; i < ROLE_KEYWORDS.length; i++) {
      if (ROLE_KEYWORDS[i][0].test(tokens)) return ROLE_KEYWORDS[i][1];
    }
    return "section";
  }

  function isFixed(el) {
    var pos = getComputedStyle(el).position;
    return pos === "fixed" || pos === "sticky";
  }

  var candidates = [];

  function walk(el) {
    if (isFixed(el)) return;
    var rect = el.getBoundingClientRect();
    var w = rect.width;
    var h = rect.height;
    if (w < VIEWPORT_W * 0.6 || h < MIN_H) return;
    if (h > MAX_H) {
      Array.from(el.children).forEach(function(child) { walk(child); });
      return;
    }
    candidates.push(el);
  }

  Array.from(document.body.children).forEach(function(child) { walk(child); });

  // Deduplicate: if two overlap > 80% by height, keep the taller
  var deduped = [];
  for (var ci = 0; ci < candidates.length; ci++) {
    var c = candidates[ci];
    var cRect = c.getBoundingClientRect();
    var cTop = cRect.top + window.scrollY;
    var cBot = cTop + cRect.height;
    var absorbed = false;
    for (var di = 0; di < deduped.length; di++) {
      var d = deduped[di];
      var dRect = d.getBoundingClientRect();
      var dTop = dRect.top + window.scrollY;
      var dBot = dTop + dRect.height;
      var overlapTop = Math.max(cTop, dTop);
      var overlapBot = Math.min(cBot, dBot);
      var overlap = Math.max(0, overlapBot - overlapTop);
      var minH2 = Math.min(cRect.height, dRect.height);
      if (minH2 > 0 && overlap / minH2 > 0.8) {
        if (cRect.height > dRect.height) deduped[di] = c;
        absorbed = true;
        break;
      }
    }
    if (!absorbed) deduped.push(c);
  }

  deduped.sort(function(a, b) {
    return (a.getBoundingClientRect().top + window.scrollY) -
           (b.getBoundingClientRect().top + window.scrollY);
  });

  var slugCounts = {};
  var sections = [];
  var count = Math.min(deduped.length, MAX_COUNT);

  for (var i = 0; i < count; i++) {
    var el = deduped[i];
    var rect = el.getBoundingClientRect();
    var absTop = rect.top + window.scrollY;
    var role = inferRole(el);
    slugCounts[role] = (slugCounts[role] || 0) + 1;
    var slug = slugCounts[role] === 1 ? role : (role + "-" + slugCounts[role]);
    el.setAttribute("data-section-slug", slug);
    sections.push({ slug: slug, role: role, y: Math.round(absTop), height: Math.round(rect.height) });
  }

  return sections;
})()
`;
}

const EXTRACT_ASSETS_SCRIPT = `
(function() {
  var imgUrls = Array.from(document.querySelectorAll("img[src]"))
    .map(function(el) { return el.src; })
    .filter(function(src) { return src.startsWith("http"); });
  document.querySelectorAll("[style]").forEach(function(el) {
    var bg = el.style.backgroundImage;
    var match = bg && bg.match(/url\\(["']?(https?[^"')]+)/);
    if (match) imgUrls.push(match[1]);
  });
  var imageUrls = Array.from(new Set(imgUrls)).slice(0, 30);

  var fontSelectors = ["body","h1","h2","h3","nav","footer","header","p","button","a"];
  var rawFamilies = fontSelectors.map(function(sel) {
    var el = document.querySelector(sel);
    if (!el) return null;
    return getComputedStyle(el).fontFamily.split(",")[0].replace(/['"]/g,"").trim();
  }).filter(Boolean);
  var fontFamilies = Array.from(new Set(rawFamilies)).slice(0, 10);

  var styleTargets = [
    { sel: "body", label: "body" },
    { sel: "h1", label: "h1" },
    { sel: "h2", label: "h2" },
    { sel: "h3", label: "h3" },
    { sel: "nav", label: "nav" },
    { sel: 'button,[role="button"],[type="submit"],[type="button"]', label: "primary-cta" }
  ];
  var computedStyles = styleTargets.map(function(t) {
    var el = document.querySelector(t.sel);
    if (!el) return null;
    var cs = getComputedStyle(el);
    return {
      selector: t.label,
      color: cs.color,
      backgroundColor: cs.backgroundColor,
      fontSize: cs.fontSize,
      fontFamily: cs.fontFamily.split(",")[0].replace(/['"]/g,"").trim()
    };
  }).filter(Boolean);

  var svgs = Array.from(document.querySelectorAll("svg")).slice(0, 5).map(function(s) {
    return s.outerHTML;
  });

  return { imageUrls: imageUrls, fontFamilies: fontFamilies, computedStyles: computedStyles, svgs: svgs };
})()
`;

function injectOverlaysScript(sections: RawSection[]): string {
  return `
(function() {
  var sections = ${JSON.stringify(sections)};
  var container = document.createElement("div");
  container.id = "__preprocess-overlays__";
  container.style.cssText = "position:absolute;top:0;left:0;width:100%;pointer-events:none;z-index:99999;";
  document.body.appendChild(container);
  sections.forEach(function(s) {
    var overlay = document.createElement("div");
    overlay.style.cssText = [
      "position:absolute",
      "top:" + s.y + "px",
      "left:0",
      "width:100%",
      "height:" + s.height + "px",
      "background:#e5e7eb",
      "border:2px dashed #9ca3af",
      "box-sizing:border-box",
      "display:flex",
      "align-items:center",
      "justify-content:center"
    ].join(";");
    var label = document.createElement("span");
    label.textContent = s.slug;
    label.style.cssText = "font:bold 18px monospace;color:#374151;background:#f9fafb;padding:4px 12px;border-radius:4px;";
    overlay.appendChild(label);
    container.appendChild(overlay);
  });
})()
`;
}

function hollowSectionsScript(sections: RawSection[]): string {
  return `
(function() {
  var sections = ${JSON.stringify(sections)};
  sections.forEach(function(s) {
    var el = document.querySelector('[data-section-slug="' + s.slug + '"]');
    if (el) el.innerHTML = "<!-- section-slot: " + s.slug + " -->";
  });
})()
`;
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function preprocessPage(url: string): Promise<PreprocessResult> {
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport(VIEWPORT);
    await page.goto(url, { waitUntil: "networkidle2", timeout: 60_000 });

    // ── 1. Detect sections & tag DOM nodes ────────────────────────────────
    const rawSections = (await page.evaluate(
      detectSectionsScript(VIEWPORT.width, VIEWPORT.height, MAX_SECTION_H, MIN_SECTION_H, MAX_SECTIONS),
    )) as RawSection[];
    const sections: SectionSpec[] = rawSections.map((s, i) => ({ ...s, order: i + 1 }));

    // ── 2. Extract assets ─────────────────────────────────────────────────
    const assets = (await page.evaluate(EXTRACT_ASSETS_SCRIPT)) as {
      imageUrls: string[];
      fontFamilies: string[];
      computedStyles: ComputedStyleEntry[];
      svgs: string[];
    };

    // ── 3. Raw HTML ───────────────────────────────────────────────────────
    const rawHtml = await page.content();
    const truncated = rawHtml.length > MAX_HTML_CHARS;
    const html = truncated ? rawHtml.slice(0, MAX_HTML_CHARS) + "\n<!-- truncated -->" : rawHtml;

    // ── 4. Per-section screenshots ────────────────────────────────────────
    const sectionScreenshots: Record<string, Buffer[]> = {};
    for (const section of sections) {
      const crops: Buffer[] = [];

      const firstHeight = Math.min(section.height, VIEWPORT.height);
      const firstCrop = await page.screenshot({
        type: "png",
        clip: { x: 0, y: section.y, width: VIEWPORT.width, height: firstHeight },
      });
      crops.push(Buffer.from(firstCrop));

      if (section.height > MAX_SECTION_H) {
        const secondY = section.y + VIEWPORT.height;
        const secondHeight = Math.min(section.height - VIEWPORT.height, VIEWPORT.height);
        if (secondHeight > 0) {
          const secondCrop = await page.screenshot({
            type: "png",
            clip: { x: 0, y: secondY, width: VIEWPORT.width, height: secondHeight },
          });
          crops.push(Buffer.from(secondCrop));
        }
      }

      sectionScreenshots[section.slug] = crops;
    }

    // ── 5. Inject skeleton overlays & take skeleton screenshot ────────────
    await page.evaluate(injectOverlaysScript(rawSections));

    const scrollHeight = (await page.evaluate("document.body.scrollHeight")) as number;
    const screenshotHeight = Math.min(scrollHeight, MAX_SCREENSHOT_HEIGHT);

    const skeletonScreenshotRaw = await page.screenshot({
      type: "png",
      clip: { x: 0, y: 0, width: VIEWPORT.width, height: screenshotHeight },
    });
    const skeletonScreenshot = Buffer.from(skeletonScreenshotRaw);

    // Remove overlays before hollowing
    await page.evaluate('document.getElementById("__preprocess-overlays__")?.remove()');

    // ── 6. Hollow sections → skeleton HTML ───────────────────────────────
    await page.evaluate(hollowSectionsScript(rawSections));
    const skeletonHtml = await page.content();

    return {
      html,
      truncated,
      computedStyles: assets.computedStyles,
      imageUrls: assets.imageUrls,
      fontFamilies: assets.fontFamilies,
      svgs: assets.svgs,
      sections,
      sectionScreenshots,
      skeletonScreenshot,
      skeletonHtml,
    };
  } finally {
    await browser.close();
  }
}
