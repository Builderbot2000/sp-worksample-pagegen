# Experimental Methodology

## Overview

This project improves a page generation pipeline through a tight hypothesis-driven loop. Each cycle targets a single suspected improvement to fidelity, cost, or speed — implements it, measures it against the prior state, and either discards it or commits it and records the finding.

## The Loop

A hypothesis is formed about a specific weakness in the pipeline. It is implemented on the experimental path, leaving the baseline code untouched. The CLI is then run with `--baseline` so both paths execute against the same source URL in the same session, producing a `run.json` and `report.html` with a direct delta across fidelity score, cost, and duration. If the experimental path shows clear improvement, the change is committed to git and a new entry is added to `RESEARCH.md` capturing the hypothesis, what was changed, and the measured effect. If there is no improvement, the change is discarded and a new hypothesis is formed.

## What Counts as an Improvement

The primary signal is fidelity score — the VLM-assigned closeness verdict and 0–1 score from the final iteration. Secondary signals are cost (estimated USD from token counts) and duration (wall-clock milliseconds). A change that raises fidelity while holding cost roughly flat is a clear win. A change that raises fidelity at meaningfully higher cost is a trade-off that needs justification. A change that moves cost or duration without moving fidelity is complexity without benefit and is discarded.

## Research Log

Confirmed findings live in `RESEARCH.md`, one entry per committed hypothesis. That file is the authoritative record of what has actually been shown to work.
