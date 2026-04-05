import { escHtml } from "../../utils";
import { formatDuration } from "../report-utils";

export interface HtmlShellParams {
  title: string;
  url: string;
  slidePills: string;
  eventCount: number;
  hasFidelity: boolean;
  finalScoreStr: string;
  finalScoreColor: string;
  estimatedCostUsd: number;
  durationMs: number;
}

export function buildHtmlShell(p: HtmlShellParams): string {
  const {
    title, url, slidePills, eventCount, hasFidelity,
    finalScoreStr, finalScoreColor, estimatedCostUsd, durationMs,
  } = p;

  return `
<!-- Header -->
<div class="hdr">
  <div class="hdr-title">${escHtml(title)}</div>
  <div class="hdr-url">${escHtml(url)}</div>
  <div class="hdr-stat">Sections <span id="hdr-sections">—</span></div>
  <div class="hdr-stat">Cost <span>$${estimatedCostUsd.toFixed(3)}</span></div>
  <div class="hdr-stat">Duration <span>${formatDuration(durationMs)}</span></div>
  <div class="hdr-score" id="hdr-score" style="color:${finalScoreColor}">${finalScoreStr}</div>
</div>

<!-- Stage pills -->
<div class="pills" id="pills">${slidePills}<button class="cbtn next-slide-btn" onclick="manualNextSlide()">Next &#9654;</button></div>

<!-- Carousel -->
<div class="carousel-outer">
  <div class="carousel-track" id="track">

    <!-- Slide 0: Start -->
    <div class="slide" id="slide-0">
      <div class="start-left card">
        <div class="card-lbl">Source</div>
        <div class="img-pan-wrap" id="s0-pan-wrap">
          <img id="s0-source" src="" style="display:none" />
          <div id="s0-source-ph" style="height:300px;background:#0d1117;border-radius:4px"></div>
        </div>
      </div>
      <div class="start-right card">
        <div class="card-lbl">Run Info</div>
        <div class="start-url">${escHtml(url)}</div>
        <div id="s0-config-section" style="opacity:0">
          <div class="card-lbl" style="margin-top:0.85rem">Configuration</div>
          <div class="config-chips" id="s0-chips"></div>
        </div>
        <div id="s0-html-section" style="opacity:0">
          <div class="card-lbl" style="margin-top:0.85rem">Source HTML</div>
          <div class="html-snippet" id="s0-html">—</div>
        </div>
      </div>
    </div>

    <!-- Slide 1: Preprocess -->
    <div class="slide" id="slide-1">
      <div class="pp-left card">
        <div class="card-lbl">Source — detected sections</div>
        <div class="pp-img-wrap" id="pp-img-wrap">
          <img class="ss" id="pp-source-img" src="" style="display:none" />
          <div id="pp-bboxes"></div>
        </div>
      </div>
      <div class="pp-right card">
        <div class="card-lbl">Sections</div>
        <div class="sec-list" id="sec-list"></div>
      </div>
    </div>

    <!-- Slide 2: Skeleton -->
    <div class="slide" id="slide-2">
      <div class="skel-left card">
        <div class="card-lbl">Skeleton Preview</div>
        <div id="skel-ph" class="shimmer skel-placeholder"></div>
        <div class="img-pan-wrap" id="skel-pan-wrap" style="display:none">
          <img id="skel-img" src="" />
        </div>
      </div>
      <div class="skel-right card" id="skel-html-card" style="display:none">
        <div class="card-lbl">Skeleton HTML</div>
        <pre class="skel-html-code" id="skel-html-code"></pre>
      </div>
    </div>

    <!-- Slide 3: Sections & Assembly -->
    <div class="slide" id="slide-3">
      <div class="sxa-table">
        <div class="sxa-hdr">
          <div class="sxa-hdr-col">Reference</div>
          <div class="sxa-hdr-col" id="sxa-gen-lbl">Generation</div>
        </div>
        <div id="sxa-rows"></div>
      </div>
    </div>

    ${hasFidelity ? `<!-- Slide 4: End -->
    <div class="slide" id="slide-4">
      <div class="fi-wrap" style="max-width:none;flex:1;min-width:0">
        <div class="card-lbl" style="margin-bottom:0.75rem">Pipeline Complete</div>
        <div class="two-up" style="margin-bottom:0.85rem">
          <div>
            <div class="two-up-lbl">Source</div>
            <div class="img-pan-wrap"><img id="fi-src" class="ss" src="" style="display:none" /></div>
          </div>
          <div>
            <div class="two-up-lbl">Generated</div>
            <div class="img-pan-wrap"><img id="fi-img" class="ss" src="" style="display:none" /></div>
          </div>
        </div>
        <div id="fi-score-row" style="display:flex;align-items:center;gap:0.8rem;margin-bottom:0.5rem">
          <div class="score-big" id="fi-score" style="color:#6b7280">—</div>
          <span id="fi-verdict" style="font-size:0.72rem;font-weight:600;border-radius:999px;padding:0.2rem 0.6rem;background:#21262d;color:#9ca3af"></span>
        </div>
        <div class="bar-track"><div class="bar-fill" id="fi-bar" style="width:0%;background:#6b7280"></div></div>
        <div class="skel-stats" style="margin-top:0.75rem" id="fi-stats">
          <div class="stat-tile"><div class="val" id="fi-ti">—</div><div class="lbl">Tokens In</div></div>
          <div class="stat-tile"><div class="val" id="fi-to">—</div><div class="lbl">Tokens Out</div></div>
          <div class="stat-tile"><div class="val" id="fi-dur">—</div><div class="lbl">Duration</div></div>
        </div>
      </div>
    </div>` : ""}

  </div><!-- /track -->
</div><!-- /carousel-outer -->

<!-- Playback bar -->
<div class="pb">
  <div class="pb-top">
    <button class="cbtn" onclick="step(-1)">&#9664;</button>
    <button class="cbtn" id="play-pause-btn" onclick="togglePlay()">&#9654;</button>
    <button class="cbtn" onclick="step(1)">&#9654;&#9654;</button>
    <input type="range" id="scrubber" min="0" max="${eventCount - 1}" value="0" oninput="onScrub(this.value)" />
    <span id="step-counter">1 / ${eventCount}</span>
  </div>
  <div class="pb-bot">
    <span id="step-label"></span>
    <span style="flex:1"></span>
    <span>Speed:</span>
    <button class="cbtn speed-btn" data-dwell="2000" onclick="setSpeed(2000)">0.5&#215;</button>
    <button class="cbtn speed-btn active" data-dwell="1000" onclick="setSpeed(1000)">1&#215;</button>
    <button class="cbtn speed-btn" data-dwell="500" onclick="setSpeed(500)">2&#215;</button>
    <button class="cbtn speed-btn" data-dwell="250" onclick="setSpeed(250)">4&#215;</button>
    <button class="cbtn" id="loop-btn" onclick="toggleLoop()">&#8635; Loop</button>
    <span style="margin-left:0.4rem;border-left:1px solid #30363d;padding-left:0.6rem"></span>
    <button class="cbtn active" id="manual-mode-btn" onclick="toggleManualMode()">Manual</button>
  </div>
</div>`;
}
