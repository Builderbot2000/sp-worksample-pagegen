/**
 * scene-main.tsx — Single continuous video for the Motion Canvas visualizer.
 *
 * All five sequences (Start, Preprocess, Skeleton, Sections/Correction, Ending)
 * play in one unbroken scene.  A `world` Node acts as the virtual camera —
 * its `position` and `scale` are tweened to pan and zoom.  The navbar is a
 * fixed overlay placed directly on `view` so it never moves.
 *
 * World-space layout:
 *   Source pair:      x ∈ [-960, 960],  y ∈ [0, SRC_IMG_H]
 *   Gen containers:   x ≈ 1600,          y per-section (bbox centre)
 *   Skeleton pair:    x ∈ [1920, 3840],  y ∈ [SKEL_TOP_Y, SKEL_TOP_Y+1080]
 *
 * Camera formula: to show world point (wx, wy) at screen centre at scale s:
 *   world.position([-wx*s, -wy*s])   world.scale(s)
 */

import { makeScene2D, Img, Rect, Txt, Layout, Line, Node } from '@motion-canvas/2d';
import {
    createRef,
    all,
    sequence,
    waitFor,
    easeOutCubic,
    easeInOutCubic,
    linear,
} from '@motion-canvas/core';

import runData from '../data/run-data.json';
import { deriveState } from '../state';
import {
    BG_DARK, BG_CARD, BG_BORDER,
    TXT_WHITE, TXT_MID, TXT_DIM, BLUE,
    scoreColor,
} from '../theme';

// ── Data ──────────────────────────────────────────────────────────────────────

const sp = (runData.meta.screenshotPaths ?? {}) as {
    source?: string;
    sections?: Record<string, string>;
};
const state = deriveState(runData.events as Parameters<typeof deriveState>[0]);

const runStartEv = (runData.events as Array<{ phase: string; data?: Record<string, unknown> }>)
    .find(e => e.phase === 'run:start');
const qualityMode = (runStartEv?.data?.qualityMode as string | undefined) ?? null;
const correctionEnabled = !!(runStartEv?.data?.correctionEnabled);
const baselineEnabled = !!(runStartEv?.data?.baselineEnabled);

// ── World-space layout constants ──────────────────────────────────────────────

const COL_W = 960;                    // each column = half the 1920px canvas
const IMG_SCALE = COL_W / 1440;       // source pages are captured at 1440px width

const ppData = state.preprocess.data;
const sections = ppData?.sections ?? [];
const pageHeight = ppData?.pageHeight ?? 4000;
const SRC_IMG_H = pageHeight * IMG_SCALE;  // world-space height of source screenshot

// Source pair (left col = screenshot, right col = HTML/callouts)
const SRC_LEFT_CX = -480;   // centre x of source screenshot column
const SRC_RIGHT_CX = 480;   // centre x of HTML / callout column

// Generation containers — to the right of callouts
const GEN_CX = 1600;

// Skeleton pair — same height band, to the right of gen containers
// Layout: left col centred at 2400, right col at 3360, overall centre at 2880
const SKEL_LEFT_CX = 2400;
const SKEL_RIGHT_CX = 3360;
const SKEL_PAIR_CX = (SKEL_LEFT_CX + SKEL_RIGHT_CX) / 2;  // 2880

// Vertical centre of the skeleton pair (placed below the source region)
const SKEL_TOP_Y = Math.max(SRC_IMG_H + 400, 1600);
const SKEL_CY = SKEL_TOP_Y + 540;

// ── Role accent colours ───────────────────────────────────────────────────────

const ROLE_COLOR: Record<string, string> = {
    header: '#818cf8',
    hero: '#60a5fa',
    feature: '#34d399',
    content: '#a3e635',
    footer: '#f472b6',
    nav: '#fb923c',
    section: '#94a3b8',
};
function roleColor(role: string): string {
    return ROLE_COLOR[role.toLowerCase()] ?? '#94a3b8';
}

// ── Scene ─────────────────────────────────────────────────────────────────────

export default makeScene2D(function* (view) {
    view.fill(BG_DARK);

    const sourceUrl = typeof sp?.source === 'string' ? sp.source : null;
    const metaEx = runData.meta as Record<string, unknown>;
    const skeletonUrl = (metaEx.skeletonScreenshotPath as string | null | undefined) ?? null;
    const skeletonHtml = (metaEx.skeletonHtml as string | null | undefined) ?? null;
    const generatedHtml = (metaEx.generatedHtml as string | null | undefined) ?? null;
    const htmlSnippet = ppData?.htmlSnippet ?? null;

    // ── Refs ────────────────────────────────────────────────────────────────────

    const worldRef = createRef<Node>();
    const navbarRef = createRef<Rect>();

    const srcImgRef = createRef<Img>();
    const srcHtmlColRef = createRef<Rect>();
    const srcHtmlTxtRef = createRef<Txt>();

    // Per-section: bboxes, callouts, connector lines, arrows→gen, gen containers, score overlays
    const bboxRefs = sections.map(() => createRef<Rect>());
    const calloutRefs = sections.map(() => createRef<Layout>());
    const lineRefs = sections.map(() => createRef<Line>());
    const calloutArrowRefs = sections.map(() => createRef<Line>());
    const genRefs = sections.map(() => createRef<Rect>());
    const genBorderRefs = sections.map(() => createRef<Rect>());
    const genScoreTxtRefs = sections.map(() => createRef<Txt>());
    const finalArrowRefs = sections.map(() => createRef<Line>());

    // Seq 3 bridge arrow
    const bridgeArrowRef = createRef<Line>();

    // Skeleton pair
    const skelPairRef = createRef<Layout>();
    const skelImgRef = createRef<Img>();
    const skelHtmlTxtRef = createRef<Txt>();

    // Correction scanner window
    const corrWindowRef = createRef<Rect>();

    // ── World-space node helpers ────────────────────────────────────────────────

    // Section geometry helpers
    function secTopY(i: number) { return sections[i].y * IMG_SCALE; }
    function secHeight(i: number) { return sections[i].heightPx * IMG_SCALE; }
    function secCentreY(i: number) { return secTopY(i) + secHeight(i) / 2; }

    // ── Build per-section nodes ─────────────────────────────────────────────────

    const bboxNodes = sections.map((sec, i) => {
        const colour = roleColor(sec.role);
        return (
            <Rect
                ref={bboxRefs[i]}
                x={SRC_LEFT_CX}
                y={secCentreY(i)}
                width={COL_W - 8}
                height={secHeight(i)}
                stroke={colour}
                lineWidth={2}
                radius={3}
                fill={`${colour}18`}
                opacity={0}
            />
        );
    });

    const calloutNodes = sections.map((sec, i) => {
        const colour = roleColor(sec.role);
        return (
            <Layout
                ref={calloutRefs[i]}
                x={SRC_RIGHT_CX + 80}
                y={secCentreY(i)}
                direction="column"
                gap={4}
                opacity={0}
            >
                <Txt text={sec.slug} fontSize={22} fill={colour} fontFamily="system-ui, sans-serif" fontWeight={700} />
                <Txt text={sec.role} fontSize={16} fill={TXT_MID} fontFamily="system-ui, sans-serif" />
                {sec.description ? (
                    <Txt
                        text={sec.description.slice(0, 60)}
                        fontSize={14}
                        fill={TXT_DIM}
                        fontFamily="system-ui, sans-serif"
                        maxWidth={380}
                    />
                ) : null}
            </Layout>
        );
    });

    // Connector line from right edge of left col to callout left edge
    const lineNodes = sections.map((sec, i) => {
        const colour = roleColor(sec.role);
        const fromX = SRC_LEFT_CX + COL_W / 2 + 4;
        const toX = SRC_RIGHT_CX + 80 - 20;
        const y = secCentreY(i);
        return (
            <Line
                ref={lineRefs[i]}
                points={[[fromX, y], [toX, y]]}
                stroke={colour}
                lineWidth={1.5}
                opacity={0.6}
                end={0}
            />
        );
    });

    // Arrows from callouts to gen containers (Seq 4)
    const calloutArrowNodes = sections.map((_sec, i) => {
        const fromX = SRC_RIGHT_CX + 200;
        const toX = GEN_CX - COL_W / 2;
        const y = secCentreY(i);
        return (
            <Line
                ref={calloutArrowRefs[i]}
                points={[[fromX, y], [toX, y]]}
                stroke={BLUE}
                lineWidth={1.5}
                endArrow
                arrowSize={8}
                end={0}
                opacity={0.8}
            />
        );
    });

    // Generation containers
    const genNodes = sections.map((sec, i) => {
        const slug = sec.slug;
        const genUrl = sp?.sections?.[slug] ?? state.sections[slug]?.genPath ?? null;
        const h = secHeight(i);
        return (
            <Rect
                ref={genRefs[i]}
                x={GEN_CX}
                y={secCentreY(i)}
                width={COL_W}
                height={h}
                fill={BG_CARD}
                stroke={BG_BORDER}
                lineWidth={1}
                radius={4}
                opacity={0}
            >
                {genUrl ? (
                    <Img src={genUrl} width={COL_W} />
                ) : (
                    <Rect width={COL_W} height={h} fill={BG_BORDER} radius={4} />
                )}
                {/* Score border overlay */}
                <Rect
                    ref={genBorderRefs[i]}
                    width={COL_W}
                    height={h}
                    radius={4}
                    stroke={BG_BORDER}
                    lineWidth={2}
                    fill="rgba(0,0,0,0)"
                    opacity={0}
                />
                {/* Score label */}
                <Txt
                    ref={genScoreTxtRefs[i]}
                    text=""
                    fontSize={18}
                    fill={TXT_WHITE}
                    fontFamily="system-ui, sans-serif"
                    fontWeight={700}
                    x={-COL_W / 2 + 20}
                    y={-h / 2 + 20}
                    opacity={0}
                />
            </Rect>
        );
    });

    // Final arrows from gen containers toward skeleton (Seq 4 → Seq 5)
    const finalArrowNodes = sections.map((_sec, i) => {
        const fromX = GEN_CX + COL_W / 2;
        const y = secCentreY(i);
        return (
            <Line
                ref={finalArrowRefs[i]}
                points={[
                    [fromX, y],
                    [fromX + 300, y - 120],
                    [SKEL_LEFT_CX - 80, SKEL_CY],
                ]}
                stroke={BLUE}
                lineWidth={1.5}
                endArrow
                arrowSize={8}
                end={0}
                opacity={0.8}
                radius={80}
            />
        );
    });

    // ── View tree ───────────────────────────────────────────────────────────────

    view.add(
        <>
            {/* ── World container (camera target) ─────────────────────────────── */}
            <Node
                ref={worldRef}
                position={[0, -540]}
                scale={1}
            >
                {/* Source screenshot (left col) */}
                {sourceUrl ? (
                    <Img
                        ref={srcImgRef}
                        src={sourceUrl}
                        width={COL_W}
                        x={SRC_LEFT_CX}
                        y={SRC_IMG_H / 2}
                        opacity={0}
                    />
                ) : (
                    <Rect
                        x={SRC_LEFT_CX}
                        y={SRC_IMG_H / 2}
                        width={COL_W}
                        height={SRC_IMG_H}
                        fill={BG_CARD}
                    />
                )}

                {/* Source HTML panel (right col — Seq 1 only) */}
                <Rect
                    ref={srcHtmlColRef}
                    x={SRC_RIGHT_CX}
                    y={SRC_IMG_H / 2}
                    width={COL_W}
                    height={SRC_IMG_H}
                    fill={BG_CARD}
                    stroke={BG_BORDER}
                    lineWidth={1}
                    clip
                    opacity={0}
                >
                    {htmlSnippet ? (
                        <Txt
                            ref={srcHtmlTxtRef}
                            text={htmlSnippet.slice(0, 4000)}
                            fontSize={13}
                            fill="#9ca3af"
                            fontFamily="'Courier New', monospace"
                            width={880}
                            y={-SRC_IMG_H / 2 + 40}
                        />
                    ) : null}
                </Rect>

                {/* Section bboxes (Seq 2) */}
                {...bboxNodes}

                {/* Section callouts (Seq 2) */}
                {...calloutNodes}

                {/* Connector lines callout ↔ bbox (Seq 2) */}
                {...lineNodes}

                {/* Arrows callout → gen container (Seq 4) */}
                {...calloutArrowNodes}

                {/* Gen containers (Seq 4) */}
                {...genNodes}

                {/* Final arrows gen → skeleton (Seq 4 outgoing / Seq 5 incoming) */}
                {...finalArrowNodes}

                {/* Bridge arrow source bottom → skeleton (Seq 3) */}
                <Line
                    ref={bridgeArrowRef}
                    points={[
                        [SRC_LEFT_CX, SRC_IMG_H],
                        [SRC_LEFT_CX + 500, SRC_IMG_H + 300],
                        [SKEL_LEFT_CX - 80, SKEL_CY],
                    ]}
                    stroke={BLUE}
                    lineWidth={2}
                    endArrow
                    arrowSize={10}
                    end={0}
                    radius={120}
                />

                {/* Skeleton pair (Seq 3+) */}
                <Layout
                    ref={skelPairRef}
                    x={SKEL_PAIR_CX}
                    y={SKEL_CY}
                    direction="row"
                    width={1920}
                    height={1080}
                    opacity={0}
                >
                    {/* Left: skeleton screenshot */}
                    <Rect width={960} height={1080} fill={BG_CARD} clip>
                        {skeletonUrl ? (
                            <Img ref={skelImgRef} src={skeletonUrl} width={960} />
                        ) : (
                            <Rect width={960} height={1080} fill={BG_CARD} />
                        )}
                    </Rect>
                    {/* Right: skeleton HTML */}
                    <Rect width={960} height={1080} fill={BG_CARD} stroke={BG_BORDER} lineWidth={1} clip>
                        <Txt
                            ref={skelHtmlTxtRef}
                            text={skeletonHtml ? skeletonHtml.slice(0, 6000) : '(no skeleton HTML)'}
                            fontSize={13}
                            fill="#a5f3fc"
                            fontFamily="'Courier New', monospace"
                            width={900}
                            y={-500}
                        />
                    </Rect>
                </Layout>

                {/* Correction scanner window (Seq 4) */}
                <Rect
                    ref={corrWindowRef}
                    x={GEN_CX}
                    y={0}
                    width={COL_W + 40}
                    height={120}
                    stroke={BLUE}
                    lineWidth={2}
                    radius={4}
                    fill="rgba(59,130,246,0.05)"
                    opacity={0}
                />
            </Node>

            {/* ── Navbar — fixed screen overlay ────────────────────────────────── */}
            <Rect
                ref={navbarRef}
                x={0}
                y={-540 + 36}
                width={1920}
                height={72}
                fill={BG_CARD}
                stroke={BG_BORDER}
                lineWidth={1}
                opacity={0}
                layout
                direction="row"
                gap={16}
                alignItems="center"
                paddingLeft={40}
                paddingRight={40}
            >
                <Txt
                    text={runData.meta.url}
                    fontSize={22}
                    fill={BLUE}
                    fontFamily="system-ui, sans-serif"
                    grow={1}
                />
                {qualityMode ? (
                    <Rect fill={BG_DARK} stroke={BG_BORDER} lineWidth={1} radius={6} paddingLeft={12} paddingRight={12} paddingTop={6} paddingBottom={6}>
                        <Txt text={qualityMode} fontSize={18} fill={TXT_MID} fontFamily="system-ui, sans-serif" />
                    </Rect>
                ) : null}
                {correctionEnabled ? (
                    <Rect fill={BG_DARK} stroke={BG_BORDER} lineWidth={1} radius={6} paddingLeft={12} paddingRight={12} paddingTop={6} paddingBottom={6}>
                        <Txt text="correction" fontSize={18} fill={TXT_MID} fontFamily="system-ui, sans-serif" />
                    </Rect>
                ) : null}
                {baselineEnabled ? (
                    <Rect fill={BG_DARK} stroke={BG_BORDER} lineWidth={1} radius={6} paddingLeft={12} paddingRight={12} paddingTop={6} paddingBottom={6}>
                        <Txt text="baseline" fontSize={18} fill={TXT_MID} fontFamily="system-ui, sans-serif" />
                    </Rect>
                ) : null}
            </Rect>
        </>,
    );

    // Helper: tween camera to world point (wx, wy) at scale s over dur seconds
    function camTo(wx: number, wy: number, s: number, dur: number) {
        return all(
            worldRef().position([-wx * s, -wy * s], dur, easeInOutCubic),
            worldRef().scale(s, dur, easeInOutCubic),
        );
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // ANIMATION
    // ═══════════════════════════════════════════════════════════════════════════

    // ── Navbar fade-in ──────────────────────────────────────────────────────────
    yield* navbarRef().opacity(1, 0.5, easeOutCubic);
    yield* waitFor(0.3);

    // ══════════════════════════════════════════════════════════════════════════
    // SEQ 1 — Start
    // Source screenshot (left) + HTML panel (right) appear simultaneously.
    // Camera scrolls down as they reveal, then scrolls back up to top.
    // ══════════════════════════════════════════════════════════════════════════

    const srcPanDur = Math.max(4, Math.min(SRC_IMG_H / 150, 14));
    const readPause = Math.max(1.5, Math.min(runData.meta.url.length * 0.015, 4));

    yield* all(
        ...(sourceUrl ? [srcImgRef().opacity(1, 0.6, easeOutCubic)] : []),
        srcHtmlColRef().opacity(1, 0.6, easeOutCubic),
    );
    yield* waitFor(0.4);

    // Camera scrolls down from y=540 (top) to y=SRC_IMG_H−540 (near bottom)
    const camBottomY = Math.max(540, SRC_IMG_H - 540);
    yield* camTo(0, camBottomY, 1, srcPanDur);

    // Brief pause at bottom
    yield* waitFor(readPause);

    // Camera scrolls back to top
    yield* camTo(0, 540, 1, srcPanDur * 0.7);
    yield* waitFor(0.4);

    // ══════════════════════════════════════════════════════════════════════════
    // SEQ 2 — Preprocess
    // HTML right col drops off screen. Bboxes + callouts appear per-section,
    // each after camera scrolls to that section.
    // ══════════════════════════════════════════════════════════════════════════

    if (sections.length > 0) {
        // Drop HTML col off the bottom
        yield* srcHtmlColRef().y(SRC_IMG_H / 2 + 1200, 0.6, easeInOutCubic);

        yield* waitFor(0.2);

        for (let i = 0; i < sections.length; i++) {
            const targetY = secCentreY(i);
            const h = secHeight(i);

            // Camera centres on this section
            yield* camTo(0, targetY, 1, 0.5);

            // Bbox grows downward (centre-anchored in MC, so we tween height from 0)
            bboxRefs[i]().height(0);
            bboxRefs[i]().opacity(1);
            yield* bboxRefs[i]().height(h, 0.35, easeOutCubic);

            // Callout slides in from left + connector line draws
            yield* waitFor(0.1);
            yield* all(
                calloutRefs[i]().opacity(1, 0.3, easeOutCubic),
                lineRefs[i]().end(1, 0.4, easeOutCubic),
            );

            yield* waitFor(0.15);
        }

        // Hold on last section
        yield* waitFor(0.6);
    } else {
        // No sections: just wait
        yield* waitFor(1.5);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // SEQ 3 — Skeleton
    // Camera zooms out to show source + skeleton region.
    // Bridge arrow draws from source bottom to skeleton pair.
    // Skeleton pair fades in L→R. Camera zooms in on skeleton. HTML scrolls.
    // Camera zooms back out.
    // ══════════════════════════════════════════════════════════════════════════

    // Zoom out to show both source and skeleton simultaneously
    const zoomOutS = Math.min(0.4, 1920 / (SKEL_RIGHT_CX + 960 + 200));
    const zoomOutCX = (SKEL_RIGHT_CX - SRC_LEFT_CX) / 4;
    const zoomOutCY = (SRC_IMG_H / 2 + SKEL_CY) / 2;
    yield* camTo(zoomOutCX, zoomOutCY, zoomOutS, 1.0);

    yield* waitFor(0.3);

    // Bridge arrow shoots from source bottom → skeleton pair
    yield* bridgeArrowRef().end(1, 1.2, easeInOutCubic);

    // Skeleton pair fades in L→R like a wipe: left half then right half
    yield* skelPairRef().opacity(1, 0.6, easeOutCubic);
    yield* waitFor(0.4);

    // Camera zooms in on skeleton pair (fills screen)
    yield* camTo(SKEL_PAIR_CX, SKEL_CY, 1, 1.0);
    yield* waitFor(0.4);

    // Skeleton HTML scrolls down
    const skelHtmlScrollDist = 600;
    yield* skelHtmlTxtRef().y(skelHtmlTxtRef().y() + skelHtmlScrollDist, 3.5, linear);

    yield* waitFor(0.4);

    // Camera zooms back out to wide view (keep source visible)
    yield* camTo(zoomOutCX, zoomOutCY, zoomOutS, 1.0);
    yield* waitFor(0.4);

    // ══════════════════════════════════════════════════════════════════════════
    // SEQ 4 — Sections & Correction
    // Camera refocuses on source + callouts + gen containers (~0.65× scale).
    // Arrows from callouts to gen containers. Correction window sweeps.
    // Final arrows from gen → skeleton.
    // ══════════════════════════════════════════════════════════════════════════

    if (sections.length > 0) {
        // Zoom to show source left col + callouts + gen containers
        const seq4Scale = 0.65;
        const seq4CX = (SRC_LEFT_CX + GEN_CX + COL_W / 2) / 2;  // midpoint
        const seq4CY = SRC_IMG_H / 2;
        yield* camTo(seq4CX, seq4CY, seq4Scale, 1.0);
        yield* waitFor(0.3);

        // All arrows from callouts → gen containers shoot simultaneously
        yield* all(
            ...calloutArrowRefs.map(r => r().end(1, 0.6, easeOutCubic)),
        );

        yield* waitFor(0.2);

        // Gen containers fade in
        yield* sequence(
            0.05,
            ...genRefs.map(r => r().opacity(1, 0.3, easeOutCubic)),
        );

        // ── Correction window ────────────────────────────────────────────────────

        if (state.corrections.length > 0) {
            yield* waitFor(0.4);

            // Start window above first section
            const firstSectionY = secCentreY(0);
            corrWindowRef().y(firstSectionY - secHeight(0) - 100);
            yield* corrWindowRef().opacity(1, 0.3, easeOutCubic);

            const passedSlugs = new Set<string>();

            for (const corr of state.corrections) {
                for (let i = 0; i < sections.length; i++) {
                    const slug = sections[i].slug;
                    if (passedSlugs.has(slug)) continue;

                    const targetY = secCentreY(i);
                    const h = Math.max(secHeight(i), 60);

                    // Resize and move correction window to this section
                    corrWindowRef().height(h + 16);
                    yield* corrWindowRef().y(targetY, 0.35, easeInOutCubic);
                    yield* waitFor(0.1);

                    // Apply score if available
                    const scoreData = corr.scores[slug];
                    if (scoreData != null) {
                        const colour = scoreColor(scoreData.score);

                        // Update border overlay
                        genBorderRefs[i]().stroke(colour);
                        genBorderRefs[i]().lineWidth(scoreData.score >= 0.85 ? 4 : 2);
                        yield* genBorderRefs[i]().opacity(1, 0.2, easeOutCubic);

                        // Score label
                        genScoreTxtRefs[i]().text(`${Math.round(scoreData.score * 100)}%`);
                        yield* genScoreTxtRefs[i]().opacity(1, 0.2, easeOutCubic);

                        if (scoreData.score >= 0.85) {
                            passedSlugs.add(slug);
                        }
                    }

                    yield* waitFor(0.1);
                }

                yield* waitFor(0.25);
            }

            // Fade window out
            yield* corrWindowRef().opacity(0, 0.4, easeOutCubic);
        }

        yield* waitFor(0.4);

        // Final arrows from gen containers → skeleton (all at once)
        yield* all(
            ...finalArrowRefs.map(r => r().end(1, 1.0, easeInOutCubic)),
        );

        yield* waitFor(0.3);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // SEQ 5 — Ending
    // Camera moves to skeleton pair. Both columns flash then cross-fade to
    // final generated content. HTML auto-scrolls. Video ends on held beat.
    // ══════════════════════════════════════════════════════════════════════════

    // Camera zooms in on skeleton pair
    yield* camTo(SKEL_PAIR_CX, SKEL_CY, 1, 0.9);
    yield* waitFor(0.3);

    // Flash — opacity pulse on skeleton pair
    yield* skelPairRef().opacity(0.2, 0.12);
    yield* skelPairRef().opacity(1, 0.25, easeOutCubic);

    // Cross-fade: update content (switch skeleton → generated output)
    if (skelImgRef() != null) {
        // Fade to generated page screenshot if available
        // (generatedHtmlPath is a /@fs URL pointing to an HTML file, not an image;
        //  for now we keep the skeleton screenshot as-is if no separate gen screenshot)
    }
    if (skelHtmlTxtRef() != null && generatedHtml != null) {
        yield* skelHtmlTxtRef().opacity(0, 0.25);
        skelHtmlTxtRef().text(generatedHtml.slice(0, 6000));
        skelHtmlTxtRef().fill('#a5f3fc');
        yield* skelHtmlTxtRef().opacity(1, 0.4, easeOutCubic);
    }

    yield* waitFor(0.4);

    // Generated HTML auto-scrolls down through its full content
    const genHtmlScrollDur = 4;
    yield* skelHtmlTxtRef().y(
        skelHtmlTxtRef().y() + 700,
        genHtmlScrollDur,
        linear,
    );

    // Hold on final frame
    yield* waitFor(2);
});
