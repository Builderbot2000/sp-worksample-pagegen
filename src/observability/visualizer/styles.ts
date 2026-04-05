export const vizStyles = `
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0d1117;color:#e5e7eb;height:100vh;overflow:hidden;display:flex;flex-direction:column}

    /* ── Header ── */
    .hdr{flex-shrink:0;padding:0.55rem 1.25rem;background:#161b22;border-bottom:1px solid #21262d;display:flex;align-items:center;gap:1rem;flex-wrap:nowrap;min-height:0}
    .hdr-title{font-size:0.875rem;font-weight:700;color:#f9fafb;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:28vw}
    .hdr-url{font-size:0.72rem;color:#60a5fa;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:22vw}
    .hdr-stat{font-size:0.7rem;color:#6b7280;white-space:nowrap}
    .hdr-stat span{color:#d1d5db;font-weight:600}
    .hdr-score{font-size:1rem;font-weight:700;margin-left:auto;white-space:nowrap}

    /* ── Stage pill nav ── */
    .pills{flex-shrink:0;display:flex;align-items:center;gap:0.3rem;padding:0.45rem 1.25rem;background:#161b22;border-bottom:1px solid #21262d;overflow-x:auto}
    .next-slide-btn{margin-left:auto;flex-shrink:0;font-size:0.72rem;padding:0.25rem 0.75rem;background:#1d4ed8;border-color:#3b82f6;color:#fff}
    .next-slide-btn:hover{background:#2563eb}
    .pill{background:transparent;border:1px solid #30363d;color:#6b7280;border-radius:999px;padding:0.2rem 0.7rem;font-size:0.68rem;font-weight:600;cursor:pointer;white-space:nowrap;transition:background 0.12s,color 0.12s,border-color 0.12s}
    .pill:hover{background:#21262d;color:#d1d5db}
    .pill.active{background:#1d4ed8;border-color:#3b82f6;color:#fff}

    /* ── Carousel ── */
    .carousel-outer{flex:1;overflow:hidden;position:relative}
    .carousel-track{display:flex;height:100%}
    .slide{flex:0 0 100%;height:100%;overflow-y:auto;padding:1.25rem;display:flex;gap:1rem;align-items:flex-start}
    .slide.slide-center{justify-content:center}

    /* ── Generic card ── */
    .card{background:#161b22;border:1px solid #21262d;border-radius:8px;padding:0.9rem;min-width:0}
    .card-lbl{font-size:0.6rem;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:0.07em;margin-bottom:0.5rem}
    .kv{display:grid;grid-template-columns:auto 1fr;gap:0.2rem 0.7rem;font-size:0.78rem}
    .kk{color:#6b7280;white-space:nowrap}
    .kv_val{color:#d1d5db;font-family:monospace;word-break:break-all}
    img.ss{width:100%;border-radius:5px;display:block;border:1px solid #21262d}
    .score-big{font-size:2.2rem;font-weight:700;line-height:1}
    .bar-track{height:6px;background:#21262d;border-radius:3px;overflow:hidden;margin-top:0.4rem}
    .bar-fill{height:100%;border-radius:3px}
    .chip{display:inline-block;padding:0.1rem 0.4rem;border-radius:999px;font-size:0.62rem;font-weight:600}

    /* ── Slide 0: Start ── */
    #slide-0{align-items:stretch;justify-content:center}
    .start-left{flex:1;min-width:0;max-width:600px;display:flex;flex-direction:column}
    .start-right{flex:1;min-width:0;max-width:600px;display:flex;flex-direction:column;overflow:hidden;height:100%}
    #s0-pan-wrap{flex:1;max-height:none;min-height:0}
    .start-url{font-size:1.3rem;font-weight:700;color:#60a5fa;word-break:break-all;line-height:1.3}
    .html-snippet{background:#0d1117;border:1px solid #21262d;border-radius:5px;padding:0.6rem;font-family:monospace;font-size:0.65rem;color:#9ca3af;overflow:hidden;flex:1 1 0;min-height:0;white-space:pre-wrap;word-break:break-all;align-self:stretch}
    #s0-html-section{flex:1 1 0;display:flex;flex-direction:column;min-height:0}
    #s0-config-section .chip{font-size:0.82rem;padding:0.25rem 0.65rem}
    .config-chips{display:flex;flex-wrap:wrap;gap:0.35rem;margin-top:0.25rem}

    /* ── Slide 1: Preprocess ── */
    #slide-1{justify-content:center}
    .pp-left{flex:0 0 42%;max-width:540px;position:relative}
    .pp-img-wrap{position:relative;width:100%;overflow:hidden}
    .pp-img-wrap img{position:absolute;top:0;left:0;width:100%;height:100%;display:block;border-radius:5px;border:1px solid #21262d;object-fit:fill}
    .bbox{position:absolute;left:0;right:0;border:2px solid;border-radius:2px;pointer-events:none;opacity:0}
    .bbox-label{position:absolute;top:2px;left:4px;font-size:0.55rem;font-weight:700;padding:0.05rem 0.3rem;border-radius:999px;color:#fff}
    .pp-right{flex:1;min-width:0;max-width:460px}
    .sec-list{position:relative}
    .sec-card{display:flex;gap:0.6rem;background:#0d1117;border:1px solid #21262d;border-radius:6px;padding:0.55rem;opacity:0;transform:translateY(6px);position:absolute;left:0;right:0}
    .sec-thumb{flex:0 0 70px}
    .sec-thumb img{width:70px;border-radius:3px;border:1px solid #21262d;display:block}
    .sec-meta{flex:1;min-width:0}
    .sec-meta .slug{font-size:0.72rem;font-weight:700;color:#e5e7eb}
    .sec-meta .role{font-size:0.62rem;color:#6b7280;margin-top:0.1rem}
    .sec-meta .desc{font-size:0.65rem;color:#9ca3af;margin-top:0.2rem;line-height:1.4}

    /* ── Slide 2: Skeleton ── */
    #slide-2{justify-content:center;align-items:stretch}
    .skel-left{flex:0 0 42%;max-width:540px;min-width:0;display:flex;flex-direction:column;overflow:hidden}
    #skel-pan-wrap{flex:1;max-height:none !important}
    .skel-right{flex:1;min-width:0;max-width:520px;display:flex;flex-direction:column}
    .skel-html-code{flex:1;overflow-y:auto;font-family:monospace;font-size:0.6rem;color:#9ca3af;white-space:pre-wrap;word-break:break-all;background:#0d1117;border:1px solid #21262d;border-radius:5px;padding:0.6rem;min-height:0;margin:0}
    .shimmer{background:linear-gradient(90deg,#161b22 25%,#21262d 50%,#161b22 75%);background-size:200% 100%;animation:shimmer 1.5s infinite}
    @keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}
    .skel-placeholder{height:500px;border-radius:6px;margin-bottom:0.6rem}
    .skel-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:0.5rem}
    .stat-tile{background:#0d1117;border:1px solid #21262d;border-radius:6px;padding:0.6rem;text-align:center}
    .stat-tile .val{font-size:1.1rem;font-weight:700;color:#f9fafb}
    .stat-tile .lbl{font-size:0.58rem;color:#6b7280;text-transform:uppercase;margin-top:0.15rem}

    /* ── Slide 3: Sections & Correction ── */
    .tracks-container{max-width:1100px;width:100%;margin:0 auto;display:flex;flex-direction:column;gap:0.55rem}
    .track-row{background:#161b22;border:1px solid #21262d;border-radius:7px;padding:0.5rem 0.6rem}
    .track-header{display:flex;align-items:center;gap:0.45rem;margin-bottom:0.4rem}
    .track-num{font-size:0.72rem;font-weight:700;color:#9ca3af;min-width:2.5rem}
    .track-role{font-size:0.6rem;background:#21262d;color:#9ca3af;border-radius:999px;padding:0.1rem 0.4rem}
    .track-score-badge{font-size:0.62rem;font-weight:700;border-radius:999px;padding:0.1rem 0.45rem;margin-left:auto}
    .track-desc{font-size:0.6rem;color:#6b7280;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .track-timeline{display:flex;gap:0.45rem;overflow-x:auto;padding-bottom:0.2rem;scrollbar-width:thin;scrollbar-color:#30363d transparent}
    .tl-cell{flex:0 0 160px;border-radius:5px;overflow:hidden;border:2px solid #21262d;transition:border-color 0.2s;display:flex;flex-direction:column}
    .tl-cell.active-cell{border-color:#3b82f6;box-shadow:0 0 0 2px #3b82f620}
    .tl-cell.grad-cell{border-color:#22c55e;box-shadow:0 0 0 2px #22c55e20}
    .tl-cell-img{position:relative;flex-shrink:0}
    .tl-cell img{width:100%;display:block;height:110px;object-fit:cover}
    .tl-cell .tl-no-img{width:160px;height:110px;display:flex;align-items:center;justify-content:center;font-size:0.6rem;color:#4b5563;background:#0d1117}
    .tl-overlay{position:absolute;bottom:0;left:0;right:0;padding:0.15rem 0.3rem;font-size:0.55rem;font-weight:700;color:#fff;display:flex;align-items:center;justify-content:space-between;background:linear-gradient(transparent,#00000099)}
    .tl-verdict{font-size:0.48rem;font-weight:600;border-radius:999px;padding:0.05rem 0.3rem;margin-left:0.2rem;opacity:0.9}
    .tl-label{position:absolute;top:2px;left:3px;font-size:0.5rem;color:#9ca3af;background:#00000060;padding:0.05rem 0.2rem;border-radius:2px}
    .tl-issues{padding:0.25rem 0.35rem;font-size:0.5rem;color:#9ca3af;line-height:1.35;background:#0d1117;border-top:1px solid #21262d;overflow:hidden;display:-webkit-box;-webkit-line-clamp:5;-webkit-box-orient:vertical}
    .tl-pending{width:160px;height:110px;display:flex;align-items:center;justify-content:center;font-size:1.2rem;color:#374151;background:#0d1117;border-radius:3px}
    .track-row[data-status=idle]{opacity:0.4}
    .track-row[data-status=active]{border-color:#1e3a5f}
    .track-row[data-status=complete]{border-color:#14532d30}

    /* ── Slide 4: Assembly ── */
    #slide-4{justify-content:center}
    .asm-left{flex:1;min-width:0;max-width:560px}
    .asm-right{flex:1;min-width:0;max-width:560px}
    .fly-chips{display:flex;flex-wrap:wrap;gap:0.35rem;min-height:120px}
    .fly-chip{padding:0.2rem 0.55rem;border-radius:999px;font-size:0.65rem;font-weight:600;opacity:0}
    .two-up{display:grid;grid-template-columns:1fr 1fr;gap:0.7rem}
    .two-up-lbl{font-size:0.6rem;font-weight:600;text-transform:uppercase;color:#6b7280;margin-bottom:0.3rem}
    .summary-tiles{display:grid;grid-template-columns:repeat(3,1fr);gap:0.5rem;margin-top:0.75rem}
    .sum-tile{background:#0d1117;border:1px solid #21262d;border-radius:7px;padding:0.7rem;text-align:center;opacity:0}
    .sum-tile .s-val{font-size:1.5rem;font-weight:700;color:#f9fafb}
    .sum-tile .s-lbl{font-size:0.58rem;color:#6b7280;text-transform:uppercase;margin-top:0.1rem}

    /* ── Slide 5: End ── */
    .fi-wrap{max-width:800px;width:100%;margin:0 auto}
    #slide-5{overflow:hidden;align-items:stretch}
    #slide-5 .fi-wrap{display:flex;flex-direction:column}
    #slide-5 .two-up{flex:1;min-height:0}
    #slide-5 .two-up>div{display:flex;flex-direction:column;min-height:0}
    #slide-5 .img-pan-wrap{flex:1;max-height:none;min-height:0}

    /* ── Entrance animation (used by GSAP) ── */

    /* ── Tall-image pan-down ── */
    .img-pan-wrap{width:100%;overflow:hidden;border-radius:5px;border:1px solid #21262d;max-height:420px}
    .img-pan-wrap img{width:100%;display:block}

    /* ── Track reference separator ── */
    .tl-sep{flex-shrink:0;width:2px;background:#30363d;border-radius:1px;align-self:stretch;margin:0 4px;min-height:80px}
    .tl-cell.tl-ref-style{border-color:#374151 !important}
    .tl-ref-label{position:absolute;top:2px;left:3px;font-size:0.5rem;font-weight:700;color:#60a5fa;background:#00000080;padding:0.05rem 0.25rem;border-radius:2px}

    /* ── Playback bar ── */
    .pb{flex-shrink:0;padding:0.55rem 1.25rem;background:#161b22;border-top:1px solid #21262d}
    .pb-top{display:flex;align-items:center;gap:0.5rem;margin-bottom:0.25rem}
    #scrubber{flex:1;cursor:pointer;accent-color:#3b82f6;height:4px}
    .cbtn{background:#21262d;border:1px solid #30363d;color:#d1d5db;border-radius:4px;padding:0.22rem 0.5rem;cursor:pointer;font-size:0.75rem;line-height:1}
    .cbtn:hover{background:#30363d}
    .cbtn.active{background:#1d4ed8;border-color:#3b82f6;color:#fff}
    .pb-bot{display:flex;align-items:center;gap:0.4rem;font-size:0.65rem;color:#6b7280}
    #step-counter{color:#9ca3af;font-variant-numeric:tabular-nums;min-width:7ch}
    #step-label{color:#60a5fa;font-weight:600;font-family:monospace;font-size:0.68rem}`;
