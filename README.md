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
  --fidelity <mode>     # quality/budget mode: minimal | fast | balanced | high | maximal (default: balanced)
  --threshold <n>       # convergence score delta threshold (default: 0.02)
  --baseline            # also run the baseline agent and produce a side-by-side comparison report
  --open                # open the generated file in the default browser
```

### Fidelity modes

The `--fidelity` flag controls the number of fix iterations, token budgets at each stage, and whether wide-viewport screenshots are captured. The iteration count also scales with the size of the source page — larger sites (more headings) get more iterations, up to the mode's ceiling.

| Mode | Iterations | Struct batch | Wide viewport | Relative cost |
|---|---|---|---|---|
| `minimal` | 0 | — | No | ~$0.05 |
| `fast` | 2–3 | 10 | No | ~$0.20 |
| `balanced` | 3–6 | 15 | Yes | ~$0.50–1.50 |
| `high` | 4–8 | 20 | Yes | ~$1.50–4.00 |
| `maximal` | 6–12 | 30 | Yes | ~$4.00+ |

If the source page is too large for the chosen mode to cover fully, a warning is printed at the start of the run suggesting a higher mode.

Output goes to `output/<timestamp>-<name|url-slug>/` and includes `run.ndjson`, `run.json`, `report.html`, and `main/<page>.html`.

### Reference experiment

To run the canonical reference experiment — experimental pipeline vs. baseline on the Stripe Canada payments page:

```sh
npm run generate -- https://stripe.com/en-ca/payments \
  --name stripe-en-ca-payments-reference \
  --fidelity balanced \
  --baseline
```

This produces a `report.html` with a side-by-side fidelity score, cost, and duration comparison between the two pipelines. Use this as the control run when measuring the effect of any new integration.

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