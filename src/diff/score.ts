import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import type { Severity } from "../observability/types";

export interface PageScore {
  score: number;
  severity: Severity;
  diffPixels: number;
  totalPixels: number;
  /** 1440×900px PNG chunks of the source page, top-to-bottom */
  sourceChunks: Buffer[];
  /** 1440×900px PNG chunks of the generated page, top-to-bottom */
  generatedChunks: Buffer[];
  /** 1440×900px PNG chunks of the pixelmatch diff mask, top-to-bottom */
  diffChunks: Buffer[];
}

const CHUNK_H = 900;
const MAX_CHUNKS = 5;

function severityBand(score: number): Severity {
  if (score < 0.6) return "high";
  if (score <= 0.85) return "medium";
  return "low";
}

/**
 * Pads RGBA pixel data from (origWidth × origHeight) to (targetWidth × targetHeight)
 * with opaque white pixels. Both pages are captured at 1440px wide so widths match.
 */
function padToHeight(
  data: Buffer,
  origHeight: number,
  targetWidth: number,
  targetHeight: number,
): Buffer {
  if (origHeight >= targetHeight) return data;
  const rowBytes = targetWidth * 4;
  const out = Buffer.alloc(targetWidth * targetHeight * 4, 255);
  data.copy(out, 0, 0, origHeight * rowBytes);
  return out;
}

/**
 * Encodes a horizontal strip of a flat RGBA buffer as a PNG Buffer.
 */
function encodeChunk(
  data: Buffer,
  width: number,
  startY: number,
  chunkH: number,
): Buffer {
  const rowBytes = width * 4;
  const png = new PNG({ width, height: chunkH });
  // pngjs initialises data to null; set it explicitly before encoding
  png.data = data.slice(startY * rowBytes, (startY + chunkH) * rowBytes) as unknown as Buffer;
  return PNG.sync.write(png);
}

/**
 * Full-page pixel diff of source vs generated screenshots.
 * Both buffers must be full-page PNG images captured at 1440px wide.
 * Returns a PageScore with chunked PNG images ready to send to Claude.
 */
export function scorePage(
  sourceBuffer: Buffer,
  generatedBuffer: Buffer,
): PageScore {
  const src = PNG.sync.read(sourceBuffer);
  const gen = PNG.sync.read(generatedBuffer);

  const width = src.width; // both are 1440px
  const height = Math.max(src.height, gen.height);

  const srcData = padToHeight(src.data as unknown as Buffer, src.height, width, height);
  const genData = padToHeight(gen.data as unknown as Buffer, gen.height, width, height);
  const diffData = Buffer.alloc(width * height * 4);

  const diffPixels = pixelmatch(srcData, genData, diffData, width, height, {
    threshold: 0.1,
  });
  const totalPixels = width * height;
  const score = 1 - diffPixels / totalPixels;

  const numChunks = Math.min(MAX_CHUNKS, Math.ceil(height / CHUNK_H));
  const sourceChunks: Buffer[] = [];
  const generatedChunks: Buffer[] = [];
  const diffChunks: Buffer[] = [];

  for (let i = 0; i < numChunks; i++) {
    const y = i * CHUNK_H;
    const h = Math.min(CHUNK_H, height - y);
    sourceChunks.push(encodeChunk(srcData, width, y, h));
    generatedChunks.push(encodeChunk(genData, width, y, h));
    diffChunks.push(encodeChunk(diffData, width, y, h));
  }

  return {
    score,
    severity: severityBand(score),
    diffPixels,
    totalPixels,
    sourceChunks,
    generatedChunks,
    diffChunks,
  };
}
