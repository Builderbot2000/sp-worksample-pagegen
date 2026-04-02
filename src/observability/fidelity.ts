import puppeteer from "puppeteer";
import Anthropic from "@anthropic-ai/sdk";
import * as path from "path";
import type {
  DomInfo,
  VlmFidelityScore,
  VlmVerdict,
  VlmChunkScore,
  ChunkedVlmScore,
  DomDiffResult,
  FidelityMetrics,
  FidelityLevel,
} from "./types";

// ─── Viewport ─────────────────────────────────────────────────────────────────

const VIEWPORT = { width: 1280, height: 900 };

// ─── Screenshot + DOM extraction ──────────────────────────────────────────────

// The hard cap on heading-anchored chunks (fold chunk always included as index 0).
export const CHUNK_HARD_CAP = 10;

export interface PageChunk {
  heading: string;
  screenshot: Buffer;
}

interface ScreenshotResult {
  screenshot: Buffer;
  screenshotFold: Buffer;
  screenshotWide: Buffer;
  scrollHeight: number;
  domInfo: DomInfo;
  screenshotChunks: PageChunk[];
}

export async function screenshotAndExtract(
  target: { url: string } | { file: string },
  opts: { useWideViewport?: boolean; targetHeadings?: string[] } = {},
): Promise<ScreenshotResult> {
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport(VIEWPORT);

    const navigateTo =
      "url" in target ? target.url : `file://${path.resolve(target.file)}`;

    await page.goto(navigateTo, {
      waitUntil: "networkidle2",
      timeout: 30_000,
    });

    // Anthropic image API limit: 8000px per dimension. Cap height to stay safe.
    const MAX_SCREENSHOT_HEIGHT = 7800;

    // First-fold clip — used for VLM scoring only. Stable 1280×900 reference
    // keeps convergence comparable across pages of any length.
    const screenshotFold = await page.screenshot({
      type: "png",
      clip: { x: 0, y: 0, width: VIEWPORT.width, height: VIEWPORT.height },
    });

    const scrollHeight = await page.evaluate(() => document.documentElement.scrollHeight);
    const captureHeight = Math.min(scrollHeight, MAX_SCREENSHOT_HEIGHT);
    const screenshot = await page.screenshot({
      type: "png",
      clip: { x: 0, y: 0, width: VIEWPORT.width, height: captureHeight },
    });

    // Second pass at 1920px to capture wide-viewport layout breakage
    let screenshotWide: Awaited<ReturnType<typeof page.screenshot>>;
    if (opts.useWideViewport !== false) {
      await page.setViewport({ width: 1920, height: 1080 });
      const wideScrollHeight = await page.evaluate(() => document.documentElement.scrollHeight);
      const wideCaptureHeight = Math.min(wideScrollHeight, MAX_SCREENSHOT_HEIGHT);
      screenshotWide = await page.screenshot({
        type: "png",
        clip: { x: 0, y: 0, width: 1920, height: wideCaptureHeight },
      });
      // Restore original viewport
      await page.setViewport(VIEWPORT);
    } else {
      // Use fold screenshot as a zero-cost stand-in; wide-viewport data won't be used.
      screenshotWide = screenshotFold;
    }

    const domInfo = await page.evaluate((): DomInfo => {
      const headingEls = Array.from(
        document.querySelectorAll("h1,h2,h3,h4,h5,h6"),
      );
      const headings = headingEls.map((el) => ({
        tag: el.tagName.toLowerCase(),
        text: (el.textContent ?? "").trim().slice(0, 200),
        y: el.getBoundingClientRect().top + window.scrollY,
      }));

      const paragraphs = document.querySelectorAll("p").length;
      const images = document.querySelectorAll("img,svg,picture").length;
      const buttons = document.querySelectorAll(
        'button,a[role="button"],[type="button"],[type="submit"]',
      ).length;
      const sections = document.querySelectorAll(
        "section,article,main,aside,nav,header,footer",
      ).length;
      const links = document.querySelectorAll("a[href]").length;
      const totalTextLength = (document.body.innerText ?? "").length;

      return {
        headings,
        paragraphs,
        images,
        buttons,
        sections,
        links,
        totalTextLength,
      };
    });

    // ── Heading-anchored chunk screenshots ────────────────────────────────────
    // Always include the fold (y=0) plus one chunk per h1/h2 heading,
    // de-duped by 100px proximity and capped at CHUNK_HARD_CAP total.
    const screenshotChunks: PageChunk[] = [];

    // Fold chunk at y=0 is always first
    screenshotChunks.push({
      heading: "FOLD",
      screenshot: Buffer.from(screenshotFold),
    });

    const h1h2 = domInfo.headings
      .filter((h) => h.tag === "h1" || h.tag === "h2")
      .sort((a, b) => a.y - b.y);

    if (opts.targetHeadings && opts.targetHeadings.length > 0) {
      // ── Gen mode: capture chunks anchored to SOURCE heading texts ──────────
      // Locate each source heading in this page's DOM by normalised text and
      // screenshot from that y position. The chunk is labelled with the source
      // heading text so scoring match keys are always identical to source keys.
      // Index ALL h1-h6 (not just h1/h2) so sections the model rendered at a
      // lower heading level are still found via fuzzy matching.
      const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
      const allHeadingsByNorm = new Map(domInfo.headings.map((h) => [norm(h.text), h]));
      for (const targetText of opts.targetHeadings) {
        if (screenshotChunks.length >= CHUNK_HARD_CAP) break;
        const match = fuzzyFindHeading(targetText, allHeadingsByNorm, FUZZY_THRESHOLD_VLM);
        if (!match) continue; // truly absent — scored 0 in computeChunkedVlmScore
        const clipY = Math.max(0, Math.min(match.y, scrollHeight - VIEWPORT.height));
        const chunkBuf = await page.screenshot({
          type: "png",
          clip: { x: 0, y: clipY, width: VIEWPORT.width, height: VIEWPORT.height },
        });
        screenshotChunks.push({ heading: targetText, screenshot: Buffer.from(chunkBuf) });
      }
    } else {
      // ── Source mode: self-discover h1/h2 headings ──────────────────────────
      const maxHeadingChunks = CHUNK_HARD_CAP - 1;
      const step = h1h2.length > maxHeadingChunks ? h1h2.length / maxHeadingChunks : 1;
      let lastY = -Infinity;
      let idx = 0;
      while (screenshotChunks.length < CHUNK_HARD_CAP && idx < h1h2.length) {
        const heading = h1h2[Math.min(Math.floor(idx * step), h1h2.length - 1)];
        idx++;
        if (heading.y - lastY < 100) continue; // skip headings too close together
        const clipY = Math.min(heading.y, scrollHeight - VIEWPORT.height);
        const chunkBuf = await page.screenshot({
          type: "png",
          clip: { x: 0, y: Math.max(0, clipY), width: VIEWPORT.width, height: VIEWPORT.height },
        });
        screenshotChunks.push({ heading: heading.text, screenshot: Buffer.from(chunkBuf) });
        lastY = heading.y;
      }
    }

    return { screenshot: Buffer.from(screenshot), screenshotFold: Buffer.from(screenshotFold), screenshotWide: Buffer.from(screenshotWide), scrollHeight, domInfo, screenshotChunks };
  } finally {
    await browser.close();
  }
}

// ─── VLM fidelity scorer ─────────────────────────────────────────────────────

const client = new Anthropic();

const VLM_SYSTEM = `You are a visual fidelity judge. You will be shown two screenshots of web pages: the SOURCE (original) and the RECONSTRUCTION (generated). Your task is to assess how closely the reconstruction matches the source.

Respond with ONLY a JSON object — no prose, no markdown fences. The shape must be:
{
  "verdict": "close" | "partial" | "distant",
  "score": <number 0.0–1.0>,
  "sections": {
    "header": "match" | "partial" | "missing",
    "navigation": "match" | "partial" | "missing",
    "hero": "match" | "partial" | "missing",
    "content": "match" | "partial" | "missing",
    "footer": "match" | "partial" | "missing"
  },
  "issues": [<brief string per problem, max 5>]
}

Scoring guide:
- 0.9–1.0 / "close": layout, colours, typography, and content are essentially identical
- 0.6–0.89 / "partial": overall structure matches but notable visual differences exist
- 0.0–0.59 / "distant": substantially different layout or content`;

export async function computeVlmFidelityScore(
  sourceBase64: string,
  generatedBase64: string,
): Promise<VlmFidelityScore> {
  const FALLBACK: VlmFidelityScore = {
    verdict: "distant",
    score: 0,
    sections: {},
    issues: ["VLM scoring failed"],
  };

  try {
    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system: VLM_SYSTEM,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: sourceBase64 },
            },
            {
              type: "text",
              text: "SOURCE screenshot above.",
            },
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: generatedBase64 },
            },
            {
              type: "text",
              text: "RECONSTRUCTION screenshot above. Evaluate fidelity and respond with the JSON object only.",
            },
          ],
        },
      ],
    });

    const text = response.content.find((b) => b.type === "text")?.text ?? "";
    // Strip optional markdown fences before parsing
    const cleaned = text.replace(/^```[^\n]*\n?|```$/gm, "").trim();
    const parsed = JSON.parse(cleaned) as VlmFidelityScore;

    // Minimal validation
    if (
      typeof parsed.score !== "number" ||
      !["close", "partial", "distant"].includes(parsed.verdict)
    ) {
      return FALLBACK;
    }

    return {
      verdict: parsed.verdict,
      score: Math.max(0, Math.min(1, parsed.score)),
      sections: parsed.sections ?? {},
      issues: Array.isArray(parsed.issues) ? parsed.issues.slice(0, 5) : [],
    };
  } catch {
    return FALLBACK;
  }
}

// ─── Chunked VLM scorer ───────────────────────────────────────────────────────

export interface PageChunkBase64 {
  heading: string;
  screenshot: string;
}

const CHUNK_VLM_SYSTEM = `You are a visual fidelity judge comparing a SOURCE web page with its RECONSTRUCTION section by section. You will receive interleaved image pairs — one SOURCE screenshot and one RECONSTRUCTION screenshot per named section.

Respond with ONLY a JSON array — no prose, no markdown fences. Each element must be:
{
  "heading": "<section name exactly as given>",
  "score": <number 0.0–1.0>,
  "verdict": "close" | "partial" | "distant",
  "issues": [<brief string per problem, max 3>]
}

Scoring guide per section:
- 0.9–1.0 / "close": layout, colours, typography, and content essentially identical
- 0.6–0.89 / "partial": overall structure matches but notable visual differences exist
- 0.0–0.59 / "distant": substantially different layout or content`;

/**
 * Given up to \`maxPairs\` heading-anchored chunk pairs, score each with one
 * VLM call and return the per-chunk results plus an aggregate score.
 */
export async function computeChunkedVlmScore(
  sourceChunks: PageChunkBase64[],
  genChunks: PageChunkBase64[],
  maxPairs: number,
): Promise<ChunkedVlmScore> {
  const FALLBACK: ChunkedVlmScore = {
    chunks: [],
    aggregateScore: 0,
    aggregateVerdict: "distant",
  };

  if (sourceChunks.length === 0 || genChunks.length === 0) return FALLBACK;

  // Build a normalised-key map for fuzzy heading matching (case + whitespace).
  const normalise = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const genByNorm = new Map(genChunks.map((c) => [normalise(c.heading), c]));

  // Separate source chunks into matched pairs and unmatched (missing) ones.
  const pairs: Array<{ source: PageChunkBase64; gen: PageChunkBase64 }> = [];
  const missingHeadings: string[] = [];

  for (const sc of sourceChunks) {
    const match = fuzzyFindHeading(sc.heading, genByNorm, FUZZY_THRESHOLD_VLM);
    if (match) {
      pairs.push({ source: sc, gen: match });
    } else {
      missingHeadings.push(sc.heading);
    }
  }

  // If nothing matched at all (e.g. completely different page), return fallback.
  if (pairs.length === 0) return FALLBACK;

  // Evenly subsample to stay within the caller-specified budget
  const selected = selectPairs(pairs, maxPairs);

  // Build a single messages request with interleaved image pairs
  const userContent: Anthropic.MessageParam["content"] = [];
  for (const { source, gen } of selected) {
    userContent.push(
      { type: "image", source: { type: "base64", media_type: "image/png", data: source.screenshot } },
      { type: "text", text: `Section "${source.heading}" — SOURCE above.` },
      { type: "image", source: { type: "base64", media_type: "image/png", data: gen.screenshot } },
      { type: "text", text: `Section "${source.heading}" — RECONSTRUCTION above.` },
    );
  }
  userContent.push({ type: "text", text: "Evaluate each section and respond with the JSON array only." });

  try {
    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 512 + 256 * selected.length,
      system: CHUNK_VLM_SYSTEM,
      messages: [{ role: "user", content: userContent }],
    });

    const text = response.content.find((b) => b.type === "text")?.text ?? "";
    const cleaned = text.replace(/^```[^\n]*\n?|```$/gm, "").trim();
    const parsed = JSON.parse(cleaned) as unknown[];

    if (!Array.isArray(parsed)) return FALLBACK;

    const scoredChunks: VlmChunkScore[] = parsed
      .filter(
        (d): d is VlmChunkScore =>
          typeof d === "object" &&
          d !== null &&
          "heading" in d &&
          "score" in d &&
          "verdict" in d &&
          ["close", "partial", "distant"].includes((d as VlmChunkScore).verdict),
      )
      .map((d) => ({
        heading: String(d.heading),
        score: Math.max(0, Math.min(1, Number(d.score))),
        verdict: d.verdict,
        issues: Array.isArray(d.issues) ? (d.issues as string[]).slice(0, 3) : [],
      }));

    if (scoredChunks.length === 0) return FALLBACK;

    // Penalise source chunks whose heading was absent in the generated page
    // by inserting score-0 entries. They are included in the denominator so
    // a page missing whole sections cannot score well just by matching the
    // sections it did reproduce.
    const missingChunks: VlmChunkScore[] = missingHeadings.map((h) => ({
      heading: h,
      score: 0,
      verdict: "distant",
      issues: ["Section absent in reconstruction"],
    }));

    const allChunks = [...scoredChunks, ...missingChunks];
    const aggregateScore = allChunks.reduce((s, c) => s + c.score, 0) / allChunks.length;
    const aggregateVerdict: VlmVerdict =
      aggregateScore > 0.89 ? "close" : aggregateScore >= 0.6 ? "partial" : "distant";

    return { chunks: allChunks, aggregateScore, aggregateVerdict };
  } catch {
    return FALLBACK;
  }
}

/** Evenly subsample matched pairs to at most \`max\` entries, always keeping index 0 (fold). */
function selectPairs<T>(pairs: T[], max: number): T[] {
  if (pairs.length <= max) return pairs;
  const result: T[] = [pairs[0]]; // always keep fold
  const remaining = pairs.slice(1);
  const step = remaining.length / (max - 1);
  for (let i = 0; i < max - 1; i++) {
    result.push(remaining[Math.min(Math.floor(i * step), remaining.length - 1)]);
  }
  return result;
}

// ─── Severity band ────────────────────────────────────────────────────────────

export function scoreSeverity(score: number): "high" | "medium" | "low" {
  if (score > 0.85) return "low";
  if (score >= 0.6) return "medium";
  return "high";
}

// ─── Level classifier ────────────────────────────────────────────────────────

// Tunable thresholds: advance to the next level only once the current one is met.
const STRUCTURE_HEADING_THRESHOLD = 0.8; // headingRetentionRatio must reach this
const CONTENT_TEXT_THRESHOLD = 0.7; // textCoverageRatio must reach this

export function classifyLevel(domDiff: DomDiffResult): FidelityLevel {
  if (domDiff.headingRetentionRatio < STRUCTURE_HEADING_THRESHOLD) return "structure";
  if (domDiff.textCoverageRatio < CONTENT_TEXT_THRESHOLD) return "content";
  return "visual";
}

// ─── Composite score ──────────────────────────────────────────────────────────

const VLM_WEIGHT = 0.7;
const DOM_WEIGHT = 0.3;

export function computeCompositeScore(vlmScore: number, domScore: number): number {
  return VLM_WEIGHT * vlmScore + DOM_WEIGHT * domScore;
}

// ─── Discrepancy captioner ─────────────────────────────────────────────────────

const CAPTION_SYSTEM = `You are a visual discrepancy analyst. You will be shown two screenshots: SOURCE (original) and RECONSTRUCTION (generated). Identify specific visual issues in the reconstruction.

Respond with ONLY a JSON array — no prose, no markdown fences. Each element must be:
{ "section": "<page section>", "issue": "<specific problem>", "severity": "high" | "medium" }

Only include high and medium severity issues (max 8). Do not include low-severity or cosmetic differences.
"high": missing element, broken layout, wrong color scheme, completely absent section
"medium": wrong spacing, font mismatch, partially missing content, misaligned element`;

export interface Discrepancy {
  section: string;
  issue: string;
  severity: "high" | "medium";
}

export async function captionDiscrepancies(
  sourceBase64: string,
  generatedBase64: string,
  opts?: { sourceWideBase64?: string; generatedWideBase64?: string },
  budgetOpts?: { maxTokens?: number },
): Promise<Discrepancy[]> {
  try {
    const userContent: Anthropic.MessageParam["content"] = [
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: sourceBase64 },
      },
      { type: "text", text: "SOURCE at 1280px above." },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: generatedBase64 },
      },
      { type: "text", text: "RECONSTRUCTION at 1280px above." },
    ];

    if (opts?.sourceWideBase64 && opts?.generatedWideBase64) {
      userContent.push(
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: opts.sourceWideBase64 },
        },
        { type: "text", text: "SOURCE at 1920px above." },
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: opts.generatedWideBase64 },
        },
        {
          type: "text",
          text: "RECONSTRUCTION at 1920px above. Include any wide-viewport layout breakage. List all high and medium severity discrepancies as a JSON array.",
        },
      );
    } else {
      userContent.push({
        type: "text",
        text: "RECONSTRUCTION above. List all high and medium severity discrepancies as a JSON array.",
      });
    }

    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: budgetOpts?.maxTokens ?? 1024,
      system: CAPTION_SYSTEM,
      messages: [{ role: "user", content: userContent }],
    });

    const text = response.content.find((b) => b.type === "text")?.text ?? "";
    const cleaned = text.replace(/^```[^\n]*\n?|```$/gm, "").trim();
    const parsed = JSON.parse(cleaned) as unknown[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (d): d is Discrepancy =>
        typeof d === "object" &&
        d !== null &&
        "section" in d &&
        "issue" in d &&
        "severity" in d &&
        ((d as Discrepancy).severity === "high" || (d as Discrepancy).severity === "medium"),
    );
  } catch {
    return [];
  }
}

// ─── Fuzzy heading matcher ────────────────────────────────────────────────────

/**
 * Thresholds for the two callsites. The chunk-capture / VLM scorer can be
 * more liberal (0.5) because a near-match is still useful for positioning a
 * screenshot. The DOM diff uses a stricter threshold (0.6) because a false
 * match here means a missing heading is silently dropped from the fix prompt.
 */
const FUZZY_THRESHOLD_VLM = 0.5;
const FUZZY_THRESHOLD_DOM = 0.6;

/**
 * Compute Jaccard similarity between two normalised text strings as sets of
 * whitespace-split tokens.
 */
function jaccardSimilarity(a: string, b: string): number {
  const ta = new Set(a.split(" ").filter(Boolean));
  const tb = new Set(b.split(" ").filter(Boolean));
  if (ta.size === 0 && tb.size === 0) return 1;
  if (ta.size === 0 || tb.size === 0) return 0;
  let intersection = 0;
  for (const t of ta) if (tb.has(t)) intersection++;
  return intersection / (ta.size + tb.size - intersection);
}

/**
 * Look up a heading in a normalised-key map.
 * 1. Exact normalised match (fast path).
 * 2. Best Jaccard token-overlap above `threshold` (skipped for single-word
 *    targets where the denominator is too small to be meaningful).
 */
function fuzzyFindHeading<T>(
  target: string,
  candidates: Map<string, T>,
  threshold: number,
): T | undefined {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const normTarget = norm(target);

  // Fast path: exact match
  const exact = candidates.get(normTarget);
  if (exact !== undefined) return exact;

  // Skip fuzzy for single-token targets — Jaccard is unreliable at that size
  if (normTarget.split(" ").filter(Boolean).length < 2) return undefined;

  let bestScore = 0;
  let bestValue: T | undefined;
  for (const [key, value] of candidates) {
    const sim = jaccardSimilarity(normTarget, key);
    if (sim > bestScore) {
      bestScore = sim;
      bestValue = value;
    }
  }
  return bestScore >= threshold ? bestValue : undefined;
}

// ─── DOM diff ─────────────────────────────────────────────────────────────────

export function computeDomDiff(
  source: DomInfo,
  target: DomInfo,
): DomDiffResult {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  // Maps of normalised text → raw heading object, used by fuzzy matcher.
  const sourceNormMap = new Map(source.headings.map((h) => [norm(h.text), h]));
  const targetNormMap = new Map(target.headings.map((h) => [norm(h.text), h]));

  const missingHeadings = source.headings
    .filter((h) => fuzzyFindHeading(h.text, targetNormMap, FUZZY_THRESHOLD_DOM) === undefined)
    .map((h) => `${h.tag}: ${h.text}`);

  const extraHeadings = target.headings
    .filter((h) => fuzzyFindHeading(h.text, sourceNormMap, FUZZY_THRESHOLD_DOM) === undefined)
    .map((h) => `${h.tag}: ${h.text}`);

  const imageDelta = target.images - source.images;
  const buttonDelta = target.buttons - source.buttons;
  const sectionDelta = target.sections - source.sections;

  const textCoverageRatio =
    source.totalTextLength > 0
      ? Math.min(1, target.totalTextLength / source.totalTextLength)
      : 1;

  const headingRetentionRatio =
    source.headings.length > 0
      ? 1 - missingHeadings.length / source.headings.length
      : 1;

  const score = (headingRetentionRatio + textCoverageRatio) / 2;

  return {
    missingHeadings,
    extraHeadings,
    imageDelta,
    buttonDelta,
    sectionDelta,
    textCoverageRatio,
    headingRetentionRatio,
    score,
  };
}

// ─── Orchestrator ─────────────────────────────────────────────────────────────

export async function collectFidelityMetrics(
  url: string,
  mainFilePath: string,
  baselineFilePath?: string,
  maxChunks: number = CHUNK_HARD_CAP,
): Promise<FidelityMetrics> {
  console.log("[fidelity] Capturing screenshots and extracting DOM...");
  const start = Date.now();

  // Source must be captured first so its heading list can drive gen/baseline
  // chunk capture, ensuring chunk label alignment across all three targets.
  const sourceResult = await screenshotAndExtract({ url });
  const sourceTargetHeadings = sourceResult.screenshotChunks
    .map((c) => c.heading)
    .filter((h) => h !== "FOLD");

  const dependentTargets: Array<Promise<ScreenshotResult>> = [
    screenshotAndExtract({ file: mainFilePath }, { targetHeadings: sourceTargetHeadings }),
  ];
  if (baselineFilePath) {
    dependentTargets.push(
      screenshotAndExtract({ file: baselineFilePath }, { targetHeadings: sourceTargetHeadings }),
    );
  }

  const [mainResult, baselineResult] = await Promise.all(dependentTargets);

  const sourceBase64 = sourceResult.screenshot.toString("base64");
  const mainBase64 = mainResult.screenshot.toString("base64");
  const baselineBase64 = baselineResult?.screenshot.toString("base64");

  // Convert chunk buffers to base64
  const sourceChunks = sourceResult.screenshotChunks.map((c) => ({
    heading: c.heading,
    screenshot: c.screenshot.toString("base64"),
  }));
  const mainChunks = mainResult.screenshotChunks.map((c) => ({
    heading: c.heading,
    screenshot: c.screenshot.toString("base64"),
  }));

  // Run chunked VLM scoring and DOM diff in parallel
  const vlmPromises: Promise<ChunkedVlmScore>[] = [
    computeChunkedVlmScore(sourceChunks, mainChunks, maxChunks),
  ];
  const baselineChunks = baselineResult?.screenshotChunks.map((c) => ({
    heading: c.heading,
    screenshot: c.screenshot.toString("base64"),
  }));
  if (baselineChunks) {
    vlmPromises.push(computeChunkedVlmScore(sourceChunks, baselineChunks, maxChunks));
  }

  const [mainChunkedVlm, baselineChunkedVlm] = await Promise.all(vlmPromises);
  const mainDomDiff = computeDomDiff(sourceResult.domInfo, mainResult.domInfo);

  const metrics: FidelityMetrics = {
    sourceScreenshotBase64: sourceBase64,
    mainScreenshotBase64: mainBase64,
    mainVlmScore: chunkedToVlmFidelityScore(mainChunkedVlm),
    mainDomDiff,
  };

  if (baselineResult && baselineBase64 && baselineChunkedVlm) {
    metrics.baselineScreenshotBase64 = baselineBase64;
    metrics.baselineVlmScore = chunkedToVlmFidelityScore(baselineChunkedVlm);
    metrics.baselineDomDiff = computeDomDiff(
      sourceResult.domInfo,
      baselineResult.domInfo,
    );
  }

  console.log(`[fidelity] Done in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  return metrics;
}

/**
 * Map a ChunkedVlmScore back to VlmFidelityScore for backward-compatible
 * FidelityMetrics / report rendering. Sections are derived from chunk
 * headings; issues are flattened across all chunks.
 */
function chunkedToVlmFidelityScore(chunked: ChunkedVlmScore): VlmFidelityScore {
  const sections: Record<string, "match" | "partial" | "missing"> = {};
  for (const c of chunked.chunks) {
    sections[c.heading] =
      c.verdict === "close" ? "match" : c.verdict === "partial" ? "partial" : "missing";
  }
  const issues = chunked.chunks.flatMap((c) => c.issues).slice(0, 5);
  return {
    verdict: chunked.aggregateVerdict,
    score: chunked.aggregateScore,
    sections,
    issues,
  };
}
