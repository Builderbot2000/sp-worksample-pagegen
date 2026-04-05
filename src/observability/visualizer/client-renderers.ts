export function buildRenderLogic(): string {
  return `
// ── Slide renderers ───────────────────────────────────────────────────────────

function scrollSlide1To(slug) {
  var slideEl = document.getElementById('slide-1');
  if (!slideEl) return;
  var bboxEl = document.getElementById('bbox-' + slug);
  var cardEl = document.getElementById('seccard-' + slug);
  var refEl = bboxEl || cardEl;
  if (!refEl) return;
  var slideRect = slideEl.getBoundingClientRect();
  var refRect = refEl.getBoundingClientRect();
  var midY = (refRect.top + refRect.bottom) / 2;
  var slideCenter = (slideRect.top + slideRect.bottom) / 2;
  slideEl.scrollBy({ top: midY - slideCenter, behavior: 'smooth' });
}

var _lastRenderedSlide1Count = -1;
function renderSlide1(state) {
  var entryDelay = _newSlideEntryDelay; _newSlideEntryDelay = 0;
  var ppData = state.preprocess.data;
  if (!ppData || !ppData.sections) return;
  var sections = ppData.sections;
  var totalH = sections.reduce(function(acc, s) { return acc + s.heightPx; }, 0);
  if (totalH <= 0) return;
  // Show bounding boxes for sections that have been encountered in section:start
  var known = state.sectionOrder;
  var count = 0;
  var newPairs = [];
  sections.forEach(function(sec) {
    var visible = known.indexOf(sec.slug) >= 0 || state.preprocess.status === 'complete';
    var box = document.getElementById('bbox-' + sec.slug);
    var card = document.getElementById('seccard-' + sec.slug);
    if (card) {
      var wasVisible = card.classList.contains('visible');
      if (visible && !wasVisible) {
        card.classList.add('visible');
        newPairs.push({ slug: sec.slug, card: card, bbox: box });
      } else if (!visible && wasVisible) {
        card.classList.remove('visible');
        gsap.to(card, { opacity: 0, y: 6, duration: 0.2 });
        if (box) gsap.set(box, { opacity: 0 });
      }
    }
    if (visible) count++;
  });
  if (newPairs.length > 0) {
    if (currentSlide === 1) {
      var pairStagger = 0.6;
      var lastStart = entryDelay + (newPairs.length > 1 ? (newPairs.length - 1) * pairStagger : 0);
      setReadyAfter((lastStart + 0.35 + 2.0) * 1000);
      newPairs.forEach(function(pair, i) {
        var d = entryDelay + i * pairStagger;
        // Scroll to location first, then reveal elements
        (function(slug, delay) {
          setTimeout(function() { scrollSlide1To(slug); }, Math.max(0, delay - 0.35) * 1000);
        })(pair.slug, d);
        if (pair.bbox) gsap.fromTo(pair.bbox, { opacity: 0, y: -6 }, { opacity: 1, y: 0, duration: 0.35, delay: d, ease: 'power2.out' });
        gsap.to(pair.card, { opacity: 1, y: 0, duration: 0.35, delay: d, ease: 'power1.out' });
      });
    } else {
      newPairs.forEach(function(pair) {
        gsap.set(pair.card, { opacity: 1, y: 0 });
        if (pair.bbox) gsap.set(pair.bbox, { opacity: 1 });
      });
    }
  }
  // Align section cards to match bbox vertical positions once image dimensions are known
  var wrap = document.getElementById('pp-img-wrap');
  var wrapH = wrap ? wrap.offsetHeight : 0;
  if (wrapH > 0 && _lastRenderedSlide1Count !== count) {
    _lastRenderedSlide1Count = count;
    var pageH = ppData.pageHeight || totalH;
    var secListEl = document.getElementById('sec-list');
    if (secListEl) {
      secListEl.style.height = wrapH + 'px';
      var minTop = 0;
      sections.forEach(function(sec) {
        var card = document.getElementById('seccard-' + sec.slug);
        if (!card) return;
        var idealTop = (sec.y / pageH) * wrapH;
        var top = Math.max(idealTop, minTop);
        card.style.top = top + 'px';
        minTop = top + (card.offsetHeight || 80) + 8;
      });
    }
  }
}

function renderSlide2(state) {
  var sk = state.skeleton;
  if (sk.status === 'idle') return;
  if (sk.status === 'active') {
    document.getElementById('skel-ph').style.display = '';
    var panWrap = document.getElementById('skel-pan-wrap');
    if (panWrap) panWrap.style.display = 'none';
    document.getElementById('skel-stats').style.display = 'none';
    return;
  }
  // complete
  var d = sk.data;
  document.getElementById('skel-ph').style.display = 'none';
  // Populate and show HTML code panel (once)
  var htmlCard = document.getElementById('skel-html-card');
  var htmlCode = document.getElementById('skel-html-code');
  if (htmlCard && !htmlCard.dataset.populated) {
    htmlCard.dataset.populated = '1';
    if (htmlCode && typeof SKELETON_HTML !== 'undefined' && SKELETON_HTML) {
      htmlCode.textContent = SKELETON_HTML;
    }
    htmlCard.style.display = '';
    gsap.set(htmlCard, { opacity: 0, x: 20 });
  }
  if (d && d.screenshotPath) {
    var panWrap = document.getElementById('skel-pan-wrap');
    var skImg = document.getElementById('skel-img');
    if (panWrap) panWrap.style.display = '';
    if (skImg && !skImg.getAttribute('src')) {
      setReadyAfter(4000); // hold until image loads; startPan will extend precisely
      skImg.src = d.screenshotPath;
      skImg.onload = function() {
        startPan(skImg);
        // Slide HTML panel in after screenshot is showing
        var hc = document.getElementById('skel-html-card');
        if (hc) gsap.to(hc, { opacity: 1, x: 0, duration: 0.55, delay: 0.5, ease: 'power2.out', clearProps: 'transform' });
      };
    }
  } else {
    // No screenshot — show HTML panel immediately
    if (htmlCard) gsap.to(htmlCard, { opacity: 1, x: 0, duration: 0.55, ease: 'power2.out', clearProps: 'transform' });
  }
  document.getElementById('skel-stats').style.display = '';
  if (d) {
    document.getElementById('skel-model').textContent = d.model || '\u2014';
    document.getElementById('skel-tokens').textContent = fmtNum(d.tokensIn) + ' / ' + fmtNum(d.tokensOut);
    document.getElementById('skel-dur').textContent = fmtMs(d.durationMs);
  }
}

function renderSlide3(state, ev) {
  var slugKeys = Object.keys(state.sections);
  slugKeys.forEach(function(slug) {
    var sec = state.sections[slug];
    var row = document.getElementById('track-' + slug);
    if (!row) return;
    var prevStatusAttr = row.getAttribute('data-status');
    row.setAttribute('data-status', sec.status);
    if (sec.status === 'active' && prevStatusAttr !== 'active') {
      setTimeout(function() { row.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, 100);
    }
    // Score badge
    var badge = document.getElementById('tsb-' + slug);
    if (badge && sec.score !== null) {
      var clr = scoreColor(sec.score);
      badge.style.display = '';
      badge.textContent = sec.score.toFixed(2);
      badge.style.background = scoreColorBg(sec.score);
      badge.style.color = clr;
    }
    // Build timeline cells
    var tl = document.getElementById('tl-' + slug);
    if (!tl) return;
    var cells = [];
    // Reference cell first \u2014 shown as soon as section is known
    if (sec.status !== 'idle') {
      var refSrc = sp && sp.sections && sp.sections[slug] ? sp.sections[slug] : null;
      var isRefActive = ev && ev.data && ev.data.slug === slug &&
        (ev.phase === 'section:start' || ev.phase === 'section:complete');
      cells.push({ type: 'ref', img: refSrc, active: isRefActive });
      cells.push({ type: 'sep' });
    }
    // Correction iteration cells
    state.corrections.forEach(function(it) {
      if (it.activeSlugs.indexOf(slug) < 0 && !it.scores[slug]) return;
      var sc = it.scores[slug];
      var isFix = it.sectionFix[slug] === 'fixing';
      var clr = sc ? scoreColor(sc.score) : null;
      var genPath = sc ? sc.genPath : null;
      var isActiveDuringThisIter = ev && ev.data &&
        ((ev.phase === 'section-score' && ev.data.iteration === it.iter && ev.data.slug === slug) ||
         (ev.phase === 'section-correction:start' && ev.data.iteration === it.iter && ev.data.slug === slug) ||
         (ev.phase === 'section-correction:complete' && ev.data.iteration === it.iter && ev.data.slug === slug) ||
         (ev.phase === 'correction-iter:start' && ev.data.iteration === it.iter) ||
         (ev.phase === 'correction-iter:complete' && ev.data.iteration === it.iter));
      cells.push({ type: 'gen', label: 'iter ' + it.iter, img: genPath, score: sc ? sc.score : null, clr: clr, active: isActiveDuringThisIter, fixing: isFix, verdict: sc ? sc.verdict : null, issues: sc ? sc.issues : null });
    });
    if (cells.length === 0 && sec.status === 'idle') {
      tl.innerHTML = '<div class="tl-pending">\u25cb</div>';
      return;
    }
    // Determine if section is graduated
    var lastScore = sec.score;
    var graduated = lastScore !== null && lastScore >= 0.70;
    tl.innerHTML = cells.map(function(cell) {
      if (cell.type === 'sep') return '<div class="tl-sep"></div>';
      var isRef = cell.type === 'ref';
      var clsExtra = isRef ? ' tl-ref-style' : (cell.active ? ' active-cell' : (graduated ? ' grad-cell' : ''));
      var borderClr = isRef ? '#374151' : (cell.active ? '#3b82f6' : (graduated ? '#22c55e' : (cell.clr || '#21262d')));
      var inner = cell.img
        ? '<img src="' + esc(cell.img) + '" loading="lazy" />'
        : '<div class="tl-no-img">' + (isRef ? '?' : '\u2026') + '</div>';
      var verdBadge = (!isRef && cell.verdict)
        ? '<span class="tl-verdict" style="background:' + (cell.clr||'#6b7280') + '33;color:' + (cell.clr||'#6b7280') + '">' + esc(cell.verdict) + '</span>' : '';
      var scoreOverlay = (!isRef && cell.score !== null)
        ? '<div class="tl-overlay"><span>' + cell.score.toFixed(2) + '</span>' + verdBadge + '</div>' : '';
      var lbl = isRef
        ? '<div class="tl-ref-label">REF</div>'
        : '<div class="tl-label">' + esc(cell.label) + (cell.fixing ? ' \uD83D\uDD27' : '') + '</div>';
      var issuesHtml = (!isRef && cell.issues && cell.issues.length)
        ? '<div class="tl-issues">' + cell.issues.map(function(s){ return esc(s); }).join(' \u00b7 ') + '</div>' : '';
      return '<div class="tl-cell' + clsExtra + '" style="border-color:' + borderClr + '"><div class="tl-cell-img">' + inner + scoreOverlay + lbl + '</div>' + issuesHtml + '</div>';
    }).join('');
    // Scroll active cell into view
    if (ev) {
      var activeCellEl = tl.querySelector('.active-cell');
      if (activeCellEl) activeCellEl.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
    }
  });
}

function renderSlide4(state) {
  var asm = state.assemble;
  var chips = document.getElementById('fly-chips');
  // Always show section chips, landed or not
  var slugKeys = Object.keys(state.sections);
  slugKeys.sort(function(a, b) { return (state.sections[a].order || 0) - (state.sections[b].order || 0); });
  var existingIds = {};
  Array.from(chips.children).forEach(function(c) { existingIds[c.id] = true; });
  slugKeys.forEach(function(slug, idx) {
    var sec = state.sections[slug];
    if (!existingIds['fc-' + slug]) {
      var clr = sec.score !== null ? scoreColor(sec.score) : '#6b7280';
      var chip = document.createElement('span');
      chip.className = 'fly-chip chip'; chip.id = 'fc-' + slug;
      chip.style.background = clr + '22'; chip.style.color = clr; chip.style.border = '1px solid ' + clr + '44';
      chip.textContent = slug.replace('section-', '\u00a7');
      chips.appendChild(chip);
      // Stagger land animation
      gsap.fromTo(chip, { opacity: 0, x: -20 }, { opacity: 1, x: 0, duration: 0.3, delay: idx * 0.06, ease: 'power1.out' });
    } else {
      // Update color if score arrived
      var chip = document.getElementById('fc-' + slug);
      if (chip && sec.score !== null) {
        var clr = scoreColor(sec.score);
        chip.style.background = clr + '22'; chip.style.color = clr; chip.style.border = '1px solid ' + clr + '44';
      }
    }
  });
  if (asm.data) {
    var statsEl = document.getElementById('asm-stats');
    if (statsEl) { statsEl.style.display = ''; document.getElementById('asm-size').textContent = fmtBytes(asm.data.htmlSizeBytes); document.getElementById('asm-dur').textContent = fmtMs(asm.data.durationMs); }
    // Show two-up
    document.getElementById('asm-placeholder').style.display = 'none';
    document.getElementById('asm-twoups').style.display = '';
    var srcImg = document.getElementById('asm-src');
    if (srcImg && sp && sp.source) srcImg.src = sp.source;
    var genImg = document.getElementById('asm-gen');
    if (genImg && sp && sp.fidelityMain) genImg.src = sp.fidelityMain;
  }
  if (state.runComplete) {
    // Show summary tiles
    ['sum-score','sum-cost','sum-dur'].forEach(function(id) {
      var el = document.getElementById(id);
      if (el) gsap.to(el, { opacity: 1, y: 0, duration: 0.4, ease: 'power1.out' });
    });
    var fiData = state.fidelity.data;
    if (fiData) {
      var scoreEl = document.getElementById('sum-score-val');
      if (scoreEl) { scoreEl.textContent = fiData.mainScore.toFixed(3); scoreEl.style.color = scoreColor(fiData.mainScore); }
    }
  }
}

function renderSlide5(state) {
  var fi = state.fidelity;
  if (fi.status === 'idle') return;
  if (!fi.data) return;
  var d = fi.data;
  var clr = scoreColor(d.mainScore);
  var scoreEl = document.getElementById('fi-score');
  if (scoreEl) { scoreEl.textContent = d.mainScore.toFixed(3); scoreEl.style.color = clr; }
  var barEl = document.getElementById('fi-bar');
  if (barEl) { barEl.style.width = Math.round(d.mainScore * 100) + '%'; barEl.style.background = clr; }
  var verdEl = document.getElementById('fi-verdict');
  if (verdEl) { verdEl.textContent = d.mainScore > 0.85 ? 'close' : d.mainScore >= 0.6 ? 'partial' : 'distant'; verdEl.style.color = clr; }
  var ti = document.getElementById('fi-ti'), to = document.getElementById('fi-to'), dur = document.getElementById('fi-dur');
  if (ti) ti.textContent = fmtNum(d.tokensIn);
  if (to) to.textContent = fmtNum(d.tokensOut);
  if (dur) dur.textContent = fmtMs(d.durationMs);
  if (sp && sp.source) {
    var srcImg = document.getElementById('fi-src');
    if (srcImg && !srcImg.getAttribute('src')) {
      srcImg.src = sp.source; srcImg.style.display = '';
      srcImg.onload = function() { startPan(srcImg); };
    }
  }
  if (sp && sp.fidelityMain) {
    var genImg = document.getElementById('fi-img');
    if (genImg && !genImg.getAttribute('src')) {
      genImg.src = sp.fidelityMain; genImg.style.display = '';
      genImg.onload = function() { startPan(genImg); };
    }
  }
}

// ── Carousel ──────────────────────────────────────────────────────────────────

var currentSlide = -1;function animateSlide0Entry() {
  var cDur = 0.45, step = 0.6, animDur = 0.45;
  var leftCard  = document.querySelector('#slide-0 .start-left');
  var rightCard = document.querySelector('#slide-0 .start-right');
  var configSec = document.getElementById('s0-config-section');
  var htmlSec   = document.getElementById('s0-html-section');
  // Snap all to hidden starting state
  if (leftCard)  gsap.set(leftCard,  { opacity: 0, y: 14 });
  if (rightCard) gsap.set(rightCard, { opacity: 0, y: 14 });
  if (configSec) gsap.set(configSec, { opacity: 0, y: 8 });
  if (htmlSec)   gsap.set(htmlSec,   { opacity: 0, y: 8 });
  // Sequential pop-in: screenshot → Run Info card (URL) → config → html snippet
  if (leftCard)  gsap.to(leftCard,  { opacity: 1, y: 0, duration: animDur, delay: cDur,           ease: 'power2.out', clearProps: 'transform' });
  if (rightCard) gsap.to(rightCard, { opacity: 1, y: 0, duration: animDur, delay: cDur + step,     ease: 'power2.out', clearProps: 'transform' });
  if (configSec) gsap.to(configSec, { opacity: 1, y: 0, duration: animDur, delay: cDur + step * 2, ease: 'power2.out', clearProps: 'transform' });
  if (htmlSec)   gsap.to(htmlSec,   { opacity: 1, y: 0, duration: animDur, delay: cDur + step * 3, ease: 'power2.out', clearProps: 'transform' });
  // Hold playback: wait for last pop-in, then add content-scaled reading time
  var animFinishMs = (cDur + step * 3 + animDur) * 1000;
  var snippetEl = document.getElementById('s0-html');
  var htmlLen = snippetEl ? snippetEl.textContent.length : 0;
  var urlLen = (RUN_META.url || '').length;
  // Approximate readable chars: full URL + ~1/3 of snippet (rest is clipped)
  var readingMs = Math.max(2500, Math.min(10000, (urlLen + htmlLen / 3) * 8));
  setReadyAfter(animFinishMs + readingMs);
}function startPan(img) {
  var wrap = img.parentElement;
  if (!wrap || !wrap.classList.contains('img-pan-wrap')) return;
  var naturalH = img.naturalHeight * (wrap.offsetWidth / img.naturalWidth);
  var containerH = wrap.offsetHeight || 420;
  var diff = naturalH - containerH;
  if (diff > 20) {
    var dur = Math.min(12, Math.max(4, diff / 150));
    gsap.to(img, { y: -Math.round(diff), duration: dur, ease: 'power1.inOut', delay: 0.6 });
    setReadyAfter((0.6 + dur + 0.5) * 1000);
  }
}
function jumpToSlide(idx) {
  idx = Math.max(0, Math.min(SLIDE_COUNT - 1, idx));
  var changed = idx !== currentSlide;
  currentSlide = idx;
  gsap.to(document.getElementById('track'), { xPercent: -(idx * 100), duration: 0.45, ease: 'power2.inOut', overwrite: 'auto' });
  document.querySelectorAll('.pill').forEach(function(p) {
    p.classList.toggle('active', parseInt(p.getAttribute('data-slide')) === idx);
  });
  if (changed) {
    var slideEl = document.getElementById('slide-' + idx);
    if (slideEl) {
      slideEl.scrollTop = 0;
      if (idx === 0) {
        _newSlideEntryDelay = 0;
        animateSlide0Entry();
        return;
      }
      var blocks = Array.from(slideEl.querySelectorAll('.card, .track-row'));
      if (blocks.length === 0) blocks = Array.from(slideEl.children);
      var staggerStep = 0.07;
      var carouselDur = 0.45;
      var blocksDur = carouselDur + (blocks.length > 1 ? (blocks.length - 1) * staggerStep : 0) + 0.4;
      _newSlideEntryDelay = blocksDur + 0.1;
      setReadyAfter((blocksDur + 1.8) * 1000);
      gsap.timeline().from(blocks, { opacity: 0, y: 14, duration: 0.4, stagger: staggerStep, ease: 'power2.out', clearProps: 'all' }, carouselDur);
    } else {
      _newSlideEntryDelay = 0;
    }
  } else {
    _newSlideEntryDelay = 0;
  }
}

// ── Main render ───────────────────────────────────────────────────────────────

function renderStep(idx) {
  stepIdx = idx;
  var ev = EVENTS[idx];
  var state = deriveState(idx);
  var slide = phaseToSlide(ev.phase);
  jumpToSlide(slide);

  renderSlide1(state);
  renderSlide2(state);
  renderSlide3(state, ev);
  renderSlide4(state);
  if (RUN_META.hasFidelity) renderSlide5(state);

  // Header section count
  var hdrSec = document.getElementById('hdr-sections');
  if (hdrSec) hdrSec.textContent = state.sectionOrder.length || '\u2014';

  var ctr = document.getElementById('step-counter');
  if (ctr) ctr.textContent = (idx + 1) + ' / ' + EVENTS.length;
  var lbl = document.getElementById('step-label');
  if (lbl) lbl.textContent = ev.phase;
  var scr = document.getElementById('scrubber');
  if (scr) scr.value = idx;
}

// ── Playback engine ───────────────────────────────────────────────────────────

var stepIdx = 0, playing = false, loop = false, dwellMs = 1000, timerId = null;
var animateUntil = 0;
var _newSlideEntryDelay = 0;
var manualMode = true;
function setReadyAfter(ms) { animateUntil = Math.max(animateUntil, Date.now() + ms); }

function manualGoToSlide(slideIdx) {
  clearTimeout(timerId);
  playing = false;
  updatePlayBtn();
  // Find the last event whose phase maps to this slide
  var target = 0;
  for (var i = 0; i < EVENTS.length; i++) {
    if (phaseToSlide(EVENTS[i].phase) === slideIdx) target = i;
  }
  // Reset preprocess card positioning so it recalculates on re-entry
  _lastRenderedSlide1Count = -1;
  // On preprocess slide, fully reset section card visibility so they animate in again
  if (slideIdx === 1) {
    document.querySelectorAll('.sec-card').forEach(function(el) {
      el.classList.remove('visible');
      gsap.set(el, { opacity: 0, y: 6 });
    });
    document.querySelectorAll('.bbox').forEach(function(el) {
      gsap.set(el, { opacity: 0 });
    });
  }
  // Force jumpToSlide to see a slide change and trigger pop-in
  currentSlide = -1;
  renderStep(target);
}
function manualNextSlide() {
  manualGoToSlide(Math.min(SLIDE_COUNT - 1, currentSlide + 1));
}
function toggleManualMode() {
  manualMode = !manualMode;
  var btn = document.getElementById('manual-mode-btn');
  if (btn) { btn.textContent = manualMode ? 'Manual' : 'Auto'; btn.classList.toggle('active', manualMode); }
  if (manualMode && playing) { clearTimeout(timerId); playing = false; updatePlayBtn(); }
  // Switching to Auto does NOT auto-start — user must press ▶ explicitly
}

function step(delta) { clearTimeout(timerId); playing = false; updatePlayBtn(); renderStep(Math.max(0, Math.min(EVENTS.length - 1, stepIdx + delta))); }
function togglePlay() { playing = !playing; updatePlayBtn(); if (playing) tick(); }
function setSpeed(ms) { dwellMs = ms; document.querySelectorAll('.speed-btn').forEach(function(b) { b.classList.toggle('active', parseInt(b.getAttribute('data-dwell')) === ms); }); }
function toggleLoop() { loop = !loop; var btn = document.getElementById('loop-btn'); if (btn) btn.classList.toggle('active', loop); }
function onScrub(val) { clearTimeout(timerId); playing = false; updatePlayBtn(); renderStep(parseInt(val)); }
function updatePlayBtn() { var btn = document.getElementById('play-pause-btn'); if (btn) btn.innerHTML = playing ? '&#9646;&#9646;' : '&#9654;'; }
function tick() {
  if (!playing) return;
  if (Date.now() < animateUntil) { timerId = setTimeout(tick, 60); return; }
  var next = stepIdx + 1;
  if (next >= EVENTS.length) { if (loop) { next = 0; } else { playing = false; updatePlayBtn(); return; } }
  timerId = setTimeout(function() {
    renderStep(next);
    if (playing) tick();
  }, dwellMs);
}

renderStep(0);
if (!manualMode) {
  setTimeout(function() { playing = true; updatePlayBtn(); tick(); }, 400);
}`;
}
