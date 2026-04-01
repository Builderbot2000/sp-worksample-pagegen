import puppeteer from "puppeteer";

export interface ScreenshotResult {
  buffer: Buffer;
  width: number;
  height: number;
}

/**
 * Screenshots an entire page at 1440×900 viewport.
 * @param target - A fully qualified URL or `file:///absolute/path.html`
 */
export async function screenshotPage(target: string): Promise<ScreenshotResult> {
  const browser = await puppeteer.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    await page.goto(target, { waitUntil: "networkidle2" });

    const buffer = await page.screenshot({
      fullPage: true,
      type: "png",
      encoding: "binary",
    });

    const pageHeight = await page.evaluate(
      () => document.documentElement.scrollHeight,
    );

    return {
      buffer: Buffer.from(buffer),
      width: 1440,
      height: pageHeight,
    };
  } finally {
    await browser.close();
  }
}
