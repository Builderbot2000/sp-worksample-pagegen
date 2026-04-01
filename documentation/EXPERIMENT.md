# Iterative Improvement Methodology

## Overview

Each candidate integration described in the project plans represents a discrete hypothesis about where fidelity, cost, or speed is being lost in the current pipeline. The strategy for evaluating them is to implement one integration at a time and measure its effect against the existing baseline using the metrics the observability layer already captures. Because every run produces a structured `run.json` and a `report.html` with side-by-side comparison data, the experimental setup is already in place — improvement work becomes a cycle of implementing a change, running with `--baseline`, and reading the delta.

---

## The Measurement Contract

The observability layer captures three primary outcome metrics per run: the final fidelity score (the `overallScore` of the last `IterationRecord`, a 0–1 value derived from pixelmatch across all segments), the estimated cost in USD derived from token counts and model pricing, and the total wall-clock duration in milliseconds. When the `--baseline` flag is passed, the CLI runs both the current implementation and the prior baseline against the same source URL and writes a `BaselineComparison` block into `run.json`. The generated `report.html` surfaces the percentage delta for each of those three metrics with directional color coding — green when the experimental run wins, red when it regresses.

Secondary signals are available within the iteration records themselves. `discrepancyCount` tracks how many structural issues the caption pass identified per iteration, and the shape of the score curve across iterations — how steeply it rises and how many iterations it takes to converge — indicates whether an integration reduces the work the fix loop has to do or simply shifts it around. A change that raises the final score while also flattening the curve means fewer iterations were needed, which compounds into lower cost and faster wall time simultaneously.

---

## The Evaluation Cycle

Before implementing any integration, a reference run is captured against a fixed target URL and stored as the baseline. That baseline represents the current production behavior of the pipeline and serves as the control for all subsequent experiments. Each integration is then implemented in isolation on the experimental path — the baseline code is left untouched — and the CLI is run with `--baseline` so that both paths execute against the same source page in the same session. The resulting `run.json` and `report.html` are the record of that experiment.

The three questions each experiment must answer are whether the final fidelity score improved, whether cost and duration moved in an acceptable direction relative to the score gain, and whether the iteration curve became more efficient. An integration that raises score by a meaningful margin while holding cost roughly flat is a clear win. An integration that raises score but doubles token cost needs to be weighed against whether the score gain justifies the expense at the intended usage scale. An integration that changes cost or duration without moving score is likely introducing complexity without benefit and should be discarded.

The convergence threshold — currently `0.02` by default — acts as a natural sensitivity control during experiments. An integration that makes individual iterations more accurate will tend to cause the loop to converge in fewer steps, which shows up as reduced total token consumption even if per-iteration cost is higher due to richer prompts. This makes score-per-dollar and score-per-second useful derived quantities when comparing experiments where the raw numbers move in opposite directions.

---

## Integration Candidates and Expected Signal

The integrations described in the project plans fall into seven areas, and their expected impact on the measurement contract varies.

Region-level prompting — decomposing the page into segments and passing each segment's cropped screenshot as its own tight reference rather than a full-page thumbnail — is expected to raise the initial generation score and reduce the number of iterations needed to converge. If the hypothesis holds, the score at iteration 1 will be meaningfully higher than the baseline, and the total iteration count will decrease. Cost per run may increase slightly due to more image tokens in the generation prompt, but the reduction in fix iterations should more than offset this.

Critic-generator separation — running a dedicated model instance that only evaluates and never generates — is expected to improve the accuracy and specificity of the discrepancy list passed to the fix prompt. The signal will appear in `discrepancyCount` becoming more precise (fewer false positives that waste fix-loop iterations) and in the score delta per iteration becoming larger on average. This integration does not change the structure of the loop but changes the quality of information flowing through it.

Multi-signal feedback augmentation — adding structural DOM diff, text diff, color palette diff, and SSIM alongside the existing pixelmatch score — is expected to make the caption and fix stages act on a richer description of what is wrong, leading to more targeted fixes and fewer regression interactions between segments. The measurement will focus on whether the score-per-iteration curve steepens and whether the number of segments regressing after a fix pass decreases.

The remaining integrations — topological fix ordering, diff-guided surgical edits, interaction state capture, responsive breakpoint sampling, custom CSS fallback, background image detection, and SVG inlining — each address a narrower loss surface. Their experimental signal will be more URL-specific, and evaluating them will require running across a diverse set of source pages rather than a single reference URL to confirm that improvements generalize rather than overfit to one page's structure.

---

## Ordering and Compounding

The priority order for running experiments follows the theoretical ceiling analysis at the end of the project plans: region-level prompting first, then critic-generator separation, then multi-signal feedback. This order is chosen because each integration builds on the same segment-level abstraction that is already central to the diff loop, meaning they compound rather than conflict. Measuring them in sequence also means each experiment has a well-defined prior to compare against rather than attempting to attribute a combined delta to multiple simultaneous changes.

Once the top-priority integrations have been measured individually, a combined run incorporating all three will establish whether their deltas are additive. If the combined score gain is approximately equal to the sum of individual gains, the pipeline is behaving as expected and the integrations can be shipped together. If the combined delta is smaller than the sum, there is an interaction worth understanding before proceeding to the lower-priority integrations.
