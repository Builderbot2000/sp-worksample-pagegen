import puppeteer from "puppeteer";
import Anthropic from "@anthropic-ai/sdk";
import * as path from "path";
import type {
  DomInfo,
  VlmFidelityScore,
  DomDiffResult,
  FidelityMetrics,
} from "./types";

// ─── Viewport ─────────────────────────────────────────────────────────────────

const VIEWPORT = { width: 1280, height: 900 };

// ─── Screenshot + DOM extraction ──────────────────────────────────────────────

interface ScreenshotResult {
  screenshot: Buffer;
  domInfo: DomInfo;
}

export async function screenshotAndExtract(
  target: { url: string } | { file: string },
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

    const screenshot = await page.screenshot({
      type: "png",
      clip: { x: 0, y: 0, ...VIEWPORT },
    });

    const domInfo = await page.evaluate((): DomInfo => {
      const headingEls = Array.from(
        document.querySelectorAll("h1,h2,h3,h4,h5,h6"),
      );
      const headings = headingEls.map((el) => ({
        tag: el.tagName.toLowerCase(),
        text: (el.textContent ?? "").trim().slice(0, 200),
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

    return { screenshot: Buffer.from(screenshot), domInfo };
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

// ─── Severity band ────────────────────────────────────────────────────────────

export function scoreSeverity(score: number): "high" | "medium" | "low" {
  if (score > 0.85) return "low";
  if (score >= 0.6) return "medium";
  return "high";
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
): Promise<Discrepancy[]> {
  try {
    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system: CAPTION_SYSTEM,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: sourceBase64 },
            },
            { type: "text", text: "SOURCE screenshot above." },
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: generatedBase64 },
            },
            {
              type: "text",
              text: "RECONSTRUCTION screenshot above. List all high and medium severity discrepancies as a JSON array.",
            },
          ],
        },
      ],
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

// ─── DOM diff ─────────────────────────────────────────────────────────────────

export function computeDomDiff(
  source: DomInfo,
  target: DomInfo,
): DomDiffResult {
  const sourceHeadings = new Set(source.headings.map((h) => h.text));
  const targetHeadings = new Set(target.headings.map((h) => h.text));

  const missingHeadings = source.headings
    .filter((h) => !targetHeadings.has(h.text))
    .map((h) => `${h.tag}: ${h.text}`);

  const extraHeadings = target.headings
    .filter((h) => !sourceHeadings.has(h.text))
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
    score,
  };
}

// ─── Orchestrator ─────────────────────────────────────────────────────────────

export async function collectFidelityMetrics(
  url: string,
  mainFilePath: string,
  baselineFilePath?: string,
): Promise<FidelityMetrics> {
  console.log("[fidelity] Capturing screenshots and extracting DOM...");
  const start = Date.now();

  const targets: Array<Promise<ScreenshotResult>> = [
    screenshotAndExtract({ url }),
    screenshotAndExtract({ file: mainFilePath }),
  ];
  if (baselineFilePath) {
    targets.push(screenshotAndExtract({ file: baselineFilePath }));
  }

  const results = await Promise.all(targets);
  const [sourceResult, mainResult, baselineResult] = results;

  const sourceBase64 = sourceResult.screenshot.toString("base64");
  const mainBase64 = mainResult.screenshot.toString("base64");
  const baselineBase64 = baselineResult?.screenshot.toString("base64");

  // Run VLM scoring and DOM diff in parallel (and baseline VLM if present)
  const vlmPromises: Promise<VlmFidelityScore>[] = [
    computeVlmFidelityScore(sourceBase64, mainBase64),
  ];
  if (baselineBase64) {
    vlmPromises.push(computeVlmFidelityScore(sourceBase64, baselineBase64));
  }

  const [mainVlmScore, baselineVlmScore] = await Promise.all(vlmPromises);
  const mainDomDiff = computeDomDiff(sourceResult.domInfo, mainResult.domInfo);

  const metrics: FidelityMetrics = {
    sourceScreenshotBase64: sourceBase64,
    mainScreenshotBase64: mainBase64,
    mainVlmScore,
    mainDomDiff,
  };

  if (baselineResult && baselineBase64 && baselineVlmScore) {
    metrics.baselineScreenshotBase64 = baselineBase64;
    metrics.baselineVlmScore = baselineVlmScore;
    metrics.baselineDomDiff = computeDomDiff(
      sourceResult.domInfo,
      baselineResult.domInfo,
    );
  }

  console.log(`[fidelity] Done in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  return metrics;
}
