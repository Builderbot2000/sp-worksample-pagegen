import "dotenv/config";
import { Command } from "commander";
import { spawnSync } from "child_process";
import { generatePage } from "./agent";

function openFiles(targets: string[]): void {
  if (targets.length === 0) return;
  // Try Chromium-family browsers first — all targets become tabs in one new window
  const chromiumBrowsers = ["google-chrome", "google-chrome-stable", "chromium-browser", "chromium"];
  for (const browser of chromiumBrowsers) {
    const result = spawnSync(browser, ["--new-window", ...targets], { stdio: "ignore" });
    if (result.status === 0 || result.error === undefined) return;
  }
  // Firefox also accepts multiple URL args as tabs
  const firefox = spawnSync("firefox", targets, { stdio: "ignore" });
  if (firefox.status === 0 || firefox.error === undefined) return;
  // Last resort: open each file individually via xdg-open
  for (const t of targets) {
    spawnSync("xdg-open", [t], { stdio: "ignore" });
  }
}

const program = new Command()
  .name("page-gen")
  .description("Generate a Tailwind CSS page from a source URL using Claude")
  .argument("<url>", "URL of the source page")
  .option("--iterations <n>", "Max fix iterations after initial generation (default: 4)", "4")
  .option("--threshold <n>", "Convergence score delta threshold (default: 0.02)", "0.02")
  .option("--baseline", "Run baseline agent in parallel and compare results")
  .action(
    async (
      url: string,
      opts: { iterations: string; threshold: string; baseline?: boolean },
    ) => {
      const result = await generatePage(url, {
        maxIterations: parseInt(opts.iterations, 10),
        threshold: parseFloat(opts.threshold),
        baseline: opts.baseline ?? false,
      });

      if (result) {
        const targets = [
          result.reportPath,
          result.savedPath,
          ...(result.baselineSavedPath ? [result.baselineSavedPath] : []),
          url,
        ];
        openFiles(targets);
      }
    },
  );

program.parseAsync();
