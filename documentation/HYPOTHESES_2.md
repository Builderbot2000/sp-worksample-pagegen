# Project Plan 2: Fidelity Optimization — Theoretical Approaches

## Context

The current implementation (`src/`) covers context enrichment, iterative pixel-diff scoring, vision-based captioning, a fix loop, and a full observability stack. This document maps the remaining theoretical ceiling for fidelity improvement, grouped by where loss occurs in the pipeline.

---

## 1. The Prompt Representation Problem

Even with screenshots and computed styles, Claude reconstructs a 2D visual from a lossy description. Two directions push this further:

- **Region-level prompting**: Decompose the page into segments and generate each independently with its own cropped screenshot as reference. The model attends more precisely when the visual target is tight and local rather than a full-page thumbnail.
- **Chain-of-thought layout reasoning**: Ask Claude to first describe the layout structure it observes in the screenshot — grid columns, alignment, spacing relationships — before generating any HTML. This forces explicit spatial reasoning rather than pattern-matching to a generic template.

---

## 2. The Single-Model Generation Bottleneck

One model handling layout, copy, styling, and image placement simultaneously will always make trade-offs. Specialization helps:

- **Decomposed generation**: Separate model passes per concern. A layout pass produces semantic structure and grid. A styling pass fills in Tailwind classes given computed styles. A copy pass populates text content. Each pass has a narrow, well-defined target.
- **Critic-generator separation**: A dedicated model instance acts only as critic — it never generates HTML, only evaluates output against the source screenshot and produces the discrepancy list. The generator never self-evaluates, avoiding the sycophancy problem where a model tends to approve its own output.

---

## 3. The Pixel Diff as the Only Feedback Signal

Pixelmatch identifies *where* things differ but not *why* or *how to fix them*. Richer signals:

- **Structural diff**: Compare DOM trees between source and output — tag names, nesting depth, element count per segment. Structural mismatches explain pixel divergence that styling fixes alone cannot resolve.
- **Text diff**: Extract all visible text from both pages and diff explicitly. Copy errors are invisible to pixelmatch if the surrounding layout is otherwise similar.
- **Color palette diff**: Extract dominant colors per segment from both screenshots and compare palettes. Flags theme drift without requiring pixel-perfect layout match.
- **Perceptual hashing (SSIM)**: Structural similarity scoring is more tolerant of minor rendering differences (antialiasing, subpixel rendering) while still catching meaningful layout divergence, making it a more stable signal than raw pixel diff.

---

## 4. The One-Shot Fix Problem

The current loop passes the full discrepancy list and asks Claude to fix everything in a single pass. Some fixes interact — changing the hero layout can break the CTA below it. Two approaches:

- **Topological fix ordering**: Fix segments strictly top-to-bottom. Screenshot and re-score after each individual segment fix before proceeding to the next. Slower but prevents fix interactions from regressing previously correct segments.
- **Diff-guided surgical edits**: Rather than passing the full HTML per fix, extract only the relevant DOM subtree for the failing segment, fix it in isolation, and splice it back in. Smaller context window, more focused model attention, less risk of collateral changes.

---

## 5. The Static Snapshot Problem

The pipeline captures a moment in time on a live page. Some fidelity loss originates from the capture itself:

- **Interaction state capture**: Some content is only visible after scroll, hover, or interaction — sticky nav states, lazy-loaded images, animated sections. Puppeteer can trigger these explicitly before screenshotting to ensure the reference is complete.
- **Responsive breakpoint sampling**: Generate and score at multiple viewports (375px mobile, 768px tablet, 1440px desktop). A page scoring well at 1440px may be structurally broken at 375px.

---

## 6. The Tailwind Constraint

Tailwind arbitrary syntax gets far but has structural limits — some layouts are fundamentally hard to express without custom CSS. Allowing a `<style>` block with injected computed styles as a fallback, rather than forcing everything through Tailwind utilities, removes a constraint that actively hurts fidelity on complex layouts.

---

## 7. Asset Fidelity

Images are the single hardest element to reproduce correctly. Beyond absolute URL resolution:

- **Background image detection**: CSS `background-image` values are not in `<img>` tags and are easily missed by HTML extraction. Explicitly pulling and injecting these covers a common and high-visibility fidelity gap.
- **SVG inlining**: Icons and logos served as SVGs can be inlined directly rather than linked, eliminating a whole class of broken asset references in the generated output.

---

## Priority Assessment

The highest theoretical ceiling comes from combining three areas:

1. **Region-level prompting** — narrows model attention to match the segment-level diff loop already in place
2. **Critic-generator separation** — removes self-evaluation bias from the fix loop
3. **Multi-signal feedback** — structural + text + color + pixel signals give the critic and fix prompt far more actionable information than pixel diff alone

The iterative loop architecture is correct. These improvements enrich what flows in and out of each step rather than restructuring the loop itself.
