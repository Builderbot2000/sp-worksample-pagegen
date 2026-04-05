MOTION CANVAS VISUALIZATION REQUIREMENTS
========================================
A single continuous video. No slides, no carousels. The canvas scrolls and
evolves as one unbroken sequence. Elements introduced early persist and are
built upon as later phases arrive.


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PERSISTENT ELEMENTS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

A slim navbar-like bar is the very first thing to appear and never leaves.
It fades in at the top of the screen before anything else and stays pinned
there for the entire duration of the video.

The bar shows the target URL on the left and the run configuration chips to its
right — one chip per enabled feature (quality mode, correction, baseline). The
contents of this bar are taken from the run:start event.


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SEQUENCE 1 — START PHASE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

After the navbar fades in, two columns appear below it simultaneously, each
taking exactly half the screen width.

The left column contains the full-page source screenshot. The right column
contains the source HTML as a monospace code block. Both columns start
appearing at the top of their content and the camera continuously scrolls
downward as they materialize, so the viewer always sees the leading edge of the
reveal rather than content appearing out of view. The scroll speed is matched
to the reveal speed so nothing is wasted.

The screenshot on the left must show the entire page — it is not clipped. The
HTML on the right may be cut off if it would make the overall column taller
than the screenshot column; the two columns end at the same point so they
always look balanced.

Once both columns have fully appeared and a brief reading pause has elapsed,
the camera scrolls back up to the top.


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SEQUENCE 2 — PREPROCESS PHASE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

With the camera back at the top, the source screenshot on the left is still
visible. The right column — the source HTML — drops downward and disappears
off the bottom of the frame, falling below the lower boundary defined by the
bottom of the left screenshot column, making room for what comes next on the
right side.

The bounding boxes for each detected section now appear on the source
screenshot one at a time in order from top to bottom of the page.

For each section, the camera first scrolls so that the incoming bounding box is
vertically centered in the viewport. Then the bounding box grows downward into
existence — it does not simply pop in, but reveals from its top edge to its
bottom edge. A short moment after the box finishes appearing, a callout card
slides in from the left and settles on the right half of the screen at the
height corresponding to that section.

The callout card is borderless — a clean floating text block showing the
section name, its role, and a one-line description. At the same moment the
callout appears, a thin line draws itself from the callout's vertical midpoint
across to the vertical center of the corresponding bounding box on the left.

After the last callout has settled and the line has drawn, the camera holds
briefly before the next phase begins.


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SEQUENCE 3 — SKELETON PHASE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

The camera zooms out to reveal a new isolated region below and to the right of
the current view. The transition is bridged by an arrow that shoots out from
the bottom of the source screenshot, curves downward and to the right, and
lands at the incoming skeleton pair. As the arrow arrives, the skeleton pair
fades in from left to right.

The skeleton pair is laid out the same way as the Start phase — two columns,
each exactly half the screen. The left column holds the skeleton screenshot,
the right column holds the skeleton HTML. Once the pair has fully appeared, the
camera zooms in so that this pair fills the screen, with each column taking
50% of the width. The HTML column then auto-scrolls downward through its full
content before the camera zooms back out to the wide view.


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SEQUENCE 4 — SECTIONS & CORRECTION PHASE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

The camera refocuses on the region containing the annotated source screenshot
and the section callouts from Sequence 2, but zoomed out enough that a good
number of callouts are simultaneously visible.

From every callout, an arrow simultaneously shoots out to the right. After a
moment the arrows stop and their endpoints fade in containers — one per section
— each sized to match the dimensions of that section's bounding box. These
containers initially show the initial generated screenshot for that section.

--- Correction window ---

A bordered rectangular window fades in on top of all the generated section
containers. It begins at the top and moves steadily downward, passing over each
container in order. There is one downward pass per correction iteration that
was run.

As the window passes over a section container it leaves behind a border on that
container. The border color reflects the fidelity score for that section in
that iteration — green for high fidelity, amber for marginal, red for poor.
Alongside the border, three small pieces of text appear beside the container:
the numeric score, a short snippet of the discrepancy list, and the iteration
number.

If a section reaches a passing fidelity score, a second border is drawn on top
of the first to mark it as locked. The window's subsequent passes do not affect
locked sections — it moves through them without updating their markings.

The window comes to rest at the position where the final iteration ended.

--- Transition out of sections ---

Once all iterations are complete, all locked section containers simultaneously
shoot arrows to the right and bend toward the skeleton pair from Sequence 3.


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SEQUENCE 5 — ENDING PHASE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

The arrows from the locked section containers arrive at the skeleton pair. Both
columns of the skeleton pair flash and refresh: the left column cross-fades
from the skeleton screenshot to the final generated page screenshot, and the
right column cross-fades from the skeleton HTML to the full generated HTML.
The refreshed pair then auto-scrolls the generated HTML fully, mirroring the
same treatment the skeleton pair received in Sequence 3. The camera remains
zoomed in on this pair for a held beat as the video ends.

