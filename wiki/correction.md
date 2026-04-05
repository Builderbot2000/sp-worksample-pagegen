# Stage 2.5 — Correction Loop

Source: [`src/pipeline/correction-loop.ts`](../src/pipeline/correction-loop.ts)

Active when `--correction` is passed. Re-generates sections that scored below the fidelity threshold, up to `maxCorrectionIter` times.

---

## Constants

| Constant | Value | Meaning |
|---|---|---|
| `CORRECTION_THRESHOLD` | `0.70` | Sections below this VLM score are flagged for re-generation |
| `PLATEAU_DELTA` | `0.01` | If aggregate score improves by less than this, the loop stops early |

---

## Per-iteration flow

1. **Screenshot** all sections of the current assembled HTML via `screenshotSectionsBySlug`. Sections that render to less than 4px or less than 25% of their source `heightPx` are skipped — they are treated as collapsed shells and excluded from scoring.

2. **Filter active sections** — sections already in `settledSlugs` are excluded from VLM scoring and re-generation. Screenshots are still taken for the HTML report.

3. **Score active sections** via `computeSectionDiscrepancies`. Source and generated screenshots are chunked into batches of 8 (`VLM_BATCH_SIZE`) and all batches are sent to `MODELS.vlmScorer` in parallel. Each section gets a `score` (0–1), a `verdict` (`close` / `partial` / `distant`), and up to three issue strings.

4. **Settle** — any active section that scored at or above `CORRECTION_THRESHOLD` is added to `settledSlugs`. It will not be scored or re-generated in subsequent iterations.

5. **Flag** — sections below `CORRECTION_THRESHOLD` form the `toFix` list.

6. **Re-generate** all flagged sections in parallel via `generateSection`, passing the issue list as `corrections` and the current fragment as `currentHtml`. The correction model is `MODELS.sectionCorrection`.

7. **Reassemble** the skeleton with the updated `fragmentMap` and write it to disk.

8. **Plateau check** — if `aggregateScore - prevScore < PLATEAU_DELTA` the loop stops early. When plateau detection fires, the file on disk retains the previous iteration's output (the regressed version is not written).

---

## `settledSlugs`

A `Set<string>` that grows across iterations. Once a section scores ≥ 0.70 it is permanently removed from the active set. Both the VLM scorer and the correction agents skip settled sections, focusing cost on sections that are still improving.

---

## Per-iteration outputs

Each iteration writes to `corrections/iter-N/`:

- `generated-<slug>.png` — screenshot of the generated section at this iteration
- `iter-N-report.html` — HTML report card per section with score badge, severity, issue list, and side-by-side source/generated screenshots

Source screenshots are written once to `sections/source-<slug>.png` by the main agent before the loop starts.

---

## Return value

```ts
interface CorrectionLoopResult {
  fragmentMap: Map<string, string>;   // updated fragments after all iterations
  scorerTokensIn: number;
  scorerTokensOut: number;
  sectionTokensIn: number;
  sectionTokensOut: number;
  iterationRecords: IterationRecord[];
}
```

`iterationRecords` feeds the iteration table in the HTML report.

---

## Interaction with quality budget

`budget.maxCorrectionIter` caps the total number of loop iterations. Quality mode values:

| Mode | `maxCorrectionIter` |
|---|---|
| `draft` | 0 (no loop) |
| `standard` | 2 |
| `quality` | 3 |

See [`src/config.ts`](/config).
