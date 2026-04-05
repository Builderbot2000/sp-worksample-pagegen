# Stage 2 — Parallel Section Generation

Source: [`src/pipeline/section-agent.ts`](../src/pipeline/section-agent.ts) · Prompt: [`src/prompts/section.ts`](../src/prompts/section.ts)

All sections are generated simultaneously. Each call runs independently with no shared mutable state, making full `Promise.all` parallelism safe.

---

## `generateSection`

```ts
generateSection(
  section: { slug; description; role; order; heightPx },
  _neighborSlugs: { prev?; next? },
  screenshots: Buffer[],
  computedStyles,
  fontFamilies,
  imageUrls,
  _url,
  cssVars?,        // :root CSS custom properties from skeleton
  shellContext?,   // { self, prev?, next? } — opening shell tags + neighbour fragments
  corrections?,    // string[] — issue list from a correction iteration
  currentScreenshot?,
  currentHtml?,    // current fragment for surgical correction
  model?,          // overrides MODELS.sectionInitial when supplied
): Promise<{ slug; fragment; tokensIn; tokensOut }>
```

Returns the filled HTML fragment for the section's interior — no `<html>`, `<head>`, `<body>`, `<style>`, or `<script>` wrappers.

---

## Inputs to the model

Each section agent receives, in a single user message:

- The section's own screenshot(s) resized to 1024px JPEG via `resizeForVlm` (sections taller than 1,350px get two screenshots)
- The section's `slug`, `role`, `order`, `description`, and source `heightPx`
- The `:root` CSS custom properties extracted from the skeleton
- Computed styles, font families, and image URL list
- A `shell_context` block: the section's own opening shell tag, plus assembled neighbour HTML above and below via `assembleNeighbour`
- If called as a correction pass: the `corrections` issue list and the `currentHtml` fragment to modify surgically

---

## The reference screenshot is ground truth

The model is explicitly told that the screenshot is the absolute reference. It may override any background colour, padding, or spacing the skeleton placed on the shell element. If the skeleton produced an incorrect shell style, the section agent corrects it on its outermost interior wrapper `<div>`. The only hard structural constraints are: no document wrappers, no `<style>` or `<script>` tags, no Tailwind config blocks, no font import statements.

---

## Tool call

The model is forced to call `save_section` exactly once:

```ts
{ slug: string; content: string }
```

`max_iterations: 2` is set on the runner — if Zod validation rejects the first call, the model receives the error and can retry once.

---

## Neighbour context

`assembleNeighbour(shellTag, fragment)` wraps a neighbouring section's live fragment inside its shell opening tag. This gives each section agent real rendered HTML for the sections immediately above and below — not the empty shell placeholders from the skeleton — so it can match spacing, visual rhythm, and colour continuity accurately.

Shell tags come from `extractShellTag(skeletonHtml, slug)`.

---

## Token budget

Section agents use a fixed `SECTION_MAX_TOKENS = 8,000`. This is intentionally small: section agents produce fragments, not full documents.

---

## Correction pass reuse

`generateSection` is called a second time (and up to `maxCorrectionIter` times) by the correction loop with `corrections` and `currentHtml` populated. The prompt instructs the model to modify the current fragment surgically — preserving parts that already match — rather than rewriting from scratch. The correction model is `MODELS.sectionCorrection` (default `claude-haiku-4-5`).
