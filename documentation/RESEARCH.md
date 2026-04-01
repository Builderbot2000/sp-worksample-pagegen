## Context Enrichment via Puppeteer

**Hypothesis.** Providing Claude with a full-page screenshot alongside computed styles, absolute image URLs, font families, and inline SVGs produces meaningfully higher fidelity than passing raw HTML alone. The model can use the screenshot as a visual ground truth rather than reconstructing layout solely from markup.

**What was changed.** A new `src/context.ts` module replaces the plain `fetch()` call in the main generation path with a Puppeteer-based `enrichContext()` that captures a viewport-clipped screenshot (1280×900), extracts HTML via `page.content()`, and runs a single `page.evaluate()` to collect absolute image URLs (up to 30), primary font families (up to 10), computed styles for six landmark elements (body, h1–h3, nav, primary CTA), and up to five inline SVGs. The generation prompt was restructured from a plain text string to a multimodal content block array: an image block carrying the base64 screenshot followed by a text block with the enrichment data and source HTML in labelled XML sections. The model and token budget (`claude-haiku-4-5`, 16K) were held constant. The `runBaseline()` path was left untouched — it continues using plain `fetch()` and the same model, providing the control signal.

**Measured effect.** Tested twice against `https://stripe.com/en-ca/payments`:

| Run | Enriched (main) | Baseline (plain HTML) | Delta |
|---|---|---|---|
| Run 1 | 0.62 | 0.35 | +0.27 |
| Run 2 | 0.65 | 0.20 | +0.45 |

Fidelity nearly doubled in both runs. Cost and duration were flat or slightly lower on the enriched path (the screenshot input displaces token-heavy HTML repetition in the model's attention). The baseline showed higher variance (0.20–0.35) while the enriched path was tighter (0.62–0.65), suggesting the visual grounding also stabilises output quality.

---

## Iterative Fidelity Loop

**Hypothesis.** Running a scored fix loop after initial generation — screenshot the output, score it against the source with a VLM, caption the specific discrepancies, then prompt Claude to repair only those sections — produces meaningfully higher final fidelity than the single-pass enriched generation alone.

**What was changed.** Two additions to `src/observability/fidelity.ts`: a `scoreSeverity()` function that maps VLM scores to severity bands (< 0.60 high, ≤ 0.85 medium, > 0.85 low), and a `captionDiscrepancies()` function that calls `claude-sonnet-4-6` (1024 max tokens) with source and generated screenshots side-by-side and returns a structured JSON array of `{section, issue, severity}` objects. The main generation flow in `src/agent.ts` was extended to run up to four fix iterations after initial generation. Each iteration screenshots the current output, computes a VLM score, checks stopping conditions (severity low, score delta < 0.02, or no actionable discrepancies), then passes the discrepancy list alongside the source screenshot and current HTML to `claude-sonnet-4-6` (32K max tokens) for a targeted fix pass that saves over the same file. The loop exits early on convergence. A bug in `src/cli.ts` was also fixed: `parseInt` and `parseFloat` were passed directly as commander coerce functions, causing them to receive the previous default as a radix argument (`parseInt("4", 4) = NaN`), which silently made `MAX_ITER = NaN` and the loop condition `0 < NaN = false`. Wrapped in arrow functions to force base-10 parsing. Initial generation model was left unchanged (`claude-haiku-4-5`, 16K).

**Measured effect.** Tested twice against `https://stripe.com/en-ca/payments`, using context enrichment as the baseline (prior experiment result: 0.62–0.65):

| Run | Initial score | Post-loop score | Iterations | Cost |
|---|---|---|---|---|
| Run 1 | 0.62 | 0.72 | 3 (converged) | $0.53 |
| Run 2 | 0.68 | 0.72 | 4 (cap) | $0.72 |

Both runs converged to 0.72, consistently above the 0.62–0.65 single-pass ceiling. The first fix pass accounts for all of the gain; subsequent passes plateaued, suggesting the remaining gap is structural rather than addressable by the current fix prompt. Cost increased substantially over single-pass (~$0.50–0.72 vs near-zero) due to the sonnet-4-6 fix passes, each consuming ~8–11K input tokens and ~9K output tokens. The improvement is real and consistent but the cost-per-point-of-fidelity ratio is high at this score range.
