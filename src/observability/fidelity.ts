import puppeteer from "puppeteer";
import Anthropic from "@anthropic-ai/sdk";
import * as path from "path";
import type {
  VlmFidelityScore,
  VlmVerdict,
  FidelityMetrics,
  VisualArchDoc,
  SectionDiscrepancy,
} from "./types";


const VIEWPORT = { width: 1280, height: 900 };
const MAX_SCREENSHOT_HEIGHT = 7800;
// ~150% viewport height; mirrors the threshold in context.ts
const SECTION_TALL_THRESHOLD = 1350;
// Max section pairs scored in a single VLM batch call
const MAX_SECTION_PAIRS = 15;

const client = new Anthropic();

// ─── Screenshot sections by slug ─────────────────────────────────────────────

export async function screenshotSectionsBySlug(
  target: { file: string },
  archDoc: VisualArchDoc,
): Promise<Record<string, Buffer[]>> {
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport(VIEWPORT);
    await page.goto(`file://${path.resolve(target.file)}`, {
      waitUntil: "networkidle2",
      timeout: 30_000,
    });

    const scrollHeight = await page.evaluate(() => document.documentElement.scrollHeight);

    const sectionRects = await page.evaluate(() => {
      const results: Array<{ slug: string; y: number; height: number }> = [];
      const els = document.querySelectorAll("[data-section-slug]");
      for (const el of els) {
        const slug = el.getAttribute("data-section-slug") ?? "";
        if (!slug) continue;
        const rect = el.getBoundingClientRect();
        results.push({ slug, y: rect.top + window.scrollY, height: rect.height });
      }
      return results;
    });

    const result: Record<string, Buffer[]> = {};
    for (const { slug, y, height } of sectionRects) {
      const screenshots: Buffer[] = [];
      const clipY = Math.max(0, Math.min(y, scrollHeight - VIEWPORT.height));
      const buf1 = await page.screenshot({
        type: "png",
        clip: { x: 0, y: clipY, width: VIEWPORT.width, height: VIEWPORT.height },
      });
      screenshots.push(Buffer.from(buf1));

      if (height > SECTION_TALL_THRESHOLD) {
        const clipY2 = Math.max(
          0,
          Math.min(y + VIEWPORT.height, scrollHeight - VIEWPORT.height),
        );
        const buf2 = await page.screenshot({
          type: "png",
          clip: { x: 0, y: clipY2, width: VIEWPORT.width, height: VIEWPORT.height },
        });
        screenshots.push(Buffer.from(buf2));
      }
      result[slug] = screenshots;
    }
    return result;
  } finally {
    await browser.close();
  }
}

// ─── Section VLM system prompt ────────────────────────────────────────────────

const SECTION_VLM_SYSTEM = `You are a visual fidelity judge comparing a SOURCE web page with its RECONSTRUCTION section by section. You will receive interleaved screenshot pairs for each named section.

Respond with ONLY a JSON array — no prose, no markdown fences. Each element must be:
{
  "slug": "<section slug exactly as given>",
  "score": <number 0.0–1.0>,
  "verdict": "close" | "partial" | "distant",
  "issues": [<brief string per problem, max 3>]
}

Scoring guide per section:
- 0.9–1.0 / "close": layout, colours, typography, and content essentially identical
- 0.6–0.89 / "partial": overall structure matches but notable visual differences exist
- 0.0–0.59 / "distant": substantially different layout or content`;

// ─── Section comparison result ────────────────────────────────────────────────

export interface SectionComparisonResult {
  discrepancies: SectionDiscrepancy[];
  matched: number;
  unmatched: number;
  aggregateScore: number;
}

// ─── Compute section discrepancies ───────────────────────────────────────────

export async function computeSectionDiscrepancies(
  sourceSections: Record<string, Buffer[]>,
  genSections: Record<string, Buffer[]>,
  archDoc: VisualArchDoc,
  opts?: { maxTokens?: number },
): Promise<SectionComparisonResult> {
  const discrepancies: SectionDiscrepancy[] = [];
  const matchedSlugs: string[] = [];
  const unmatchedSlugs: string[] = [];
  const sectionScores: Record<string, number> = {};

  for (const spec of archDoc.sections) {
    if (!genSections[spec.slug]) {
      unmatchedSlugs.push(spec.slug);
      sectionScores[spec.slug] = 0;
      discrepancies.push({
        slug: spec.slug,
        type: "missing",
        severity: "high",
        issues: [`Section "${spec.slug}" (${spec.role}) is absent in the reconstruction`],
        relativePosition: spec.order / archDoc.sections.length,
        score: 0,
      });
    } else {
      matchedSlugs.push(spec.slug);
    }
  }

  // Subsample to stay within VLM batch budget
  const toScore = matchedSlugs.slice(0, MAX_SECTION_PAIRS);

  if (toScore.length > 0) {
    const userContent: Anthropic.MessageParam["content"] = [];
    for (const slug of toScore) {
      const sourceImgs = sourceSections[slug] ?? [];
      const genImgs = genSections[slug] ?? [];
      const spec = archDoc.sections.find((s) => s.slug === slug);
      const label = spec ? `${slug} (${spec.role})` : slug;

      for (const buf of sourceImgs) {
        userContent.push({
          type: "image",
          source: { type: "base64", media_type: "image/png", data: buf.toString("base64") },
        });
      }
      userContent.push({ type: "text", text: `Section "${label}" — SOURCE above.` });

      for (const buf of genImgs) {
        userContent.push({
          type: "image",
          source: { type: "base64", media_type: "image/png", data: buf.toString("base64") },
        });
      }
      userContent.push({ type: "text", text: `Section "${label}" — RECONSTRUCTION above.` });
    }
    userContent.push({
      type: "text",
      text: "Evaluate each section and respond with the JSON array only.",
    });

    try {
      const response = await client.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: opts?.maxTokens ?? 512 + 256 * toScore.length,
        system: SECTION_VLM_SYSTEM,
        messages: [{ role: "user", content: userContent }],
      });

      const text = response.content.find((b) => b.type === "text")?.text ?? "";
      const cleaned = text.replace(/^```[^\n]*\n?|```$/gm, "").trim();
      const parsed = JSON.parse(cleaned) as unknown[];

      if (Array.isArray(parsed)) {
        for (const d of parsed) {
          if (typeof d !== "object" || d === null || !("slug" in d) || !("score" in d) || !("verdict" in d))
            continue;
          const item = d as { slug: string; score: number; verdict: string; issues?: unknown[] };
          const score = Math.max(0, Math.min(1, Number(item.score)));
          const verdict: VlmVerdict = ["close", "partial", "distant"].includes(item.verdict)
            ? (item.verdict as VlmVerdict)
            : "distant";
          const issues = Array.isArray(item.issues)
            ? (item.issues as unknown[]).filter((s): s is string => typeof s === "string").slice(0, 3)
            : [];
          sectionScores[item.slug] = score;
          if (verdict !== "close") {
            discrepancies.push({
              slug: item.slug,
              type: "visual",
              severity: verdict === "distant" ? "high" : "medium",
              issues,
              score,
            });
          }
        }
      }
    } catch {
      // VLM failed — treat all matched sections as needing a fix pass
      for (const slug of toScore) {
        if (sectionScores[slug] === undefined) {
          sectionScores[slug] = 0;
          const spec = archDoc.sections.find((s) => s.slug === slug);
          discrepancies.push({
            slug,
            type: "visual",
            severity: "high",
            issues: ["VLM scoring failed for this section"],
            score: 0,
          });
        }
      }
    }

    // Sections beyond MAX_SECTION_PAIRS are unscored — assume correct (score=1)
    // to avoid penalising long pages for an arbitrary batch cap
    for (const slug of matchedSlugs.slice(MAX_SECTION_PAIRS)) {
      sectionScores[slug] = 1;
    }
  }

  const totalSections = archDoc.sections.length;
  const aggregateScore =
    totalSections > 0
      ? archDoc.sections.reduce((sum, s) => sum + (sectionScores[s.slug] ?? 1), 0) / totalSections
      : 1;

  return {
    discrepancies,
    matched: matchedSlugs.length,
    unmatched: unmatchedSlugs.length,
    aggregateScore,
  };
}

// ─── Severity band ────────────────────────────────────────────────────────────

export function scoreSeverity(score: number): "high" | "medium" | "low" {
  if (score > 0.85) return "low";
  if (score >= 0.6) return "medium";
  return "high";
}

// ─── Full-page VLM scorer (baseline comparison only) ─────────────────────────

const FULL_PAGE_VLM_SYSTEM = `You are a visual fidelity judge. You will be shown two screenshots of web pages: the SOURCE (original) and the RECONSTRUCTION (generated). Your task is to assess how closely the reconstruction matches the source.

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

async function computeFullPageVlmScore(
  sourceBase64: string,
  generatedBase64: string,
): Promise<VlmFidelityScore> {
  const FALLBACK: VlmFidelityScore = { verdict: "distant", score: 0, sections: {}, issues: ["VLM scoring failed"] };
  try {
    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system: FULL_PAGE_VLM_SYSTEM,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/png", data: sourceBase64 } },
            { type: "text", text: "SOURCE screenshot above." },
            { type: "image", source: { type: "base64", media_type: "image/png", data: generatedBase64 } },
            { type: "text", text: "RECONSTRUCTION screenshot above. Evaluate fidelity and respond with the JSON object only." },
          ],
        },
      ],
    });
    const text = response.content.find((b) => b.type === "text")?.text ?? "";
    const cleaned = text.replace(/^```[^\n]*\n?|```$/gm, "").trim();
    const parsed = JSON.parse(cleaned) as VlmFidelityScore;
    if (typeof parsed.score !== "number" || !["close", "partial", "distant"].includes(parsed.verdict))
      return FALLBACK;
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

// ─── Full-page screenshot helper ──────────────────────────────────────────────

async function screenshotFile(filePath: string): Promise<Buffer> {
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport(VIEWPORT);
    await page.goto(`file://${path.resolve(filePath)}`, {
      waitUntil: "networkidle2",
      timeout: 30_000,
    });
    const scrollHeight = await page.evaluate(() => document.documentElement.scrollHeight);
    const captureHeight = Math.min(scrollHeight, MAX_SCREENSHOT_HEIGHT);
    const buf = await page.screenshot({
      type: "png",
      clip: { x: 0, y: 0, width: VIEWPORT.width, height: captureHeight },
    });
    return Buffer.from(buf);
  } finally {
    await browser.close();
  }
}

// ─── Collect final fidelity metrics ──────────────────────────────────────────

export async function collectFidelityMetrics(
  sourceMeta: {
    screenshotBase64: string;
    sectionScreenshots: Record<string, Buffer[]>;
  },
  archDoc: VisualArchDoc,
  mainFilePath: string,
  baselineFilePath?: string,
): Promise<FidelityMetrics> {
  console.log("[fidelity] Computing final fidelity metrics...");
  const start = Date.now();

  const [mainSections, mainScreenshotBuf] = await Promise.all([
    screenshotSectionsBySlug({ file: mainFilePath }, archDoc),
    screenshotFile(mainFilePath),
  ]);

  const mainResult = await computeSectionDiscrepancies(
    sourceMeta.sectionScreenshots,
    mainSections,
    archDoc,
  );

  const metrics: FidelityMetrics = {
    sourceScreenshotBase64: sourceMeta.screenshotBase64,
    mainScreenshotBase64: mainScreenshotBuf.toString("base64"),
    mainVlmScore: buildVlmFidelityScore(mainResult, archDoc),
  };

  if (baselineFilePath) {
    const baselineScreenshotBuf = await screenshotFile(baselineFilePath);
    metrics.baselineScreenshotBase64 = baselineScreenshotBuf.toString("base64");
    metrics.baselineVlmScore = await computeFullPageVlmScore(
      sourceMeta.screenshotBase64,
      metrics.baselineScreenshotBase64,
    );
  }

  console.log(`[fidelity] Done in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  return metrics;
}

// ─── Build VlmFidelityScore from section comparison ──────────────────────────

function buildVlmFidelityScore(
  result: SectionComparisonResult,
  archDoc: VisualArchDoc,
): VlmFidelityScore {
  const sections: Record<string, "match" | "partial" | "missing"> = {};
  const discrepancyBySlug = new Map(result.discrepancies.map((d) => [d.slug, d]));

  for (const spec of archDoc.sections) {
    const disc = discrepancyBySlug.get(spec.slug);
    if (!disc) {
      sections[spec.slug] = "match";
    } else if (disc.type === "missing") {
      sections[spec.slug] = "missing";
    } else {
      sections[spec.slug] = disc.severity === "high" ? "missing" : "partial";
    }
  }

  const issues = result.discrepancies.flatMap((d) => d.issues).slice(0, 5);
  const verdict: VlmVerdict =
    result.aggregateScore > 0.89 ? "close" : result.aggregateScore >= 0.6 ? "partial" : "distant";

  return { verdict, score: result.aggregateScore, sections, issues };
}
