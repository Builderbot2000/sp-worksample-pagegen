# Page Generation Architecture

## Overview

A parallel section generation pipeline that reconstructs a source webpage as a
self-contained HTML document. The core insight driving the design is that
single-pass generation exhibits output attention decay — early sections are
reproduced faithfully while fidelity degrades progressively further into the
document. Parallel section agents solve this by ensuring every section is
generated at output position zero.

---

## Stage 0 — Pre-Processing (once per source URL)

**Inputs:** source URL

**Steps:**

1. Fetch raw HTML, all assets (images, SVGs), and computed styles from the
   source page via headless browser
2. Render page headlessly and locate viewport-sized bounding boxes across the
   full page height
   - Filter out fixed/sticky elements (nav, floating UI)
   - Recursively descend into candidates exceeding ~150% viewport height to
     find sub-sections
3. Map each bounding box to its closest DOM node via `getBoundingClientRect()`
   — walk up the tree to the highest ancestor that does not span multiple
   sections. This is the section root node.
4. Assign a stable slug to each section root based on visual role and ordering
   (e.g. `hero`, `logo-grid`, `feature-row-1`, `cta-band`, `footer`)
5. Capture screenshots:
   - One screenshot per section at bounding box offset
   - Two screenshots for sections exceeding ~150% viewport height (top and midpoint)
6. Carve skeleton screenshot: replace each section root's visual region with a
   neutral colored placeholder overlay labeled with its slug. Global elements
   (nav, background treatments, footer) remain intact. This screenshot is
   human-reviewable as a validation checkpoint before generation runs.
7. Carve skeleton HTML: replace inner content of each section root in the
   source HTML with an empty labeled placeholder. Global elements and document
   structure are preserved verbatim.

**Outputs:**
- Section slug list with ordering and bounding box metadata
- Per-section screenshots
- Carved skeleton screenshot
- Carved skeleton HTML
- Assets and computed styles

---

## Stage 1 — Skeleton Agent (Sonnet)

**Purpose:** Produce a valid generated HTML document shell with all global
elements and empty labeled section shells. Establishes the design system that
all section agents inherit.

**Input:**
- Carved skeleton screenshot (shows global elements with labeled placeholders)
- Carved skeleton HTML (source structure with section interiors removed)
- Computed styles (CSS custom properties, font stack, spacing scale)
- Section slug list with ordering

**Output:** Complete HTML document containing:
- `<head>` with font imports, Tailwind config, CSS custom properties
- Global layout wrappers
- Nav and footer reproduced faithfully
- Any fixed/sticky or floating UI elements
- Empty `<section>` shells with slug labels at correct positions — no interior
  content

**Constraints:**
- Must not generate any section interior content
- Section label format must be machine-parseable and verbatim from slug list
- Reviewable human checkpoint before Stage 2 runs

---

## Stage 2 — Section Agents (Sonnet, parallel)

**Purpose:** Generate faithful interior content for each section independently.
Each agent starts at output position zero, eliminating attention decay.

**Per-agent input:**
- Skeleton CSS variables and component patterns (content-stripped to a few KB —
  design system only, no section content)
- Section screenshot(s) for this slug
- Relevant assets for this section
- Source HTML for this section only (carved section root inner content)
- Section slug, position index, and neighbor slugs for context

**Per-agent output:** Self-contained HTML fragment for the section interior —
schema-enforced:
- No `<style>` tags
- No document-level wrapper elements
- No Tailwind config or font declarations
- Pure interior content ready for insertion

All section agents run in parallel. Wall-clock time is `max(agent_duration)`.

---

## Stage 3 — Programmatic Assembly

**Purpose:** Insert section fragments into skeleton at matching slug labels.
No model involvement.

**Steps:**
1. Parse skeleton HTML
2. For each slug label in document order, replace placeholder with
   corresponding section fragment
3. Unmatched source slugs → flagged as missing sections for review
4. Output assembled rough HTML

This step is deterministic and eliminates an entire class of model-induced
errors from the assembly process.

---

## Stage 4 — Reconciliation Agent (Haiku)

**Purpose:** Fix layout seam problems introduced by independently generated
sections meeting at boundaries. Scoped narrowly to layout only.

**Input:**
- Assembled HTML — section boundary regions only (interior content stripped
  before passing to agent)
- Source screenshots for boundary regions

**Output:** Structured targeted diff operations via enforced tool schema:

```
update_spacing(slug, property, value)   — padding, margin, gap
update_layout(slug, property, value)    — grid columns, flex direction, alignment  
insert_class(slug, selector, class)     — add missing layout class
```

**Prohibited by schema:** `replace_content`, `update_color`, `delete`

Diffs are applied programmatically to assembled HTML.

**Post-check:** Programmatic child node count diff before and after to catch
accidental content drops.

---

## Output

Final reconciled HTML — single self-contained file with Tailwind, all assets
inlined or referenced, faithful to source layout and design system.

---

## Key Design Decisions

| Decision | Rationale |
|---|---|
| Parallel section agents | Eliminates output attention decay — every section generates at position zero |
| Programmatic skeleton carving | Removes synthesis burden from skeleton agent; makes section boundaries deterministic |
| Carved skeleton screenshot | Human-reviewable checkpoint; skeleton agent sees exactly what to reproduce |
| Schema-enforced reconciliation diffs | Structurally prevents scope creep — model cannot delete content or change colors |
| Haiku for reconciliation | Narrow mechanical task; small focused tool calls are within Haiku's reliable range |
| Sonnet for skeleton and sections | Perceptual + code generation task; vision quality and frontend fidelity are Sonnet strengths |
