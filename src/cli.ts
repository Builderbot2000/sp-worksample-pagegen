import "dotenv/config";
import { Command } from "commander";
import { execSync } from "child_process";
import { generatePage } from "./agent";
import type { GenerateOptions } from "./agent";
import type { QualityMode } from "./observability/types";

const QUALITY_CHOICES: QualityMode[] = ["draft", "standard", "quality"];

const program = new Command()
  .name("page-gen")
  .description("Generate a Tailwind CSS page from a source URL using Claude")
  .argument("<url>", "URL of the source page")
  .option("--name <label>", "Human-readable name for this run")
  .option(
    "--quality <mode>",
    `Quality/budget mode: ${QUALITY_CHOICES.join(" | ")} (default: standard)`,
    (v) => {
      if (!QUALITY_CHOICES.includes(v as QualityMode)) {
        throw new Error(`--quality must be one of: ${QUALITY_CHOICES.join(", ")}`);
      }
      return v as QualityMode;
    },
  )
  .option("--baseline", "Also run the baseline agent for comparison")
  .option("--correction", "Run per-section correction loop after initial generation")
  .option("--open", "Open the generated file in the default browser")
  .action(async (url: string, opts: GenerateOptions & { open?: boolean }) => {
    const savedPath = await generatePage(url, opts);

    if (opts.open && savedPath) {
      execSync(`open ${savedPath}`);
    }
  });

program.parseAsync();

