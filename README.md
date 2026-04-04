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
npm run generate -- <url>          # generate a page
npm run generate -- <url> --open   # generate and open in browser
```

All flags:

```sh
npm run generate -- <url> \
  --name <label>        # human-readable name for the run (used in report title and output directory)
  --quality <mode>      # quality/budget mode: draft | standard | quality (default: standard)
  --baseline            # also run the baseline agent and produce a side-by-side comparison report
  --correction          # run per-section correction loop after initial generation
  --open                # open the generated file in the default browser
```

### Quality modes

The `--quality` flag controls the maximum number of correction iterations run per section when `--correction` is enabled. The skeleton always uses a dynamically scaled token budget.

| Mode | Max correction iterations | Relative cost |
|---|---|---|
| `draft` | 0 — single-pass generation only | ~$1–2 |
| `standard` | 2 (default) | ~$2.50–3.50 |
| `quality` | 3 | ~$3.50–5 |

Output goes to `output/<timestamp>-<name|url-slug>/` and includes `run.ndjson`, `run.json`, `report.html`, and `main/<page>.html`.

### Reference experiment

To run the canonical reference experiment — experimental pipeline vs. baseline on the Stripe Canada payments page:

```sh
npm run generate -- https://stripe.com/en-ca/payments \
  --name stripe-en-ca-payments-reference \
  --quality standard \
  --correction \
  --baseline
```

This produces a `report.html` with a side-by-side fidelity score, cost, and duration comparison between the two pipelines. Use this as the control run when measuring the effect of any new integration.

## Development

```sh
npm run check          # typecheck
npm run format         # format with prettier
npm run format:check   # check formatting
```

### Preprocessing test

Runs `crawlAndPreprocess()` in isolation and writes a visual report showing the detected sections, per-section screenshots, crawl metadata, and extracted styles — without invoking the LLM.

```sh
npm run test:preprocess -- <url>
npm run test:preprocess -- <url> --name <label>
npm run test:preprocess -- <url> --name <label> --out <dir>
```

Output goes to `output/<timestamp>-<name|preprocess-test>/` and includes `arch.json`, `screenshot.png`, `sections/`, and `report.html`.

```sh
# Example
npm run test:preprocess -- https://stripe.com/payments --name stripe-preprocessing-test
```

### Skeleton test

Runs the crawl + Stage 1 skeleton generation in isolation. Useful for verifying that the skeleton agent correctly renders all global elements (nav, fonts, CSS custom properties, Tailwind config) and produces empty labeled section shells — before committing to the full parallel pipeline run.

```sh
npm run test:skeleton -- <url>
npm run test:skeleton -- <url> --name <label>
npm run test:skeleton -- <url> --name <label> --out <dir>
```

Output goes to `output/<timestamp>-<name|skeleton-test>/` and includes `main/<page>-skeleton.html`, `screenshot.png`, `arch.json`, and `report.html`.

The report shows the section shell table (slug, role, description) so you can cross-check which shells the model was asked to produce. Open `main/<page>-skeleton.html` directly to verify global elements are rendered and section interiors are blank.

```sh
# Example
npm run test:skeleton -- https://stripe.com/payments --name stripe-skeleton-test
```

### Generate test

Runs the crawl + full initial generation (skeleton → parallel section agents → assembly) in isolation (no correction loop, no patching). Useful for iterating on the generation prompts without waiting for the full pipeline. Pass `--correction` to also run the per-section correction loop after assembly.

```sh
npm run test:generate -- <url>
npm run test:generate -- <url> --name <label>
npm run test:generate -- <url> --name <label> --out <dir>
npm run test:generate -- <url> --name <label> --correction
```

Output goes to `output/<timestamp>-<name|generate-test>/` and includes `main/<page>.html`, `screenshot.png`, `arch.json`, and `report.html`.

```sh
# Example
npm run test:generate -- https://stripe.com/payments --name stripe-initial-gen-test
```

### Correction loop test

Runs the full crawl → initial generation → correction loop in isolation and produces a visual iteration-by-iteration report. Useful for inspecting what the section scorer finds, how discrepancies evolve across iterations, and whether fixes are taking effect.

```sh
npm run test:correction-loop -- <url>
npm run test:correction-loop -- <url> --name <label>
npm run test:correction-loop -- <url> --name <label> --out <dir> --max-iter <n>
```

Flags:

```sh
--name <label>     # label for the output directory (default: correction-loop-test)
--out <dir>        # explicit output directory
--max-iter <n>     # max correction iterations (default: 4)
```

Output goes to `output/<timestamp>-<name|correction-loop-test>/` and includes `main/<page>.html` and `report.html`.

The report shows one card per iteration with:
- Aggregate fidelity score, severity, and section match stats
- Side-by-side source vs generated screenshots for every section with issues or newly resolved
- Discrepancies labeled **NEW** or **PERSISTS**, with individual issues marked when carried over from the previous iteration
- Sections resolved since the previous iteration highlighted with a **✓ RESOLVED** badge
- Collapsible list of passing sections

```sh
# Example
npm run test:correction-loop -- https://stripe.com/payments --name stripe-correction-test
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