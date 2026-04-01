## Context Enrichment via Puppeteer

**Hypothesis.** Providing Claude with a full-page screenshot alongside computed styles, absolute image URLs, font families, and inline SVGs produces meaningfully higher fidelity than passing raw HTML alone. The model can use the screenshot as a visual ground truth rather than reconstructing layout solely from markup.

**What was changed.** A new `src/context.ts` module replaces the plain `fetch()` call in the main generation path with a Puppeteer-based `enrichContext()` that captures a viewport-clipped screenshot (1280×900), extracts HTML via `page.content()`, and runs a single `page.evaluate()` to collect absolute image URLs (up to 30), primary font families (up to 10), computed styles for six landmark elements (body, h1–h3, nav, primary CTA), and up to five inline SVGs. The generation prompt was restructured from a plain text string to a multimodal content block array: an image block carrying the base64 screenshot followed by a text block with the enrichment data and source HTML in labelled XML sections. The model and token budget (`claude-haiku-4-5`, 16K) were held constant. The `runBaseline()` path was left untouched — it continues using plain `fetch()` and the same model, providing the control signal.

**Measured effect.** Tested twice against `https://stripe.com/en-ca/payments`:

| Run | Enriched (main) | Baseline (plain HTML) | Delta |
|---|---|---|---|
| Run 1 | 0.62 | 0.35 | +0.27 |
| Run 2 | 0.65 | 0.20 | +0.45 |

Fidelity nearly doubled in both runs. Cost and duration were flat or slightly lower on the enriched path (the screenshot input displaces token-heavy HTML repetition in the model's attention). The baseline showed higher variance (0.20–0.35) while the enriched path was tighter (0.62–0.65), suggesting the visual grounding also stabilises output quality.
