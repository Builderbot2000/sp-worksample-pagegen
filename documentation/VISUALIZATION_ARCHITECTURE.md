# Visualization Architecture

The pipeline visualizer produces a single self-contained `visualizer.html` per run that replays the full generation pipeline event-by-event. It is written alongside `report.html` on every `npm run generate` and every `npm run report` invocation.

---

## Source Files

All source lives under `src/observability/visualizer/` and is compiled by `scripts/report.ts` into the final HTML string.

| File | Role |
|---|---|
| `index.ts` | Entry point. Reads `run.json` + `run.ndjson`, assembles all parts into the HTML document and writes it. |
| `html-shell.ts` | Returns the static HTML skeleton: header bar, pill nav, carousel track (slides 0–4), and playback bar. |
| `styles.ts` | Returns a single CSS string embedded in a `<style>` tag. |
| `client-state.ts` | Returns an IIFE-style JS string containing helpers, `deriveState`, `phaseToSlide`, and all one-time slide-init code. |
| `client-renderers.ts` | Returns the JS string containing per-slide renderers, carousel logic, the playback engine, and all GSAP animation functions. |

The five JS/CSS strings are concatenated into a single inline `<script>` and `<style>` block — no external assets except the GSAP CDN.

---

## Runtime Data

Two global constants are serialized into the HTML at build time.

**`RUN_META`** — static metadata about the run:
```
{ runId, name, url, startedAt, completedAt, estimatedCostUsd,
  screenshotPaths: { source, sections:{slug→path}, fidelityMain },
  hasFidelity: bool, hasCorrection: bool }
```

**`EVENTS`** — the full `run.ndjson` event stream as a JSON array. Each entry is `{ phase, ts, data }`. The visualizer replays EVENTS sequentially; `EVENTS[stepIdx]` is the "current" event.

**`SKELETON_HTML`** — the first 30 000 characters of the generated skeleton file, serialized as JSON for display in the Skeleton slide code panel.

Screenshot paths in `screenshotPaths` are relative to the run directory. The HTML file must be opened from that directory for images to load correctly.

---

## State Derivation

`deriveState(upTo)` replays `EVENTS[0..upTo]` and returns a snapshot:

```
{
  runStart, preprocess, skeleton,
  sections:    { [slug]: { status, role, order, score, verdict, genPath, fixing, durationMs } },
  sectionOrder: string[],           // slugs in first-seen order
  corrections: [{
    iter, status, activeSlugs,
    scores:     { [slug]: { score, verdict, issues, genPath, srcPath } },
    sectionFix: { [slug]: 'fixing'|'fixed' },
    aggregateScore, sectionsToFix
  }],
  assemble, fidelity, baseline, runComplete
}
```

This function is called on every `renderStep` call, so state is always fully derived from the event prefix — there is no incremental mutation of a shared state object.

---

## Slide Structure

Slide count is injected at build time as `SLIDE_COUNT`. The last slide (`SLIDE_COUNT - 1`) is the End slide, which is only appended when `hasFidelity` is true.

| Index | ID | Label | Content |
|---|---|---|---|
| 0 | `#slide-0` | Start | Source screenshot pan + run info card (URL, config chips, HTML snippet) |
| 1 | `#slide-1` | Preprocess | Full-page source image with color-coded bounding boxes + section cards aligned to bbox midpoints |
| 2 | `#slide-2` | Skeleton | Skeleton screenshot pan + skeleton HTML code panel |
| 3 | `#slide-3` | Sections & Assembly | Two-column table (Reference \| Generation) with one row per section |
| 4* | `#slide-4` | End | Side-by-side source/generated screenshots + fidelity score, bar, stat tiles |

\* Only present when `hasFidelity` is true.

### Phase → Slide Mapping

`phaseToSlide(phase)` drives automatic slide selection during playthrough:

```
run:start                               → 0
preprocess:start / preprocess:complete  → 1
skeleton:start / skeleton:complete      → 2
section:start / section:complete        → 3
correction-iter:start / complete        → 3
section-score / section-correction:*   → 3
assemble:start / assemble:complete      → 3
baseline:start / baseline:complete      → 3
fidelity:start / fidelity:complete      → SLIDE_COUNT-1  (if hasFidelity)
run:complete                            → SLIDE_COUNT-1  (if hasFidelity, else 3)
```

---

## Carousel & Navigation

**`jumpToSlide(idx)`** — called by `renderStep` on every event. Transitions the CSS `transform: translateX` on `#track` to bring the target slide into view (0.45 s, `power2.inOut`). On slide change it resets `scrollTop` to 0 and fires the slide's entry animation. Slides 0, 3, and the End slide have dedicated entry animations; all others get a generic stagger pop-in from `.card`/`.track-row` children.

**`manualGoToSlide(slideIdx)`** — fired by pill-nav buttons. Stops playback, finds the last event whose phase maps to `slideIdx`, resets any slide-specific state (bbox visibility for slide 1, gen-cell state for slide 3), then calls `renderStep` on that event index.

**`_newSlideEntryDelay`** — a float (seconds) set by `jumpToSlide` indicating how long the entry animation takes. `renderSlide1` uses it to delay stagger of new section pairs on slide 1. Reset to 0 after consumption.

---

## Playback Engine

```
stepIdx   — current event index
playing   — bool, auto-advance active
loop      — bool, return to start after last event
dwellMs   — ms to wait between events (default 1000; 0.5×/1×/2×/4× speed buttons)
timerId   — setTimeout handle for next step
animateUntil — epoch ms; playback waits until Date.now() ≥ animateUntil before advancing
manualMode   — bool, toggled by "Manual" button (currently cosmetic)
```

**`setReadyAfter(ms)`** — called by entry animations to hold playback. `animateUntil = max(animateUntil, Date.now() + ms)`.

**`renderStep(idx)`** — the core render function. Sets `stepIdx`, derives state, calls `jumpToSlide`, then calls `renderSlide1`, `renderSlide2`, `renderSlide3`, and `renderSlide5` (if `hasFidelity`).

---

## Slide 0 — Start

**`animateSlide0Entry()`** fires when the carousel transitions to slide 0. It snaps all four content blocks to `opacity:0, y:14`, then staggers them in at 0.6 s intervals: source screenshot → Run Info card → config chips → HTML snippet. Dwell time is content-scaled: URL length + snippet length ÷ 3, clamped to 2.5–10 s.

---

## Slide 1 — Preprocess

All bounding boxes and section cards are created once at init time (invisible) from the `preprocess:complete` event data. `renderSlide1(state)` shows the card + bbox pair for each slug in `state.sectionOrder`. New pairs animate in with `scrollSlide1To(slug)` → bbox drop-down → card fade-in, staggered at 1.2 s intervals. Card vertical positions are aligned to bbox midpoints using absolute positioning relative to the image wrapper height.

On `manualGoToSlide(1)` all cards and bboxes are hidden and the entry delay is reset, so the sequence re-runs.

---

## Slide 2 — Skeleton

`renderSlide2(state)` shows the shimmer placeholder while `skeleton.status === 'active'`, then hides it and loads the pan image when `status === 'complete'`. On image load the HTML code panel slides in from the right (`x: 20 → 0`). The image pan is driven by `startPan(img)`, which GSAP-animates `y` from 0 to `-(naturalHeight − containerHeight)` over 4–12 s scaled to image length.

---

## Slide 3 — Sections & Assembly

This is the most complex slide. It shows a two-column table (Reference | Generation) with one `.sxa-row` per section.

### DOM Structure

```
#slide-3
  .sxa-table
    .sxa-hdr
      .sxa-hdr-col  "Reference"
      .sxa-hdr-col  "Generation"
    #sxa-rows
      .sxa-row#sxar-{slug}          opacity:0 at init
        .sxa-row-ref#ref-card-{slug}
          <img src="{source thumb}" />
          .sec-lbl
        .sxa-row-gen#sxag-{slug}    position:relative
          .sec-shimmer (or <img>)
          .iter-badge               position:absolute top:4px right:4px
          .fc-score-bar
            .fc-score-dot
            .fc-verdict
            .fc-score-val
          .sec-lbl
```

### CSS Classes on Gen Cell

| Class | Effect |
|---|---|
| `.locked` | `border-top: 2px solid var(--fc-border)` — colored accent matching score |
| `.flashing` | `fc-flash` keyframe (opacity 1→0.4→1 over 0.45 s) |
| `.scanning` (on `.sxa-row`) | `sxa-scan` keyframe — `border-color` + outer `box-shadow` blue pulse, 0.65 s |

The `.scanning` animation is on the row (not the cell) to avoid being clipped by the cell's `overflow:hidden`.

### Playthrough Rendering (`renderSlide3`)

During normal event-by-event playback:

- `section:start` → GSAP `fromTo` the row from `opacity:0, y:8` to visible
- All other events → hydration pass: any invisible rows get a stagger reveal, gen cell image/score synced to `state.sections[slug]`
- `section-score` or `section-correction:complete` → update score bar color, score value, verdict, swap image, fire `.flashing`
- `assemble:complete` → stagger-lock all gen cells at 80 ms intervals (skips already-locked cells)

### Pill-Nav Entry (`animateSlide3Entry`)

When arriving via pill nav, `manualGoToSlide(3)` hides all rows, resets all gen cells to shimmer + cleared state, clears `.iter-badge`, and sets `_slide3EntryPending = true`. On the next `renderSlide3` call, the flag is consumed and `animateSlide3Entry(state)` runs.

The entry builds a **trip list**:

```
Trip 0  isInitial=true   slugs = state.sectionOrder (all sections)
Trip 1  isInitial=false  corrIdx=0  slugs = corrections[0].activeSlugs
Trip 2  isInitial=false  corrIdx=1  slugs = corrections[1].activeSlugs
...
```

Each trip fires per-row at `trip.startT + i × stagger`:

| Trip | Stagger | Content |
|---|---|---|
| Initial | 400 ms/row | Fade row in (`opacity:0→1, y:6→0`). Hydrate gen cell from `corrections[0].scores[slug]` (iter 1 = initial gen quality). No badge. |
| Correction N | 250 ms/row | Scan border only (row already visible). Fade-replace gen thumbnail with `corrections[N].scores[slug].genPath`. Update score bar. Flash. Show "Iter N" badge. |

Gap between trips: 1000 ms. Each step pre-scrolls the slide to center the target row 220 ms before the animation fires (`scrollSlide3To`).

`initScores = corrections[0].scores` provides the initial generation quality snapshot shown on the first trip — iteration 1 scores represent the state of the page immediately after generation, before any correction has been applied.

---

## Slide 4 — End (Fidelity)

Only rendered when `hasFidelity` is true. `renderSlide5(state)` populates the score, verdict, bar color, stat tiles, and both screenshot images (source and fidelity main screenshot) idempotently.

**`animateSlide4Entry()`** fires on pill-nav entry to slide 4. It snaps all elements to `opacity:0, y:12` then staggers in: left image (0.45 s delay) → right image (+0.2 s) → score row + bar + stats (+0.4 s). Uses stable ID selectors: `#fi-score-row`, `#slide-4 .bar-track`, `#fi-stats`.

---

## Key IDs Reference

| ID | Slide | Purpose |
|---|---|---|
| `#track` | — | Carousel `translateX` target |
| `#s0-pan-wrap` | 0 | Source image pan container |
| `#pp-img-wrap` | 1 | Full-page source image; `paddingBottom` set from aspect ratio |
| `#pp-bboxes` | 1 | Bbox overlay container |
| `#sec-list` | 1 | Section card container; `height` = `pp-img-wrap` height |
| `#skel-pan-wrap` | 2 | Skeleton image pan container |
| `#skel-html-card` | 2 | Skeleton HTML code panel |
| `#sxa-rows` | 3 | Section row container |
| `sxar-{slug}` | 3 | `.sxa-row` for a section |
| `sxag-{slug}` | 3 | Gen cell for a section |
| `ref-card-{slug}` | 3 | Ref cell for a section |
| `#fi-score-row` | 4 | Score + verdict row (ID used by `animateSlide4Entry`) |
| `#fi-stats` | 4 | Token/duration stat tiles |

---

## Portability Conventions

- End slide is always `SLIDE_COUNT - 1`, not a hardcoded index
- `jumpToSlide` guards End slide entry as `RUN_META.hasFidelity && idx === SLIDE_COUNT - 1`
- `animateSlide4Entry` uses `getElementById('fi-score-row')` and `querySelector('#slide-4 .bar-track')` — no positional DOM traversal
- Screenshot paths come from `RUN_META.screenshotPaths`; all paths are relative to the run directory
- `SLIDE_COUNT` is injected by `buildStateLogic(slideCount)` from the TypeScript build step
