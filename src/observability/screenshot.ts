import puppeteer from "puppeteer";
import * as path from "path";

const VIEWPORT = { width: 1280, height: 900 };

/**
 * Renders an HTML file in a headless browser and returns a full-page PNG
 * screenshot as a Buffer. Pass a `file://` URL or an absolute path — absolute
 * paths are resolved to a `file://` URL automatically.
 */
export async function screenshotHtmlFile(filePath: string): Promise<Buffer> {
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport(VIEWPORT);
    const url = filePath.startsWith("file://")
      ? filePath
      : `file://${path.resolve(filePath)}`;
    await page.goto(url, { waitUntil: "networkidle2", timeout: 30_000 });
    const buf = await page.screenshot({ type: "png", fullPage: true });
    return Buffer.from(buf);
  } finally {
    await browser.close();
  }
}
