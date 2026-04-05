export function buildStateLogic(slideCount: number): string {
  return `
// ── Helpers ───────────────────────────────────────────────────────────────────

function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function scoreColor(s) { return s > 0.85 ? '#22c55e' : s >= 0.6 ? '#f59e0b' : '#ef4444'; }
function scoreColorBg(s) { return s > 0.85 ? '#14532d' : s >= 0.6 ? '#451a03' : '#450a0a'; }
function fmtMs(ms) { ms=Math.round(ms); if(ms<1000) return ms+'ms'; if(ms<60000) return (ms/1000).toFixed(1)+'s'; return Math.floor(ms/60000)+'m '+Math.floor((ms%60000)/1000)+'s'; }
function fmtBytes(b) { if(b<1024) return b+'B'; if(b<1048576) return (b/1024).toFixed(1)+'KB'; return (b/1048576).toFixed(2)+'MB'; }
function fmtNum(n) { return Number(n).toLocaleString(); }

// ── Slide mapping ─────────────────────────────────────────────────────────────

var SLIDE_COUNT = ${slideCount};

function phaseToSlide(phase) {
  if (phase === 'run:start') return 0;
  if (phase === 'preprocess:start' || phase === 'preprocess:complete') return 1;
  if (phase === 'skeleton:start' || phase === 'skeleton:complete') return 2;
  if (phase === 'section:start' || phase === 'section:complete') return 3;
  if (phase === 'correction-iter:start' || phase === 'correction-iter:complete') return 3;
  if (phase === 'section-score' || phase === 'section-correction:start' || phase === 'section-correction:complete') return 3;
  if (phase === 'assemble:start' || phase === 'assemble:complete') return 3;
  if (phase === 'baseline:start' || phase === 'baseline:complete') return 3;
  if (phase === 'run:complete') return RUN_META.hasFidelity ? SLIDE_COUNT - 1 : 3;
  if (phase === 'fidelity:start' || phase === 'fidelity:complete') return RUN_META.hasFidelity ? SLIDE_COUNT - 1 : 3;
  return 0;
}

// ── State derivation ──────────────────────────────────────────────────────────

function deriveState(upTo) {
  var s = {
    runStart: null,
    preprocess: { status: 'idle', data: null },
    skeleton:   { status: 'idle', data: null },
    sections:   {},   // slug -> { status, role, order, score, verdict, fixing, durationMs }
    sectionOrder: [], // slugs in order, as seen
    corrections: [],  // { iter, status, activeSlugs, scores:{}, sectionFix:{}, aggregateScore, sectionsToFix }
    assemble:   { status: 'idle', data: null },
    fidelity:   { status: 'idle', data: null },
    baseline:   { status: 'idle', data: null },
    runComplete: null,
  };

  for (var i = 0; i <= upTo; i++) {
    var ev = EVENTS[i], p = ev.phase, d = ev.data || {}, k, iter;
    if (p === 'run:start') { s.runStart = d; }
    else if (p === 'preprocess:start') { s.preprocess.status = 'active'; }
    else if (p === 'preprocess:complete') { s.preprocess.status = 'complete'; s.preprocess.data = d; }
    else if (p === 'skeleton:start') { s.skeleton.status = 'active'; }
    else if (p === 'skeleton:complete') { s.skeleton.status = 'complete'; s.skeleton.data = d; }
    else if (p === 'section:start') {
      if (s.sectionOrder.indexOf(d.slug) < 0) s.sectionOrder.push(d.slug);
      s.sections[d.slug] = { status: 'active', role: d.role, order: d.order, score: null, verdict: null, genPath: null, fixing: false, durationMs: null };
    }
    else if (p === 'section:complete') {
      if (s.sections[d.slug]) { s.sections[d.slug].status = 'complete'; s.sections[d.slug].durationMs = d.durationMs; }
    }
    else if (p === 'assemble:start') { s.assemble.status = 'active'; }
    else if (p === 'assemble:complete') { s.assemble.status = 'complete'; s.assemble.data = d; }
    else if (p === 'correction-iter:start') {
      var iterObj = { iter: d.iteration, status: 'active', activeSlugs: d.activeSlugs, scores: {}, sectionFix: {}, aggregateScore: null, sectionsToFix: null };
      s.corrections.push(iterObj);
    }
    else if (p === 'section-score') {
      for (k = s.corrections.length - 1; k >= 0; k--) {
        if (s.corrections[k].iter === d.iteration) { s.corrections[k].scores[d.slug] = { score: d.score, verdict: d.verdict, issues: d.issues, genPath: d.generatedScreenshotPath, srcPath: d.sourceScreenshotPath }; break; }
      }
      if (s.sections[d.slug]) { s.sections[d.slug].score = d.score; s.sections[d.slug].verdict = d.verdict; if (d.generatedScreenshotPath) s.sections[d.slug].genPath = d.generatedScreenshotPath; }
    }
    else if (p === 'section-correction:start') {
      for (k = s.corrections.length - 1; k >= 0; k--) {
        if (s.corrections[k].iter === d.iteration) { s.corrections[k].sectionFix[d.slug] = 'fixing'; break; }
      }
      if (s.sections[d.slug]) s.sections[d.slug].fixing = true;
    }
    else if (p === 'section-correction:complete') {
      for (k = s.corrections.length - 1; k >= 0; k--) {
        if (s.corrections[k].iter === d.iteration) { s.corrections[k].sectionFix[d.slug] = 'fixed'; break; }
      }
      if (s.sections[d.slug]) s.sections[d.slug].fixing = false;
    }
    else if (p === 'correction-iter:complete') {
      for (k = s.corrections.length - 1; k >= 0; k--) {
        if (s.corrections[k].iter === d.iteration) { s.corrections[k].status = 'complete'; s.corrections[k].aggregateScore = d.aggregateScore; s.corrections[k].sectionsToFix = d.sectionsToFix; break; }
      }
    }
    else if (p === 'fidelity:start') { s.fidelity.status = 'active'; }
    else if (p === 'fidelity:complete') { s.fidelity.status = 'complete'; s.fidelity.data = d; }
    else if (p === 'baseline:start') { s.baseline.status = 'active'; }
    else if (p === 'baseline:complete') { s.baseline.status = 'complete'; s.baseline.data = d; }
    else if (p === 'run:complete') { s.runComplete = d; }
  }
  return s;
}

// ── One-time slide initialisation ────────────────────────────────────────────

var sp = RUN_META.screenshotPaths;

// Slide 0 init
(function() {
  if (sp && sp.source) {
    var img = document.getElementById('s0-source');
    img.src = sp.source; img.style.display = '';
    document.getElementById('s0-source-ph').style.display = 'none';
  }
  // Run config chips — from first run:start event
  var rsEv = EVENTS.find(function(e){ return e.phase === 'run:start'; });
  if (rsEv) {
    var d = rsEv.data;
    var chips = [
      { label: d.qualityMode, color: '#6b7280' },
      d.correctionEnabled ? { label: 'correction', color: '#3b82f6' } : null,
      d.baselineEnabled ? { label: 'baseline', color: '#8b5cf6' } : null,
    ].filter(Boolean);
    document.getElementById('s0-chips').innerHTML = chips.map(function(c) {
      return '<span class="chip" style="background:' + c.color + '22;color:' + c.color + ';border:1px solid ' + c.color + '44">' + esc(c.label) + '</span>';
    }).join('');
  }
  // HTML snippet — from preprocess:complete
  var ppEv = EVENTS.find(function(e){ return e.phase === 'preprocess:complete'; });
  if (ppEv && ppEv.data.htmlSnippet) {
    document.getElementById('s0-html').textContent = ppEv.data.htmlSnippet;
  }
})();

// Slide 1 init — source image
(function() {
  if (sp && sp.source) {
    var img = document.getElementById('pp-source-img');
    img.src = sp.source;
    img.style.display = '';
    // Use actual image aspect ratio for paddingBottom so no distortion regardless of scrollHeight mismatch
    function setPpWrapAspect() {
      var wrap = document.getElementById('pp-img-wrap');
      if (wrap && img.naturalWidth > 0) {
        wrap.style.paddingBottom = (img.naturalHeight / img.naturalWidth * 100).toFixed(3) + '%';
      }
      _lastRenderedSlide1Count = -1;
    }
    if (img.complete && img.naturalWidth > 0) { setPpWrapAspect(); }
    else { img.onload = setPpWrapAspect; }
  }
  // Build bounding box placeholders (all invisible) + section cards (all invisible)
  var ppEv = EVENTS.find(function(e){ return e.phase === 'preprocess:complete'; });
  if (!ppEv || !ppEv.data.sections) return;
  var sections = ppEv.data.sections;
  var totalH = sections.reduce(function(acc, s) { return acc + s.heightPx; }, 0);
  if (totalH <= 0) return;
  // Use pageHeight (actual scroll height) for bbox %, so they align with the full-page screenshot
  var pageH = ppEv.data.pageHeight || totalH;
  var colors = ['#3b82f6','#10b981','#f59e0b','#ef4444','#8b5cf6','#06b6d4','#f97316','#ec4899','#84cc16','#6366f1','#14b8a6','#fb923c','#a855f7','#0ea5e9','#d946ef','#22d3ee'];
  var bboxContainer = document.getElementById('pp-bboxes');
  var secList = document.getElementById('sec-list');
  sections.forEach(function(sec, idx) {
    var color = colors[idx % colors.length];
    var topPct = (sec.y / pageH * 100).toFixed(3) + '%';
    var hPct   = (sec.heightPx / pageH * 100).toFixed(3) + '%';
    var box = document.createElement('div');
    box.className = 'bbox'; box.id = 'bbox-' + sec.slug;
    box.style.top = topPct; box.style.height = hPct;
    box.style.borderColor = color; box.style.background = color + '15';
    box.innerHTML = '<span class="bbox-label" style="background:' + color + '">' + esc(sec.slug.replace('section-','\u00a7')) + '</span>';
    bboxContainer.appendChild(box);
    // section card
    var thumbSrc = sp && sp.sections && sp.sections[sec.slug] ? sp.sections[sec.slug] : null;
    var card = document.createElement('div');
    card.className = 'sec-card'; card.id = 'seccard-' + sec.slug;
    card.innerHTML = (thumbSrc ? '<div class="sec-thumb"><img src="' + esc(thumbSrc) + '" /></div>' : '') +
      '<div class="sec-meta"><div class="slug">' + esc(sec.slug) + '</div>' +
      '<div class="role">' + esc(sec.role) + '</div>' +
      '<div class="desc">' + esc(sec.description || '') + '</div></div>';
    secList.appendChild(card);
  });
})();

// Slide 3 init — build rows: ref | gen
(function() {
  var ppEv = EVENTS.find(function(e){ return e.phase === 'preprocess:complete'; });
  var sections = (ppEv && ppEv.data.sections) ? ppEv.data.sections : [];
  if (sections.length === 0) {
    EVENTS.forEach(function(e) {
      if (e.phase === 'section:start') {
        if (!sections.find(function(s){ return s.slug === e.data.slug; })) {
          sections.push({ slug: e.data.slug, role: e.data.role, order: e.data.order, description: '', y: 0, heightPx: 0 });
        }
      }
    });
    sections.sort(function(a,b){ return a.order - b.order; });
  }
  var rowsContainer = document.getElementById('sxa-rows');
  sections.forEach(function(sec) {
    var thumbSrc = sp && sp.sections && sp.sections[sec.slug] ? sp.sections[sec.slug] : null;
    var lbl = esc(sec.slug.replace('section-', '\u00a7')) + (sec.role ? ' \u00b7 ' + esc(sec.role) : '');
    var scoreBarHtml = '<div class="fc-score-bar"><span class="fc-score-dot"></span><span class="fc-verdict"></span><span class="fc-score-val"></span></div>';

    var row = document.createElement('div');
    row.className = 'sxa-row'; row.id = 'sxar-' + sec.slug;
    row.style.opacity = '0';
    row.innerHTML =
      // Reference cell
      '<div class="sxa-row-ref" id="ref-card-' + sec.slug + '">' +
        (thumbSrc ? '<img src="' + esc(thumbSrc) + '" />' : '<div class="sec-shimmer shimmer"></div>') +
        '<div class="sec-lbl">' + lbl + '</div>' +
      '</div>' +
      // Gen cell
      '<div class="sxa-row-gen" id="sxag-' + sec.slug + '">' +
        '<div class="sec-shimmer shimmer"></div>' +
        '<div class="iter-badge" style="display:none"></div>' +
        scoreBarHtml +
        '<div class="sec-lbl">' + lbl + '</div>' +
      '</div>';
    rowsContainer.appendChild(row);
  });
})();`;
}
