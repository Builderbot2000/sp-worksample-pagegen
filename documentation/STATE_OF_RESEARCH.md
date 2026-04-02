# State of Research

All experiments target `https://stripe.com/en-ca/payments`. Fidelity scores are VLM scores on the first-fold screenshot unless noted. Baseline is the unmodified single-pass Haiku agent.

---

## Experiment Log

### 1. `baseline-vlm` — 1775075947805

First instrumented run. No fidelity loop. Established the baseline score without any fix passes.

Main: **0.20** · Cost: $0.052 · Duration: ~35s · Iterations: 0

Conclusion: Raw single-pass generation scores 0.20. Hero imagery, content sections, and visual theme are all distant from source. This is the floor.

---

### 2. `context-enrichment` — 1775076531508

Added enriched context to the generation prompt: full-page screenshots, extracted DOM info (headings, images, fonts), computed styles, and inline SVGs passed to the model.

Main: **0.35** · Cost: $0.053 · Duration: ~45s · Iterations: 0

Conclusion: Richer context at generation time meaningfully improves the first-pass score (+75% over baseline). The model produces better structural coverage when it can see the full source page. No fix loop yet.

---

### 3. `context-enrichment-2` — 1775076914370

Repeated context-enrichment run to check variance. Responsive prompt refinements (explicit 375px–2560px breakpoint language, Tailwind `xl:`/`2xl:` guidance).

Main: **0.20** · Cost: $0.052 · Duration: ~57s · Iterations: 0

Conclusion: Noisy. The generation model (Haiku) is stochastic enough that the VLM score varies significantly run-to-run on the same prompt. Enrichment alone is not sufficient — a correction loop is needed to stabilise quality.

---

### 4. `fidelity-loop-full` — 1775079476092

First full iterative fidelity loop. VLM scores the first-fold screenshot each iteration; `captionDiscrepancies` produces a structured list; Sonnet rewrites the HTML. Full-page screenshots (capped at 7800px) added to context. Wide-viewport (1920px) screenshots added for discrepancy captioning.

Iterations: 0.62 → 0.72 → 0.72 (converged, 0 discrepancies)
Main: **0.72** · Cost: $0.526 · Duration: ~5.5m · Baseline: 0.20

Conclusion: The loop is effective. Three iterations bring VLM from 0.62 to 0.72 before convergence. Hero and header are now matching; remaining issues are layout details (widget position, payment method row truncation, gradient precision). This is the high-water mark for the fold-only VLM loop. The DOM diff shows 74 missing headings — the loop is not addressing below-fold content at all.

---

### 5. `fidelity-loop-full-2` — 1775079848362

Extended to 4 iterations max, same VLM loop. Checked whether more iterations yield further improvement.

Iterations: 0.68 → 0.75 → 0.72 → 0.75
Main: **0.72** · Cost: $0.719 · Duration: ~8.5m · Baseline: 0.20

Conclusion: Score oscillates between 0.72–0.75 after iteration 2. The loop has hit a ceiling dictated by the VLM's measurement scope (first fold only). Additional visual fix passes do not add new content sections; they shuffle pixel-level details without converging. The below-fold problem is confirmed as structurally unaddressed.

---

### 6. `fidelity-loop-with-baseline` — 1775080931988

Added `--baseline` flag for side-by-side comparison reports. Same loop configuration.

Iterations: 0.68 → 0.72 (converged)
Main: **0.72** · Cost: $0.576 · Duration: ~5.8m · Baseline: **0.20**

Conclusion: Confirmed +260% VLM improvement over baseline (0.20 → 0.72) with the loop. Cost ratio is ~11× baseline. The side-by-side comparison infrastructure is working correctly.

---

### 7. `fidelity-loop-extended` — 1775083220572

Investigated whether the convergence stall at 0.72 is caused by the VLM scoring scope. Ran with reduced iteration budget.

Iterations: 0.62 → 0.62 (0 discrepancies — immediate convergence)
Main: **0.62** · Cost: $0.430 · Duration: ~4.5m · Baseline: **0.15**

Conclusion: The VLM fold-scoring loop sometimes terminates early (iter 2 produces 0 discrepancies despite score plateau at 0.62). The signal is unreliable as a sole stopping criterion — the loop can declare victory while large portions of the page are missing.

---

### 8. `stripe-en-ca-payments-reference` (DOM-based tiered loop) — 1775088646755

Major architectural change: replaced the VLM-only loop with a tiered DOM-level dispatch.

**Architecture:**
- Every iteration runs `computeDomDiff` first (no VLM cost) to classify the current level: `structure` (heading retention < 0.8) → `content` (text coverage < 0.7) → `visual`
- Structure level: model appends up to 15 missing headings/sections per iteration (batched to stay within token limits)
- Content level: model fills copy and images into the existing skeleton
- Visual level: existing fold-VLM + `captionDiscrepancies` flow
- Composite score = `0.7 × VLM + 0.3 × DOM` at visual level; pure DOM score otherwise

**Results:**

Iterations (all `structure` level): DOM 0.073 → 0.209 → 0.409 → 0.565
Final VLM (fold): **0.620** · Final DOM: **0.789** · Cost: $3.165 · Duration: 36m 5s · Baseline VLM: 0.250 · Baseline DOM: 0.071

| Metric | Experimental | Baseline | Δ |
|---|---|---|---|
| VLM score | 0.620 | 0.250 | +148% |
| DOM score | 0.789 | 0.071 | +1011% |
| Text coverage | 87.2% | 9.0% | +869% |
| Missing headings | 23 | 74 | −69% |

**Observations:**
The DOM-tiered loop dramatically improves whole-page completeness. The generated page is visually correct for the majority of the SPA and only begins to diverge near the end. However, all 4 iterations were consumed by the `structure` level because 74 headings ÷ 15 per batch requires ≥5 iterations to exhaust the list. The loop never reached `content` or `visual` levels in this run.

The cost ($3.16) is driven by the fix-pass model (Sonnet) rewriting the full HTML document — which grows to ~200KB by iteration 4 — to insert each new batch of sections. This is the dominant inefficiency.

---

### 9. `fl-budget-patch` / `quality-mode` (fragment structure pass) — 1775093833723, 1775094880065, 1775095xxx

Attempted to address Issue 2 (cost of full-document rewrite) by switching the structure pass to a fragment-only output: model emits only new `<section>` blocks which are injected before `</body>`. Also introduced per-level iteration caps (Issue 1) and the `--quality` flag with auto-computed iteration budget based on source heading count.

Main: **worse than run 8** · Baseline: 0.20

**Observations:**
Fragment injection significantly degrades fidelity compared to the full-rewrite pass in run 8. Three root causes are apparent. First, sections are always appended at the bottom of `<body>` regardless of where they belong in page flow — Stripe's page has interleaved sections (nav subsections, in-page component variants) that must appear between existing elements, not after the footer. Second, the model only sees the first 8KB of the document as style context, which is insufficient once the document grows through multiple injection passes — by pass 4 the style reference misses all established patterns. Third, each pass is blind to what prior passes already injected, making deduplication and ordering impossible.

The per-level iteration budget and `--quality` mode are working correctly as infrastructure — the computed budgets are right and the level-forcing logic behaves as expected. These carry forward unchanged.

Conclusion: Fragment injection is not viable for the structure pass. Full-document rewrite is the correct approach. The cost problem must be solved differently (e.g. targeted edit instructions with structured output, or a smaller model for structure passes).

---

## Known Issues & Next Steps

**Issue 1: Structure level exhausts the full iteration budget.** ✓ Resolved via per-level caps and `--quality` auto-budget. The `computeIterBudget` function sizes structure passes as `ceil(sourceHeadings × 0.8 / batch)`, ensuring the structure level completes before content and visual passes run. Needs re-validation with full-pass architecture.

**Issue 2: Structure fix pass rewrites the entire HTML document.**
Fragment injection (run 9) was attempted as the fix and caused significant quality regression. The correct approach is full-document rewrite retained, with cost reduction explored via a smaller model for structure passes or structured-edit output (model emits targeted insertion instructions rather than full HTML). Open.

**Issue 3: Below-fold content score plateau in the old VLM loop.** ✓ Resolved by the DOM-tiered dispatch introduced in run 8. Run 9 regressed due to the fragment approach, not the tier architecture.

**Issue 4: `summary.json` / `run.json` serialisation corruption.**
Previously hypothesised to be caused by raw heading strings in the logged iteration record. More likely the actual cause is thumbnail base64 image data being embedded directly in `summary.json` — observed in recent runs where the file is abnormally large. The `missingHeadings` array was already excluded from `iterRecord`; the thumbnail fields in `BaselineComparison` are the probable culprit. Fix: strip thumbnail base64 from `summary.json` (keep in `run.json` only; or write thumbnails to separate files). Open.

**Planned next iteration:**
- Revert structure pass to full-document rewrite (restore run 8 approach)
- Re-run with `--quality balanced` to validate iteration budget against full-pass architecture
- Fix `summary.json` thumbnail serialisation (strip `mainThumbnail` / `baselineThumbnail` base64 from summary)
