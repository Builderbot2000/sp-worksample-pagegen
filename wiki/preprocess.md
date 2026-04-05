# Stage 0 — Preprocess

Source: [`src/context.ts`](../src/context.ts)

Drives a headless Chromium browser via Puppeteer to extract everything the downstream LLM stages need from the live page before any generation begins.

---

## What it produces

`crawlAndPreprocess(url)` returns a `CrawlResult`:

```ts
interface CrawlResult {
  html: string;                   // raw page HTML, truncated at 80,000 chars
  truncated: boolean;
  screenshotBase64: string;       // full-page PNG (capped at 7,800px height)
  scrollHeight: number;
  computedStyles: ComputedStyleEntry[];
  imageUrls: string[];
  fontFamilies: string[];
  svgs: string[];
  visualArchDoc: VisualArchDoc;   // section manifest used by all downstream stages
  sourceSectionScreenshots: Record<string, Buffer[]>; // keyed by slug
  fixedElementsHtml: string[];    // outerHTML of fixed/sticky elements, max 3 KB each
  captionTokensIn: number;
  captionTokensOut: number;
}
```

---

## Viewport and navigation

Puppeteer launches at **1280×900** with `waitUntil: "networkidle2"`. The full-page screenshot is capped at **7,800px** to avoid feeding oversized images to the VLM.

---

## Asset extraction

The following are extracted via `page.evaluate()` after navigation:

- **Image URLs** — `<img src>` attributes and CSS `background-image: url(...)` values, filtered to `http` origins.
- **Font families** — collected from `document.fonts`, deduped.
- **Computed styles** — `color`, `backgroundColor`, `fontSize`, `fontFamily` for a fixed set of key selectors (`body`, `h1`–`h3`, `p`, `a`, `button`, `.btn`, `.cta`).
- **Inline SVGs** — `outerHTML` of all `<svg>` elements, truncated to prevent token overflow.
- **Fixed/sticky elements** — `outerHTML` of all elements with `position: fixed` or `position: sticky` that are visible on initial load, truncated to 3 KB each. These are passed to the skeleton agent to avoid duplicating navigations.

---

## Section detection

Section detection runs entirely inside the browser via `page.evaluate()`. The algorithm:

1. Queries all semantic elements: `section`, `article`, `main`, `header`, `footer`, `nav`.
2. Keeps only top-level elements — those with no semantic ancestor in the query result.
3. Discards elements shorter than **50px** or with `position: fixed/sticky`.
4. Elements taller than **1,350px** (~150% of viewport) trigger a recursive descent into their direct semantic children, preventing a single monolithic wrapper from absorbing the whole page.
5. Each surviving element gets a **role** inferred from its tag name, `aria-label`, `class`, and `id` (producing values like `navbar`, `hero`, `features`, `pricing`, `footer`).
6. Each element gets a **slug** derived from its heading text or aria label; all slugs are then replaced with generic `section-1`, `section-2`, … names before leaving the browser to prevent content-derived labels from biasing downstream section agents.
7. The list is capped at **20 sections**.

A per-section screenshot is taken for each detected section at its bounding rect. Sections that produce a screenshot above `SECTION_TALL_THRESHOLD` (1,350px) get a second screenshot cropped to the lower half. All screenshots are stored in `sourceSectionScreenshots` keyed by slug.

---

## VLM section captions

After section detection, each section screenshot is sent to `claude-haiku-4-5` in a `Promise.all` batch. The model lists every distinct content block visible in the screenshot, one line per block. This caption becomes the section's `description` field in `VisualArchDoc` and is the primary content signal for section agents during generation.

Caption token counts are tracked separately (`captionTokensIn`, `captionTokensOut`) for cost accounting.

---

## Output type: `VisualArchDoc`

```ts
interface VisualArchDoc {
  sections: SectionSpec[];
  fixedElements: string[];       // outerHTML strings of fixed/sticky elements
  backgroundDescription: string; // unused placeholder currently
}

interface SectionSpec {
  slug: string;         // e.g. "section-1"
  description: string;  // VLM caption
  role: string;         // e.g. "hero", "features", "footer"
  order: number;        // visual order, 0-indexed
  y: number;            // pixel y-offset in source at crawl viewport
  heightPx: number;     // pixel height in source
}
```
