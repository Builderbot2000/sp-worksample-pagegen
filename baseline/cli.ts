import "dotenv/config";
import { Command } from "commander";
import { execSync } from "child_process";
import { generatePage } from "./agent";

const program = new Command()
  .name("page-gen")
  .description("Generate a Tailwind CSS page from a source URL using Claude")
  .argument("<url>", "URL of the source page")
  .option("--open", "Open the generated file in the default browser")
  .action(async (url: string, opts: { open?: boolean }) => {
    const savedPath = await generatePage(url);

    if (opts.open && savedPath) {
      execSync(`open ${savedPath}`);
    }
  });

program.parseAsync();
