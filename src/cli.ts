import "dotenv/config";
import { Command } from "commander";
import { execSync } from "child_process";
import { generatePage } from "./agent";

const program = new Command()
  .name("page-gen")
  .description("Generate a Tailwind CSS page from a source URL using Claude")
  .argument("<url>", "URL of the source page")
  .option("--open", "Open the generated file in the default browser")
  .option("--iterations <n>", "Max fix iterations after initial generation (default: 4)", "4")
  .option("--threshold <n>", "Convergence score delta threshold (default: 0.02)", "0.02")
  .action(
    async (
      url: string,
      opts: { open?: boolean; iterations: string; threshold: string },
    ) => {
      const savedPath = await generatePage(url, {
        maxIterations: parseInt(opts.iterations, 10),
        threshold: parseFloat(opts.threshold),
      });

      if (opts.open && savedPath) {
        execSync(`open ${savedPath}`);
      }
    },
  );

program.parseAsync();
