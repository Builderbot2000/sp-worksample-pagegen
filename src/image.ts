import sharp from "sharp";

/** Resize a screenshot to a resolution optimised for Claude VLM input. */
export async function resizeForVlm(buf: Buffer): Promise<Buffer> {
  return sharp(buf)
    .resize({ width: 1024, withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .toBuffer();
}
