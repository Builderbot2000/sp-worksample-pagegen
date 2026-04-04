import puppeteer from "puppeteer";
import Anthropic from "@anthropic-ai/sdk";
import * as fs from "fs";
import * as path from "path";
import { resizeForVlm } from "../image";
import { MODELS } from "../config";
import type {
  VlmFidelityScore,
  VlmVerdict,
  FidelityMetrics,
  VisualArchDoc,
  SectionDiscrepancy,
  SectionScoreEntry,
} from "./types";


const VIEWPORT = { width: 1280, height: 900 };
const MAX_SCREENSHOT_HEIGHT = 7800;
// Section pairs per VLM call — keep small to avoid context limit blowups on long pages
const VLM_BATCH_SIZE = 8;

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

    // A section must render to at least this fraction of its source height to be
    // considered renderable. Anything shorter is a collapsed/empty shell and gets
    // excluded so the scorer doesn't waste tokens on a thin strip.
    const MIN_HEIGHT_RATIO = 0.25;

    const result: Record<string, Buffer[]> = {};
    for (const spec of archDoc.sections) {
      const el = await page.$(`[data-section-slug="${spec.slug}"]`);
      if (!el) continue;
      const box = await el.boundingBox();

      if (!box || box.height < 4) {
        console.warn(`[fidelity] Skipping "${spec.slug}" — rendered height ${box?.height ?? 0}px (empty shell)`);
        continue;
      }

      const minRequired = spec.heightPx > 0 ? spec.heightPx * MIN_HEIGHT_RATIO : 4;
      if (box.height < minRequired) {
        console.warn(
          `[fidelity] Skipping "${spec.slug}" — rendered ${Math.round(box.height)}px vs expected ~${spec.heightPx}px ` +
          `(${Math.round((box.height / spec.heightPx) * 100)}% of source height, threshold ${Math.round(MIN_HEIGHT_RATIO * 100)}%)`,
        );
        continue;
      }

      const clipY = Math.max(0, box.y);
      const clipHeight = Math.min(box.height, MAX_SCREENSHOT_HEIGHT, scrollHeight - clipY);
      const buf = await page.screenshot({
        type: "png",
        clip: { x: 0, y: clipY, width: VIEWPORT.width, height: Math.max(4, clipHeight) },
      });
      result[spec.slug] = [Buffer.from(buf)];
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
  tokensIn: number;
  tokensOut: number;
  /** Full score entry for every section in archDoc (missing sections score 0 / "distant"). */
  sectionScores: Record<string, SectionScoreEntry>;
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
  const sectionScores: Record<string, SectionScoreEntry> = {};

  for (const spec of archDoc.sections) {
    if (!genSections[spec.slug]) {
      unmatchedSlugs.push(spec.slug);
      sectionScores[spec.slug] = { score: 0, verdict: "distant", issues: [`Section "${spec.slug}" (${spec.role}) is absent in the reconstruction`] };
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

  let tokensIn = 0;
  let tokensOut = 0;

  if (matchedSlugs.length > 0) {
    // Split all matched slugs into small batches and score in parallel
    const batches: string[][] = [];
    for (let i = 0; i < matchedSlugs.length; i += VLM_BATCH_SIZE) {
      batches.push(matchedSlugs.slice(i, i + VLM_BATCH_SIZE));
    }

    const batchResults = await Promise.all(
      batches.map(async (batch) => {
        const userContent: Anthropic.MessageParam["content"] = [];
        for (const slug of batch) {
          const sourceImgs = sourceSections[slug] ?? [];
          const genImgs = genSections[slug] ?? [];
          const spec = archDoc.sections.find((s) => s.slug === slug);
          const label = spec ? `${slug} (${spec.role})` : slug;
          const [srcResized, genResized] = await Promise.all([
            resizeForVlm(sourceImgs[0]),
            resizeForVlm(genImgs[0]),
          ]);
          userContent.push({
            type: "image",
            source: { type: "base64", media_type: "image/jpeg", data: srcResized.toString("base64") },
          });
          userContent.push({ type: "text", text: `Section "${label}" — SOURCE above.` });
          userContent.push({
            type: "image",
            source: { type: "base64", media_type: "image/jpeg", data: genResized.toString("base64") },
          });
          userContent.push({ type: "text", text: `Section "${label}" — RECONSTRUCTION above.` });
        }
        userContent.push({ type: "text", text: "Evaluate each section and respond with the JSON array only." });

        try {
          const response = await client.messages.create({
            model: MODELS.vlmScorer,
            max_tokens: opts?.maxTokens ?? 512 + 256 * batch.length,
            temperature: 0,
            system: SECTION_VLM_SYSTEM,
            messages: [{ role: "user", content: userContent }],
          });
          return {
            batch,
            text: response.content.find((b) => b.type === "text")?.text ?? "",
            tokensIn: response.usage.input_tokens,
            tokensOut: response.usage.output_tokens,
          };
        } catch (err) {
          console.error(`[fidelity] VLM batch failed [${batch.join(", ")}]:`, err);
          return { batch, text: null, tokensIn: 0, tokensOut: 0 };
        }
      }),
    );

    for (const result of batchResults) {
      tokensIn += result.tokensIn;
      tokensOut += result.tokensOut;

      if (result.text === null) {
        for (const slug of result.batch) {
          if (sectionScores[slug] === undefined) {
            sectionScores[slug] = { score: 0, verdict: "distant", issues: ["VLM scoring failed for this section"] };
            discrepancies.push({
              slug,
              type: "visual",
              severity: "high",
              issues: ["VLM scoring failed for this section"],
              score: 0,
            });
          }
        }
        continue;
      }

      const cleaned = result.text.replace(/^```[^\n]*\n?|```$/gm, "").trim();
      try {
        const parsed = JSON.parse(cleaned) as unknown[];
        if (Array.isArray(parsed)) {
          for (const d of parsed) {
            if (typeof d !== "object" || d === null || !("slug" in d) || !("score" in d) || !("verdict" in d))
              continue;
            const item = d as { slug: string; score: number; verdict: string; issues?: unknown[] };
            // VLM receives labels like "section-1 (hero)" and echoes them back — strip the role suffix
            const slug = item.slug.replace(/\s*\([^)]*\)\s*$/, "").trim();
            const score = Math.max(0, Math.min(1, Number(item.score)));
            const verdict: VlmVerdict = ["close", "partial", "distant"].includes(item.verdict)
              ? (item.verdict as VlmVerdict)
              : "distant";
            const issues = Array.isArray(item.issues)
              ? (item.issues as unknown[]).filter((s): s is string => typeof s === "string").slice(0, 3)
              : [];
            sectionScores[slug] = { score, verdict, issues };
            if (verdict !== "close") {
              discrepancies.push({
                slug,
                type: "visual",
                severity: verdict === "distant" ? "high" : "medium",
                issues,
                score,
              });
            }
          }
        }
      } catch {
        // JSON parse failed — mark the whole batch as failed
        for (const slug of result.batch) {
          if (sectionScores[slug] === undefined) {
            sectionScores[slug] = { score: 0, verdict: "distant", issues: ["VLM scoring failed for this section"] };
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
    }
  }

  const totalSections = archDoc.sections.length;
  const aggregateScore =
    totalSections > 0
      ? archDoc.sections.reduce((sum, s) => sum + (sectionScores[s.slug]?.score ?? 1), 0) / totalSections
      : 1;

  return {
    discrepancies,
    matched: matchedSlugs.length,
    unmatched: unmatchedSlugs.length,
    aggregateScore,
    tokensIn,
    tokensOut,
    sectionScores,
  };
}

// ─── Severity band ────────────────────────────────────────────────────────────

export function scoreSeverity(score: number): "high" | "medium" | "low" {
  if (score > 0.85) return "low";
  if (score >= 0.6) return "medium";
  return "high";
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
  fidelityDir?: string,
): Promise<{ metrics: FidelityMetrics; tokensIn: number; tokensOut: number; mainSectionPaths: Record<string, string> }> {
  console.log("[fidelity] Computing final fidelity metrics...");
  const start = Date.now();

  const [mainSections, mainScreenshotBuf] = await Promise.all([
    screenshotSectionsBySlug({ file: mainFilePath }, archDoc),
    screenshotFile(mainFilePath),
  ]);

  const mainSectionPaths: Record<string, string> = {};
  if (fidelityDir) {
    const secDir = path.join(fidelityDir, "sections");
    fs.mkdirSync(secDir, { recursive: true });
    for (const [slug, bufs] of Object.entries(mainSections)) {
      if (bufs[0]) {
        const fileName = `main-${slug}.png`;
        fs.writeFileSync(path.join(secDir, fileName), bufs[0]);
        mainSectionPaths[slug] = `fidelity/sections/${fileName}`;
      }
    }
  }

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
  }

  console.log(`[fidelity] Done in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  return { metrics, tokensIn: mainResult.tokensIn, tokensOut: mainResult.tokensOut, mainSectionPaths };
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
      // Visual discrepancies: section is present but mismatched — never "missing"
      sections[spec.slug] = "partial";
    }
  }

  const issues = result.discrepancies.flatMap((d) => d.issues).slice(0, 5);
  const verdict: VlmVerdict =
    result.aggregateScore > 0.89 ? "close" : result.aggregateScore >= 0.6 ? "partial" : "distant";

  return { verdict, score: result.aggregateScore, sections, issues };
}
