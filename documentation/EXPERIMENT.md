# Experimental Methodology

## Overview

This project improves a page generation pipeline through a tight hypothesis-driven loop. Each cycle targets a single suspected improvement to fidelity, cost, or speed — implements it, measures it against the prior state, and either discards it or commits it and records the finding.

## The Loop

1. Form a hypothesis about a specific weakness in the pipeline.
2. Implement it on the experimental path, leaving the baseline code untouched.
3. Run the CLI with `--baseline` so both paths execute against the same source URL in the same session.
4. Review the `run.json` and `report.html` for a direct delta across fidelity score, cost, and duration.
5. If the experimental path shows clear improvement, run a duplicate test to check if the improvement is consistent or accidental
7. If there is consistent improvement, commit the change to git and add an entry to `RESEARCH.md` capturing the hypothesis, what was changed, and the measured effect.
8. If there is no improvement, discard the change and return to step 1.

## What Counts as an Improvement

The primary signal is fidelity score — the VLM-assigned closeness verdict and 0–1 score from the final iteration. Secondary signals are cost (estimated USD from token counts) and duration (wall-clock milliseconds). A change that raises fidelity while holding cost roughly flat is a clear win. A change that raises fidelity at meaningfully higher cost is a trade-off that needs justification. A change that moves cost or duration without moving fidelity is complexity without benefit and is discarded.

## Outputs

Experimental run output directories are numbered sequentially so they sort in order and each experiment can be compared directly against the prior stable iteration without needing to parse timestamps.

## Research Log

Confirmed findings live in `RESEARCH.md`, one entry per committed hypothesis. That file is the authoritative record of what has actually been shown to work.
