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

Output goes to `output/<timestamp>-<name|url-slug>/` and includes:

```
run.ndjson              # append-only event stream
run.json                # final snapshot (images stripped)
report.html             # visual report
main/<page>.html        # generated HTML
source.png              # full-page source screenshot
sections/               # per-section source crops (source-<slug>.png)
fidelity/               # VLM scorer screenshots (main.png, baseline.png, sections/)
```

The `fidelity/` directory is only written when `--correction` is used (fidelity scoring runs after the correction loop).

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
npm run test:generate -- <url> --name <label> --correction --quality quality
```

Output goes to `output/<timestamp>-<name|generate-test>/` and includes `main/<page>.html`, `screenshot.png`, `arch.json`, `sections/` (per-section source and generated crops), and `report.html`.

```sh
# Example
npm run test:generate -- https://stripe.com/en-ca/payments --name stripe-initial-gen-test --correction --quality quality
```

### Correction loop test

Runs the full crawl → initial generation → correction loop in isolation and produces a visual iteration-by-iteration report. Useful for inspecting what the section scorer finds, how discrepancies evolve across iterations, and whether fixes are taking effect.

```sh
npm run test:correction-loop -- <url>
npm run test:correction-loop -- <url> --name <label>
npm run test:correction-loop -- <url> --name <label> --out <dir> --quality quality
npm run test:correction-loop -- <url> --name <label> --out <dir> --max-iter <n>
```

Flags:

```sh
--name <label>                  # label for the output directory (default: correction-loop-test)
--out <dir>                     # explicit output directory
--quality draft|standard|quality  # sets max iterations: draft=0, standard=2, quality=3 (default: 4 when omitted)
--max-iter <n>                  # explicit iteration cap — overrides --quality
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
npm run test:correction-loop -- https://stripe.com/en-ca/payments --name stripe-correction-test --quality standard
```

### Report regeneration

Regenerates `report.html` and `visualizer.html` for any completed run without re-running the pipeline. Reads `run.json`, the on-disk screenshots, and the `run.ndjson` event stream saved during the original run.

```sh
npm run report -- <run-directory>
```

```sh
# Example
npm run report -- output/1775259398171-stripe-correction-test
```

Both `report.html` (static metrics summary) and `visualizer.html` (step-by-step pipeline animation) are written to the run directory.

### Pipeline visualizer

`visualizer.html` is produced automatically alongside `report.html` on every run and every `npm run report` invocation. Open it in a browser to replay the full pipeline event-by-event:

- **Stage lanes** show each phase (Preprocess, Skeleton, Sections, Assembly, Correction iterations, Fidelity) transitioning idle → active → complete as events arrive
- **Section chips** pop in on generation start and update with VLM scores as scoring events arrive
- **Artifact panel** shows the relevant screenshot, stats, or comparison for the current event — source vs generated side-by-side for score events, fidelity screenshot on completion, and full summary on run complete
- **Playback controls** — play/pause, step forward/back, scrubber, speed (0.5×/1×/2×/4×), loop

Images are loaded from relative paths in the run directory, so open the file directly from its output folder.

### Motion Canvas visualizer

An animated step-by-step visualizer built with Motion Canvas. Unlike `visualizer.html`, this one renders as a proper animation with synchronized panning screenshots, staggered reveals, and a score count-up — viewable in the Motion Canvas editor or exported as video.

```sh
npm run viz:mc -- <run-directory>
```

```sh
# Example
npm run viz:mc -- output/1775350622628-stripe-en-ca-payments-reference
```

This writes the run data into the MC sub-project and starts the Vite dev server at `http://localhost:9000`. Open that URL in a browser to play back the animation in the Motion Canvas editor.

The visualizer has five scenes that play in order:

1. **Start** — source screenshot pan, run URL, config chips, source HTML snippet
2. **Preprocess** — annotated screenshot with section bounding boxes and per-section cards
3. **Skeleton** — skeleton screenshot pan alongside the generated HTML structure
4. **Sections & Assembly** — section-by-section generation with score bars and correction passes
5. **End** — source vs generated side-by-side with animated fidelity score (only shown when `--correction` was used)

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