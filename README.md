# Superpilot Page Generation

This repo contains a CLI that uses AI to create a single-file HTML page from a source URL.

Superpilot uses AI to create conversion-focused landing pages for merchants on Salesforce B2C Commerce and Shopify. 

A key quality metric is **fidelity** to the source page — how closely the generated page matches the original's layout, copy, images, and theme.

This repo contains a starter implementation. Your goal is to improve fidelity.

## Setup

```sh
npm install
```

Requires `ANTHROPIC_API_KEY` in your environment.

## Usage

```sh
npm run generate -- <url>                  # generate a page
npm run generate -- <url> --iterations 6   # set max fix iterations (default: 4)
npm run generate -- <url> --threshold 0.01 # convergence delta threshold (default: 0.02)
npm run generate -- <url> --baseline       # run baseline agent in parallel and compare
```

The `--baseline` flag runs the baseline agent (Haiku 4-5, single-pass) alongside the main agent (Sonnet 4-6, iterative) and produces a side-by-side comparison in the report.

**Example:**

```sh
npm run generate -- https://stripe.com/payments --iterations 4 --threshold 0.02 --baseline
```

Output goes to `output/<run-id>/` and includes:

- `run.json` — structured run record (tokens, cost, iterations, scores)
- `run.ndjson` — append-only event log
- `report.html` — self-contained HTML dashboard; auto-opens after every run
- `main/<page>.html` — main generated HTML; auto-opens after every run
- `baseline/<page>.html` — baseline HTML (when `--baseline` is used); auto-opens

## Development

```sh
npm run check          # typecheck
npm run format         # format with prettier
npm run format:check   # check formatting
```

## The Challenge

Improve the **fidelity** of generated pages. The output should closely match the source page across four dimensions:

- **Layout** — structure, spacing, responsiveness
- **Copy** — text content, headings, calls to action
- **Images** — hero images, logos, product photos
- **Theme** — colors, fonts, visual style

Some things to think about:

- How might you give the agent more context about the source page?
- How might the agent evaluate whether its output is faithful?
- What tools or techniques could help close the gap?