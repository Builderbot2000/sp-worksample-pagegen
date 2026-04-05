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

function scrollSlide3To(slug) {
  var slideEl = document.getElementById('slide-3');
  if (!slideEl) return;
  var rowEl = document.getElementById('sxar-' + slug);
  if (!rowEl) return;
  var slideRect = slideEl.getBoundingClientRect();
  var rowRect = rowEl.getBoundingClientRect();
  var midY = (rowRect.top + rowRect.bottom) / 2;
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
      var pairStagger = 1.2;
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
        var bboxCenterY = ((sec.y + sec.heightPx / 2) / pageH) * wrapH;
        var cardH = card.offsetHeight || 80;
        var idealTop = bboxCenterY - cardH / 2;
        var top = Math.max(idealTop, minTop);
        card.style.top = top + 'px';
        minTop = top + cardH + 8;
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
        // Slide HTML panel in after screenshot is showing
        var hc = document.getElementById('skel-html-card');
        if (hc) gsap.to(hc, { opacity: 1, x: 0, duration: 0.55, delay: 0.5, ease: 'power2.out', clearProps: 'transform' });
      };
    }
  } else {
    // No screenshot — show HTML panel immediately
    if (htmlCard) gsap.to(htmlCard, { opacity: 1, x: 0, duration: 0.55, ease: 'power2.out', clearProps: 'transform' });
  }
}

function animateSlide3Entry(state) {
  // Build trips: trip 0 = initial generation; trip k (k≥1) = correction iteration k-1
  var trips = [{ slugs: state.sectionOrder.slice(), isInitial: true, corrIdx: -1 }];
  state.corrections.forEach(function(corr, k) {
    trips.push({ slugs: (corr.activeSlugs || []).slice(), isInitial: false, corrIdx: k });
  });

  var initStagger  = 400;  // ms between rows on initial trip
  var corrStagger  = 250;  // ms between rows on correction trips
  var betweenTrips = 1000; // ms pause between trips

  // Compute absolute start time for each trip
  var t = 0;
  trips.forEach(function(trip, tripIdx) {
    trip.startT = t;
    t += trip.slugs.length * (trip.isInitial ? initStagger : corrStagger);
    if (tripIdx < trips.length - 1) t += betweenTrips;
  });

  setReadyAfter(t + 800);

  // Iter 1 scores represent the initial generation quality (scored before any corrections run)
  var initScores = (state.corrections.length > 0 && state.corrections[0].scores) ? state.corrections[0].scores : null;

  trips.forEach(function(trip) {
    var stagger = trip.isInitial ? initStagger : corrStagger;
    var corrObj = trip.corrIdx >= 0 ? state.corrections[trip.corrIdx] : null;
    var iterLabel = corrObj ? ('Iter ' + corrObj.iter) : null;

    trip.slugs.forEach(function(slug, i) {
      var absDelay = trip.startT + i * stagger;

      // Pre-scroll: center this row just before the scan arrives
      setTimeout(function() { scrollSlide3To(slug); }, Math.max(0, absDelay - 220));

      setTimeout(function() {
        var rowEl = document.getElementById('sxar-' + slug);
        if (!rowEl) return;
        var genCell = document.getElementById('sxag-' + slug);

        if (trip.isInitial) {
          // Fade the whole row in as a pair (ref + gen)
          gsap.fromTo(rowEl, { opacity: 0, y: 6 }, { opacity: 1, y: 0, duration: 0.3, ease: 'power2.out', clearProps: 'transform' });

          // Hydrate gen cell from iter-1 scores (initial gen quality snapshot)
          if (genCell && initScores) {
            var sd = initScores[slug];
            if (sd) {
              var clr0 = scoreColor(sd.score);
              genCell.style.setProperty('--fc-border', clr0);
              var dot0 = genCell.querySelector('.fc-score-dot'); if (dot0) dot0.style.background = clr0;
              var vd0  = genCell.querySelector('.fc-verdict');   if (vd0)  { vd0.textContent = sd.verdict || ''; vd0.style.color = clr0; }
              var sv0  = genCell.querySelector('.fc-score-val'); if (sv0)  { sv0.textContent = sd.score.toFixed(2); sv0.style.color = clr0; }
              if (sd.genPath) {
                var sh0 = genCell.querySelector('.sec-shimmer');
                if (sh0) {
                  var src0 = sd.genPath;
                  sh0.outerHTML = '<img src="' + esc(src0) + '" style="opacity:0" />';
                  var img0 = genCell.querySelector('img');
                  if (img0) gsap.to(img0, { opacity: 1, duration: 0.3 });
                }
              }
              genCell.classList.add('locked');
            }
          }
        }

        // Scan border sweep on every trip
        rowEl.classList.remove('scanning');
        void rowEl.offsetWidth;
        rowEl.classList.add('scanning');

        // Correction trips: fade-replace gen cell content with this iteration's data
        if (!trip.isInitial && corrObj && genCell) {
          var scoreData = corrObj.scores ? corrObj.scores[slug] : null;
          if (!scoreData) return;

          var clr = scoreColor(scoreData.score);
          genCell.style.setProperty('--fc-border', clr);
          var dot = genCell.querySelector('.fc-score-dot'); if (dot) dot.style.background = clr;
          var vd  = genCell.querySelector('.fc-verdict');   if (vd)  { vd.textContent = scoreData.verdict || ''; vd.style.color = clr; }
          var sv  = genCell.querySelector('.fc-score-val'); if (sv)  { sv.textContent = scoreData.score.toFixed(2); sv.style.color = clr; }

          if (scoreData.genPath) {
            var existImg = genCell.querySelector('img');
            if (existImg) {
              var newPath = scoreData.genPath;
              gsap.to(existImg, { opacity: 0, duration: 0.18, onComplete: function() {
                existImg.src = newPath;
                gsap.to(existImg, { opacity: 1, duration: 0.3 });
              }});
            } else {
              var sh = genCell.querySelector('.sec-shimmer');
              if (sh) {
                var newSrc = scoreData.genPath;
                gsap.to(sh, { opacity: 0, duration: 0.18, onComplete: function() {
                  sh.outerHTML = '<img src="' + esc(newSrc) + '" style="opacity:0" />';
                  var newImg = genCell.querySelector('img');
                  if (newImg) gsap.to(newImg, { opacity: 1, duration: 0.3 });
                }});
              }
            }
          }

          genCell.classList.add('locked');
          genCell.classList.remove('flashing');
          void genCell.offsetWidth;
          genCell.classList.add('flashing');
          setTimeout(function() { genCell.classList.remove('flashing'); }, 500);
        }

        // Show iteration label badge on correction trips
        if (iterLabel && genCell) {
          var badge = genCell.querySelector('.iter-badge');
          if (badge) { badge.textContent = iterLabel; badge.style.display = ''; }
        }
      }, absDelay);
    });
  });
}

function renderSlide3(state, ev) {
  var phase = ev ? ev.phase : '';
  var evData = ev ? (ev.data || {}) : {};

  // Pill-nav entry: scan each row sequentially
  if (_slide3EntryPending) {
    _slide3EntryPending = false;
    animateSlide3Entry(state);
    return;
  }

  // Pop row in on section:start (normal playthrough)
  if (phase === 'section:start') {
    var rowEl = document.getElementById('sxar-' + evData.slug);
    if (rowEl) gsap.fromTo(rowEl, { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: 0.3, ease: 'power2.out', clearProps: 'transform' });
    return;
  }

  // ── Hydrate all accumulated gen state into DOM (safe to re-run) ──
  var toReveal = [];
  state.sectionOrder.forEach(function(slug) {
    var sec = state.sections[slug];
    if (!sec) return;
    var rowEl = document.getElementById('sxar-' + slug);
    if (rowEl && rowEl.style.opacity === '0') toReveal.push(rowEl);
    var genCell = document.getElementById('sxag-' + slug);
    if (!genCell) return;
    if (sec.genPath) {
      var existImg = genCell.querySelector('img');
      if (existImg) { existImg.src = sec.genPath; }
      else { var sh = genCell.querySelector('.sec-shimmer'); if (sh) sh.outerHTML = '<img src="' + esc(sec.genPath) + '" />'; }
    }
    if (sec.score !== null) {
      var clr = scoreColor(sec.score);
      genCell.style.setProperty('--fc-border', clr);
      var dot = genCell.querySelector('.fc-score-dot'); if (dot) dot.style.background = clr;
      var vd = genCell.querySelector('.fc-verdict'); if (vd) { vd.textContent = sec.verdict || ''; vd.style.color = clr; }
      var sv = genCell.querySelector('.fc-score-val'); if (sv) { sv.textContent = sec.score.toFixed(2); sv.style.color = clr; }
    }
    if (state.assemble.status === 'complete' && phase !== 'assemble:complete') {
      genCell.classList.add('locked');
    }
  });
  if (toReveal.length > 0) {
    gsap.fromTo(toReveal, { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: 0.3, stagger: 0.05, ease: 'power2.out', clearProps: 'transform' });
  }
  // ─────────────────────────────────────────────────────

  // Flash gen cell + update image on score event
  if (phase === 'section-score' || phase === 'section-correction:complete') {
    var slug = evData.slug;
    var score = evData.score;
    var verdict = evData.verdict || '';
    var genPathNew = evData.generatedScreenshotPath || null;
    var clr = scoreColor(score);
    var genCell = document.getElementById('sxag-' + slug);
    if (genCell) {
      genCell.style.setProperty('--fc-border', clr);
      if (genPathNew) {
        var existImg = genCell.querySelector('img');
        if (existImg) { existImg.src = genPathNew; }
        else { var sh = genCell.querySelector('.sec-shimmer'); if (sh) sh.outerHTML = '<img src="' + esc(genPathNew) + '" />'; }
      }
      var dot = genCell.querySelector('.fc-score-dot'); if (dot) dot.style.background = clr;
      var vd = genCell.querySelector('.fc-verdict'); if (vd) { vd.textContent = verdict; vd.style.color = clr; }
      var sv = genCell.querySelector('.fc-score-val'); if (sv) { sv.textContent = score.toFixed(2); sv.style.color = clr; }
      genCell.classList.remove('flashing');
      void genCell.offsetWidth;
      genCell.classList.add('flashing');
      setTimeout(function() { genCell.classList.remove('flashing'); }, 500);
    }
  }

  // On assemble:complete: stagger lock gen cells with colored top-border accent
  if (phase === 'assemble:complete') {
    var slugs = state.sectionOrder.slice();
    setReadyAfter(slugs.length * 80 + 600);
    slugs.forEach(function(slug, idx) {
      setTimeout(function() {
        var genCell = document.getElementById('sxag-' + slug);
        if (!genCell || genCell.classList.contains('locked')) return;
        genCell.classList.add('locked');
        gsap.fromTo(genCell, { opacity: 0.55 }, { opacity: 1, duration: 0.3, ease: 'power2.out' });
      }, idx * 80);
    });
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
    }
  }
  if (sp && sp.fidelityMain) {
    var genImg = document.getElementById('fi-img');
    if (genImg && !genImg.getAttribute('src')) {
      genImg.src = sp.fidelityMain; genImg.style.display = '';
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
}function animateSlide4Entry() {
  var twoUp = document.querySelector('#slide-4 .two-up');
  if (!twoUp) return;
  var left = twoUp.children[0], right = twoUp.children[1];
  var scoreRow = document.getElementById('fi-score-row');
  var barRow = document.querySelector('#slide-4 .bar-track');
  var stats = document.getElementById('fi-stats');
  var carouselDur = 0.45, step = 0.2, dur = 0.4;
  [left, right, scoreRow, barRow, stats].forEach(function(el) { if (el) gsap.set(el, { opacity: 0, y: 12 }); });
  if (left) gsap.to(left, { opacity: 1, y: 0, duration: dur, delay: carouselDur, ease: 'power2.out', clearProps: 'transform' });
  if (right) gsap.to(right, { opacity: 1, y: 0, duration: dur, delay: carouselDur + step, ease: 'power2.out', clearProps: 'transform' });
  var statsDelay = carouselDur + step * 2;
  [scoreRow, barRow, stats].forEach(function(el) { if (el) gsap.to(el, { opacity: 1, y: 0, duration: dur, delay: statsDelay, ease: 'power2.out', clearProps: 'transform' }); });
  setReadyAfter((statsDelay + dur + 1.5) * 1000);
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
      // Slide 3 & 4 manage their own entrance animations
      if (idx === 3) {
        _newSlideEntryDelay = 0;
        return;
      }
      if (idx === 4) {
        _newSlideEntryDelay = 0;
        if (RUN_META.hasFidelity && idx === SLIDE_COUNT - 1) animateSlide4Entry();
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
var _slide3EntryPending = false;
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
  if (slideIdx === 3) {
    // Hide all rows and reset gen cells — scan will fade each row in as a pair
    document.querySelectorAll('.sxa-row').forEach(function(el) {
      gsap.set(el, { opacity: 0, y: 6 });
    });
    document.querySelectorAll('.sxa-row-gen').forEach(function(cell) {
      cell.classList.remove('locked', 'flashing', 'scanning');
      cell.style.removeProperty('--fc-border');
      var img = cell.querySelector('img');
      if (img) img.outerHTML = '<div class="sec-shimmer shimmer"></div>';
      var dot = cell.querySelector('.fc-score-dot'); if (dot) dot.style.background = '';
      var vd = cell.querySelector('.fc-verdict'); if (vd) vd.textContent = '';
      var sv = cell.querySelector('.fc-score-val'); if (sv) sv.textContent = '';
      var badge = cell.querySelector('.iter-badge'); if (badge) { badge.style.display = 'none'; badge.textContent = ''; }
    });
    _slide3EntryPending = true;
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
