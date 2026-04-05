VISUALIZATION REQUIREMENTS
==========================
What the pipeline visualizer looks like, how it is laid out, and how it
behaves. Written from the perspective of what a viewer sees, not how the code
implements it.


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PERSISTENT CHROME
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

The page is a very dark navy-black (#0d1117). The full viewport is divided into
three horizontal bands stacked top-to-bottom: a header bar, a slide navigation
row, the slide content (which takes all remaining height), and a playback bar
pinned to the bottom. Nothing overflows or scrolls at the page level.

--- Header bar ---

A slim dark bar at the top. Left to right it shows: the run title in bold
white, the source URL in blue, then three small dimmed stat labels — "Sections"
(whose number updates live as events play), "Cost" (fixed dollar amount), and
"Duration" (e.g. "1m 23s"). The final fidelity score sits flush against the
right edge in a larger bold font, colored green, amber, or red to reflect the
score.

Score colors: green for scores above 0.85, amber for 0.60–0.85, red below 0.60.
These same three colors are used everywhere a score or verdict appears.

--- Stage navigation pills ---

A row of small pill-shaped buttons just below the header, one per slide:
"Start", "Preprocess", "Skeleton", "Sections & Assembly", and "End" (End only
appears when a fidelity check was run). The currently visible slide's pill is
highlighted in blue; the others are outlined in dark grey. A "Next ▶" button
sits at the far right of the row.

Clicking any pill jumps directly to that slide, stops auto-play, and re-runs
that slide's full entry animation from scratch. The "Next ▶" button advances
one slide at a time in the same way.

--- Slide content area ---

Slides are arranged side-by-side off-screen; only one is visible at a time.
When a slide change happens (either from a pipeline event or a pill click), the
visible area slides horizontally to the new slide in ~0.45s. On arrival the
slide's scroll position is reset to the top and its entry animation fires.

Slides 1 (Preprocess) and 2 (Skeleton) use a simple generic entry: all cards
fade in and rise from slightly below (about 14px), staggered by 0.07s each,
starting just after the slide-in finishes. Slides 0, 3, and 4 each have a
bespoke entry sequence described in their sections below.

As pipeline events arrive during auto-play, the visualizer automatically
switches to the appropriate slide before rendering the event's content.

--- Playback bar ---

Pinned to the bottom of the page in two rows.

Top row: step-back (◀), play/pause (▶ / ⏸), step-forward (▶▶), a scrubber
slider spanning all events, and a "current / total" event counter.

Bottom row: the current event's phase name on the left, speed controls on the
right — 0.5×, 1× (default, shown active), 2×, 4× — plus a Loop toggle and a
Manual mode toggle.

The visualizer never advances to the next event in the middle of an animation.
Each slide entry animation declares how long it needs, and the playback engine
waits until that window has elapsed before auto-advancing.


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SLIDE 0 — START
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Two equal-width cards side by side, centered, each up to 600px wide and
stretching the full slide height. There is a gap between them.

--- Left card: source screenshot ---

Labelled "Source" in small dimmed uppercase at the top.

Shows the full-page screenshot of the original website, clipped to a fixed
container height of ~420px. If the screenshot is taller than the container,
it slowly pans downward — starting 0.6s after it appears, over between 4 and
12 seconds depending on how tall the image is (roughly 1s per 150px of
overflow). Playback does not advance until the pan finishes.

If no screenshot is available, a dark placeholder rectangle is shown instead.

--- Right card: run info ---

Labelled "Run Info" in small dimmed uppercase at the top.

The URL of the source page appears first in large bold blue text (always
visible, arrives with the card).

Below the URL is a "Configuration" sub-section with small colored badge chips,
one per enabled feature: a grey chip for the quality mode, a blue chip if
correction was enabled, and a purple chip if baseline comparison was enabled.

Below that is a "Source HTML" sub-section showing a scrollable monospace code
panel with the first portion of the source HTML. The panel fills the remaining
card height.

--- Entry animation ---

Every time this slide is entered (including via pill nav), all four content
blocks are hidden first, then they fade up into view one after another with
0.6s between each:

  1. Left card (screenshot)   — appears at 0.45s
  2. Right card (URL)         — appears at 1.05s
  3. Configuration chips      — appear at 1.65s
  4. Source HTML panel        — appears at 2.25s

After the last block fades in, playback pauses for an additional reading
window: 2.5–10s, scaled to the length of the URL and the HTML snippet so
longer content gets proportionally more time.


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SLIDE 1 — PREPROCESS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Two cards side by side. The left card (roughly 42% wide) shows the annotated
source screenshot; the right card (the remaining width, up to 460px) shows the
section list.

--- Left card: annotated source screenshot ---

Labelled "Source — detected sections".

The full-page source screenshot fills the card width. Its height is set
proportionally so the image is never stretched or cropped — the card grows to
match the real aspect ratio of the screenshot. Bounding boxes are overlaid on
top of the image, one per detected section.

Each bounding box is a colored rectangle outline with a faint matching
background tint. Its vertical position and height mirror the section's actual
position on the real page. A small pill label sits in the top-left corner of
each box showing the section's name, with the generic "section-" prefix
replaced by "§" for brevity.

Sections are assigned a unique color from a fixed 16-color cycle (blue, teal,
amber, red, purple, cyan, orange, pink, lime, indigo, etc., repeating if there
are more than 16 sections).

--- Right card: section list ---

Labelled "Sections".

The card's height matches the left card exactly, so both columns appear the
same visual height. Inside are individual section cards, one per section,
positioned absolutely so each card's vertical midpoint aligns with the
midpoint of its corresponding bounding box in the image on the left. If two
cards would overlap, the lower one is pushed down to maintain at least 8px of
gap.

Each section card contains a small thumbnail of the section (70px wide) on the
left, and on the right: the section slug in bold white, the role in dimmed
grey, and a one-line description in lighter grey below.

--- Entry animation ---

Bounding box and card pairs appear one at a time, with 1.2s between each pair.
Before each pair appears, the slide quietly scrolls so the incoming bounding
box is vertically centered in the viewport (the scroll happens 350ms before the
reveal). Then the bounding box drops in from slightly above (fades in over
0.35s) and the section card simultaneously fades up from slightly below (0.35s).

Playback is held until 2s after the last pair has appeared.

When revisiting via pill nav, everything is reset — all bounding boxes and
cards are hidden — so the full sequence re-plays from the beginning.


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SLIDE 2 — SKELETON
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Two cards side by side. The left card (~42% wide) shows the skeleton screenshot
or a placeholder; the right card (remaining width) shows the generated HTML.

--- Left card: skeleton screenshot ---

Labelled "Skeleton Preview".

While the skeleton is still being generated, the card shows an animated shimmer
bar — a dark block with a moving light band sweeping left-to-right, indicating
activity (the animation cycles every 1.5s).

Once generation finishes, the shimmer disappears and the skeleton screenshot
loads. It uses the same slow downward pan as the Start screenshot (4–12s
depending on image height).

--- Right card: skeleton HTML code panel ---

Labelled "Skeleton HTML".

The panel is hidden entirely until skeleton generation finishes, so it only
appears once there is something to show. It is populated once with the first
30,000 characters of the generated skeleton HTML file, shown in a monospace
code style.

The panel slides in from the right (starts 20px to the right and invisible,
animates to its final position in 0.55s). If there is a screenshot, the panel
waits 0.5s after the screenshot finishes loading before sliding in. If there
is no screenshot, it slides in immediately.

When revisiting via pill nav, the slide uses the generic cards fade-in (both
cards fade up into view with a 0.07s stagger).


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SLIDE 3 — SECTIONS & ASSEMBLY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

A full-width scrollable table of section rows. A small header row sits at the
top with two column labels: "Reference" on the left and "Generation" on the
right.

--- Section rows ---

One row per section, appearing in generation order. Each row has a max-height
of ~166px and contains two equal-width cells side by side.

The Reference cell shows the source screenshot thumbnail for that section.
At the very bottom of the cell is a short label bar in small dimmed text
showing the section name and its role (e.g. "§hero · hero").

The Generation cell starts with an animated shimmer placeholder (same moving
sweep as the Skeleton slide — indicating the AI is working on this section).
When a generated screenshot becomes available, the shimmer is replaced by the
actual generated image. At the bottom of the cell the same label bar appears,
plus a thin "score strip" that shows:

  - A small colored dot (green/amber/red matching the score)
  - A verdict word ("close", "partial", or "distant")
  - A numeric score value (e.g. "0.82")

All three are colored the same as the score. An optional small badge in the
top-right corner of the Generation cell shows the iteration number (e.g.
"Iter 2") for sections that were revisited in a correction pass.

--- Three visual states of the Generation cell ---

Scanning: when the AI is scoring or re-evaluating a section, the whole row
briefly pulses with a blue border glow (a keyframe that ramps up to a bright
blue outline and box-shadow then fades back to the normal dark border, over
~0.65s). This runs on the row rather than the cell itself so the glow is
not clipped.

Flashing: when a score arrives (or a correction result), the Generation cell
flickers — its opacity pulses from full to 40% and back over 0.45s — drawing
attention to the updated content.

Locked: once the section has been scored and the current pass is complete, a
score-colored top border accent is added to the Generation cell (a 2px line at
the very top, matching the score color). This persists for the rest of the
slide's lifetime. On assemble:complete, any still-unlocked cells pick up their
lock state in a staggered sequence (80ms per cell), each briefly dimming then
brightening back to full as they acquire the border.

--- Scrolling behavior ---

The slide is vertically scrollable. During any animated sequence, the slide
auto-scrolls so the row being processed is always vertically centered in the
viewport just before its animation fires (220ms lead time).

--- Event-by-event playthrough ---

As events arrive from the pipeline during auto-play:

  section:start   → the row for that section fades up from slightly below into
                    view (0.3s).
  section-score or section-correction:complete → the score strip updates, the
                    generated image is swapped in, and the cell flashes.
  assemble:complete → all unlocked cells acquire their score-colored top border
                      in a staggered wave (80ms per section).

Any rows that should be visible but somehow aren't yet get quietly caught up
with a staggered reveal.

--- Full entry animation (on pill-nav or "Next" arrival) ---

When arriving via the pill nav or Next button (not during normal auto-play),
the entire slide is reset: all rows are hidden and all Generation cells are
cleared back to shimmer state. Then the full sequence is replayed as a series
of "trips."

Trip 0 — Initial generation:
  All sections appear one row at a time, 400ms apart. Each row fades in from
  slightly below. The Generation cell is immediately shown with the initial
  generation quality (the scores from iteration 1, which reflect the page state
  before any corrections). The scan pulse fires on every row.

Trip 1, 2, … — Correction passes:
  Only the sections that were re-fixed in that pass appear (rows are already
  visible). Each affected section is visited 250ms apart. The scan pulse fires,
  and the generated image cross-fades to the newer version (old image fades out
  in 0.18s, new one fades in in 0.3s). The score strip updates and the cell
  flashes. The "Iter N" badge appears in the corner.

There is a 1s pause between each trip. Playback is held for 800ms after the
last row in the last trip completes.


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SLIDE 4 — END  (only present when hasFidelity = true)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

A single centered column filling the slide. Labelled "Pipeline Complete" at
the top.

--- Screenshots ---

Two equal-width screenshot panels side by side occupy most of the vertical
space. The left is labelled "Source" and shows the original website screenshot.
The right is labelled "Generated" and shows a full-page screenshot of the final
generated page. Both use the same slow downward pan as the other screenshot
panels.

--- Score, verdict, and bar ---

Directly below the screenshots, inline and horizontally centered:

  A large bold numeric score (e.g. "0.847") colored green/amber/red.
  A small rounded verdict badge next to it ("close", "partial", or "distant"),
  colored to match the score.

Immediately below: a thin full-width horizontal bar. The bar's filled portion
represents the score as a percentage (e.g. 84.7% filled for 0.847), colored
the same green, amber, or red.

--- Stats tiles ---

Three equally-spaced tiles beneath the bar in a row:

  Tokens In  — total input tokens used by the fidelity scoring call
  Tokens Out — total output tokens
  Duration   — how long the fidelity check took (formatted as "Xm Ys" or "Xs")

Each tile has a large bold number on top and a small dimmed label below.

--- Entry animation ---

On pill-nav arrival, all elements start hidden and fade up from slightly below
in sequence:

  1. Left screenshot (source)     — appears at 0.45s
  2. Right screenshot (generated) — appears at 0.65s
  3. Score number, verdict, bar, and stat tiles simultaneously — appear at 0.85s

Each element takes 0.4s to fade in. Playback is held for ~2.75s total.


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
DATA SOURCING SUMMARY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Two data sources are embedded in the HTML at build time:

Run metadata — a static snapshot of the run: run ID, name, URL, start/end
timestamps, estimated cost, screenshot file paths (one for the full source page,
one per section, one for the final generated page), and two boolean flags for
whether fidelity check and correction loop were enabled.

Event stream — the full sequence of pipeline events from run.ndjson, each with
a phase name, timestamp, and payload. The visualizer can replay any prefix of
this stream to reconstruct the UI state at any point in time.

A third value — the skeleton HTML — contains the first 30,000 characters of
the generated skeleton file, used only to populate the code panel on Slide 2.

Screenshot paths are stored relative to the run directory in the HTML version,
and converted to absolute filesystem URLs in the Motion Canvas version.
