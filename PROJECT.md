# Project Summary: Superpilot Page Generation

## Purpose

This project is a CLI tool that uses AI to generate self-contained HTML landing pages from a source URL. It is a work sample for Superpilot, a product that creates conversion-focused landing pages for merchants on Salesforce B2C Commerce and Shopify. The central quality goal is **fidelity** — how closely the generated page reproduces the source page's layout, copy, images, and visual theme.

## Design

The tool accepts a URL, fetches its raw HTML, and passes that source to Claude (via the Anthropic SDK) with instructions to recreate the page as a single-file Tailwind CSS document. Claude is constrained to respond by calling a `save_file` tool, which writes the output HTML to the `output/` directory. Generation is single-iteration: one prompt, one tool call, one saved file.

The CLI layer is thin: it parses the URL argument and an optional `--open` flag, delegates all work to the agent module, and optionally opens the result in the browser. A lightweight renderer streams Claude's response to the terminal in real time, displaying thinking blocks, tool progress dots, and success/failure indicators using ANSI color codes.

## Architecture

The project has three source modules under `src/`:

**`cli.ts`** is the entry point. It uses `commander` to define the `page-gen` command, parses arguments, calls `generatePage`, and handles the `--open` flag by invoking `open` via `execSync`.

**`agent.ts`** contains the core generation logic. It fetches the source URL, truncates the HTML to 80,000 characters if needed, defines a Zod-typed `save_file` tool using the Anthropic SDK's `betaZodTool` helper, and runs a streaming `toolRunner` against `claude-haiku-4-5` with `max_iterations: 1`. The tool call handler creates the `output/` directory and writes the file to disk.

**`render.ts`** consumes the streaming `BetaToolRunner` and prints structured progress to stdout: thinking blocks are dimmed, tool names are cyan, input streaming progress appears as yellow dots, and completion is confirmed in green. After each tool use it calls `generateToolResponse()` and prints the result.

The runtime stack is TypeScript compiled with `tsx` (no build step), with `dotenv` for `ANTHROPIC_API_KEY` injection, `zod` for tool schema validation, and `prettier` and `tsc --noEmit` for code quality.

## Known Limitations and Open Challenge

The current implementation has limited fidelity. The prompt gives Claude only raw HTML (truncated), which lacks rendered layout information, computed styles, images, and fonts. The agent runs for exactly one iteration with no self-evaluation loop. The challenge set out in the README is to improve fidelity across layout, copy, images, and theme — for example by providing richer context (screenshots, CSS, network resources), adding a multi-turn evaluation loop, or incorporating visual comparison tooling.
