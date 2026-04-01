import "dotenv/config";
import { Command } from "commander";
import { execSync } from "child_process";
import { generatePage } from "./agent";
import type { GenerateOptions } from "./agent";

const program = new Command()
  .name("page-gen")
  .description("Generate a Tailwind CSS page from a source URL using Claude")
  .argument("<url>", "URL of the source page")
  .option("--name <label>", "Human-readable name for this run")
  .option("--iterations <n>", "Max fix iterations", (v) => parseInt(v, 10), 4)
  .option("--threshold <n>", "Convergence score threshold", (v) => parseFloat(v), 0.02)
  .option("--baseline", "Also run the baseline agent for comparison")
  .option("--open", "Open the generated file in the default browser")
  .action(async (url: string, opts: GenerateOptions & { open?: boolean }) => {
    const savedPath = await generatePage(url, opts);

    if (opts.open && savedPath) {
      execSync(`open ${savedPath}`);
    }
  });

program.parseAsync();

