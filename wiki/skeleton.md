# Stage 1 — Skeleton Generation

Source: [`src/pipeline/skeleton-agent.ts`](../src/pipeline/skeleton-agent.ts) · Prompt: [`src/prompts/skeleton.ts`](../src/prompts/skeleton.ts)

Produces the structural HTML shell of the page: all global infrastructure fully rendered, section interiors intentionally left empty.

---

## What it does

`runSkeletonAgent({ url, crawlResult, mainDir })` calls the model configured as `MODELS.skeleton` with the full-page screenshot and page metadata. The model is forced to call a `save_file` tool that writes the skeleton HTML to `main/<name>-skeleton.html`.

Returns `SkeletonResult | null`:

```ts
interface SkeletonResult {
  skeletonHtml: string;
  skeletonBasename: string;  // filename without -skeleton.html suffix
  tokensIn: number;
  tokensOut: number;
}
```

---

## Inputs to the model

The model receives all of the following in a single user message:

- Full-page screenshot resized to 1024px wide JPEG via `resizeForVlm`
- Serialised `VisualArchDoc` (all sections, roles, descriptions) via `formatArchDoc`
- The source HTML (up to 80,000 chars)
- Computed styles for key selectors
- Font families
- Image URLs
- Inline SVGs
- `outerHTML` of fixed/sticky elements
- The ordered slug list (slug + role per section)
- Whether a navbar/header section already exists in the section list

---

## Skeleton contract

The skeleton must contain:

- A complete `<head>` block with charset, viewport, title, and font `<link>` imports
- Tailwind CDN `<script>` tag
- A `tailwind.config` script block with `theme.extend` containing brand colours and font families as CSS custom properties
- A `:root` `<style>` block for values that cannot be expressed as Tailwind config tokens
- All fixed/sticky navigation elements fully rendered using Tailwind utility classes — **unless** a `navbar`/`header` role section is in the section list, in which case a global nav must not be duplicated outside the shells

Each section is represented by an **empty shell element** with exactly two required attributes:

```html
<section data-section-slug="section-3" data-section-order="2">
</section>
```

No content goes inside the shells. This is what makes deterministic assembly possible in Stage 2.

---

## Token budget

`estimateMaxTokens(htmlLength, model)` scales linearly between `16,000` and `64,000` output tokens depending on how close `html.length` is to the `80,000` char cap. This prevents truncating large page outputs while avoiding unnecessary token allocation for small pages. The scaling is defined in `src/observability/metrics.ts`.

---

## Assembly utilities (`src/pipeline/assembly.ts`)

Several functions in `assembly.ts` operate on skeleton HTML and are used by later stages:

**`assembleSkeleton(skeletonHtml, fragments)`** — injects each `{ slug, fragment }` pair into the matching shell using a regex with a `\2` backreference on the tag name. Unmatched slugs are logged as warnings.

**`extractRootCssVars(html)`** — parses the `:root { … }` block from the skeleton's `<style>` tag and returns it as a string for section agents and the correction loop.

**`extractShellTag(skeletonHtml, slug)`** — returns the opening tag of a section shell (e.g. `<section class="bg-[#0a2540] py-24" data-section-slug="hero">`).

**`assembleNeighbour(shellTag, fragment)`** — wraps a fragment in its shell tag to give adjacent section agents real rendered HTML as context.

**`formatArchDoc(archDoc)`** — serialises `VisualArchDoc` into a human-readable text block for model prompts.
