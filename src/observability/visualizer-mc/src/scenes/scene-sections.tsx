/**
 * scene-sections.tsx
 *
 * Slide 4 — Section-by-section generation + correction loop.
 *
 * Layout (1920×1080):
 *   Header bar (72px)   – "sections" label + correction badge
 *   Row viewport (1008px, clips overflow) – scrollable section rows
 *     Each row: [src-thumb | slug/role + score bar | gen-thumb]
 *
 * Animation:
 *   1. Header fade-in
 *   2. Rows stagger in (slide-up + fade)
 *   3. First scoring pass: blue flash → score bar slides in → gen thumb
 *   4. Correction iterations: same per affected slug + container scroll
 */

import { makeScene2D, Img, Rect, Txt, Layout } from '@motion-canvas/2d';
import {
    createRef,
    all, sequence,
    waitFor,
    easeOutCubic, easeInOutCubic,
    tween,
} from '@motion-canvas/core';

import runData from '../data/run-data.json';
import { deriveState } from '../state';
import {
    BG_CARD, BG_BORDER,
    TXT_DIM, TXT_MID, TXT_WHITE,
    BLUE,
    scoreColor,
} from '../theme';

// ── Constants ─────────────────────────────────────────────────────────────────

const PLACEHOLDER = 'data:image/gif;base64,R0lGODlhAQABAIAAAAUEBAAAACwAAAAAAQABAAACAkQBADs=';

const CANVAS_W = 1920;
const CANVAS_H = 1080;
const HEADER_H = 72;
const VIEWPORT_H = CANVAS_H - HEADER_H;  // 1008
const ROW_H = 175;
const ROW_GAP = 8;
const ROW_STRIDE = ROW_H + ROW_GAP;      // 183
const THUMB_W = 280;
const THUMB_H = ROW_H - 16;
const COL_GAP = 20;
const BAR_W = 260;

const MAX_VISIBLE = Math.floor(VIEWPORT_H / ROW_STRIDE);

// ── Data ──────────────────────────────────────────────────────────────────────

const state = deriveState(runData.events as Parameters<typeof deriveState>[0]);
const sp = runData.meta.screenshotPaths as {
    source?: string;
    sections?: Record<string, string>;
} | null;

// ── Helper ────────────────────────────────────────────────────────────────────

function targetY(idx: number, total: number): number {
    const totalH = total * ROW_STRIDE;
    const rowCentreY = idx * ROW_STRIDE + ROW_H / 2 - totalH / 2;
    const maxOffset = Math.max(0, totalH - VIEWPORT_H) / 2;
    return Math.min(maxOffset, Math.max(-maxOffset, -rowCentreY));
}

// ── Scene ─────────────────────────────────────────────────────────────────────

export default makeScene2D(function* (view) {

    const slugs = state.sectionOrder;
    const nRows = slugs.length;

    if (nRows === 0) {
        yield* waitFor(2);
        return;
    }

    const rowRefs = slugs.map(() => createRef<Rect>());
    const genRefs = slugs.map(() => createRef<Img>());
    const barFillRefs = slugs.map(() => createRef<Rect>());
    const scoreTxtRefs = slugs.map(() => createRef<Txt>());
    const verdictRefs = slugs.map(() => createRef<Txt>());
    const containerRef = createRef<Layout>();
    const headerRef = createRef<Layout>();

    // ── Row nodes ─────────────────────────────────────────────────────────────

    const rowNodes = slugs.map((slug, i) => {
        const srcUrl = sp?.sections?.[slug] ?? null;
        const secInfo = state.sections[slug];

        return (
            <Rect
                ref={rowRefs[i]}
                width={CANVAS_W - 40}
                height={ROW_H}
                fill={BG_CARD}
                stroke={BG_BORDER}
                lineWidth={1}
                radius={8}
                clip
                opacity={0}
                y={12}
                layout
                direction="row"
                gap={COL_GAP}
                alignItems="center"
                paddingLeft={16}
                paddingRight={16}
            >
                {/* Source thumbnail */}
                <Rect width={THUMB_W} height={THUMB_H} radius={4} fill={BG_BORDER} clip>
                    <Img
                        src={srcUrl ?? PLACEHOLDER}
                        width={THUMB_W}
                        height={THUMB_H}
                    />
                </Rect>

                {/* Info column */}
                <Layout
                    direction="column"
                    gap={10}
                    alignItems="start"
                    grow={1}
                    height={ROW_H - 16}
                    justifyContent="center"
                >
                    <Layout direction="row" gap={12} alignItems="center">
                        <Txt
                            text={slug}
                            fontSize={18}
                            fill={TXT_WHITE}
                            fontFamily="system-ui, sans-serif"
                            fontWeight={600}
                        />
                        {secInfo?.role ? (
                            <Txt
                                text={secInfo.role}
                                fontSize={14}
                                fill={TXT_DIM}
                                fontFamily="system-ui, sans-serif"
                            />
                        ) : null}
                    </Layout>

                    {/* Score bar — clip + sliding fill */}
                    <Layout direction="column" gap={4} width={BAR_W}>
                        <Rect width={BAR_W} height={8} radius={4} fill={BG_BORDER} clip>
                            <Rect
                                ref={barFillRefs[i]}
                                width={BAR_W}
                                height={8}
                                radius={4}
                                fill="#f59e0b"
                                x={-BAR_W}
                            />
                        </Rect>
                        <Layout direction="row" gap={8} alignItems="center">
                            <Txt
                                ref={scoreTxtRefs[i]}
                                text="—"
                                fontSize={15}
                                fill={TXT_DIM}
                                fontFamily="system-ui, sans-serif"
                                fontWeight={600}
                            />
                            <Txt
                                ref={verdictRefs[i]}
                                text=""
                                fontSize={13}
                                fill={TXT_DIM}
                                fontFamily="system-ui, sans-serif"
                            />
                        </Layout>
                    </Layout>
                </Layout>

                {/* Gen thumbnail */}
                <Rect width={THUMB_W} height={THUMB_H} radius={4} fill={BG_BORDER} clip>
                    <Img
                        ref={genRefs[i]}
                        src={PLACEHOLDER}
                        width={THUMB_W}
                        height={THUMB_H}
                        opacity={0}
                    />
                </Rect>
            </Rect>
        );
    });

    // ── DOM ───────────────────────────────────────────────────────────────────

    view.add(
        <Layout direction="column" width={CANVAS_W} height={CANVAS_H} gap={0}>

            <Layout
                ref={headerRef}
                direction="row"
                gap={20}
                alignItems="center"
                width={CANVAS_W}
                height={HEADER_H}
                paddingLeft={32}
                paddingRight={32}
                opacity={0}
            >
                <Txt
                    text="sections"
                    fontSize={18}
                    fill={TXT_DIM}
                    fontFamily="system-ui, sans-serif"
                    fontWeight={600}
                    letterSpacing={2}
                />
                <Txt
                    text={`${nRows} section${nRows !== 1 ? 's' : ''}`}
                    fontSize={18}
                    fill={TXT_MID}
                    fontFamily="system-ui, sans-serif"
                />
                {state.corrections.length > 0 ? (
                    <Rect
                        fill="#1d3a5f"
                        stroke={BLUE}
                        lineWidth={1}
                        radius={6}
                        paddingLeft={12}
                        paddingRight={12}
                        paddingTop={4}
                        paddingBottom={4}
                    >
                        <Txt
                            text={`${state.corrections.length} correction pass${state.corrections.length !== 1 ? 'es' : ''}`}
                            fontSize={15}
                            fill={BLUE}
                            fontFamily="system-ui, sans-serif"
                        />
                    </Rect>
                ) : null}
            </Layout>

            <Rect width={CANVAS_W} height={VIEWPORT_H} clip>
                <Layout
                    ref={containerRef}
                    direction="column"
                    gap={ROW_GAP}
                    width={CANVAS_W}
                    alignItems="center"
                    paddingLeft={20}
                    paddingRight={20}
                >
                    {rowNodes}
                </Layout>
            </Rect>

        </Layout>,
    );

    // ── Animation ─────────────────────────────────────────────────────────────

    const REVEAL_STAGGER = nRows > 10 ? 0.06 : 0.09;
    const REVEAL_DUR = 0.22;
    const SCAN_HOLD = 0.35;

    yield* headerRef().opacity(1, 0.4, easeOutCubic);

    yield* sequence(
        REVEAL_STAGGER,
        ...slugs.map((_, i) =>
            all(
                rowRefs[i]().opacity(1, REVEAL_DUR, easeOutCubic),
                rowRefs[i]().y(0, REVEAL_DUR, easeOutCubic),
            ),
        ),
    );

    yield* waitFor(0.4);

    // ── Score-row helper ──────────────────────────────────────────────────────

    function* scoreRow(
        slug: string,
        score: number | null,
        verdict: string | null,
        genPath: string | null,
    ) {
        const i = slugs.indexOf(slug);
        if (i < 0) return;

        // Blue flash
        yield* rowRefs[i]().fill('#0c1e35', 0.12, easeOutCubic);
        yield* rowRefs[i]().stroke(BLUE, 0.08);
        yield* waitFor(SCAN_HOLD);
        yield* all(
            rowRefs[i]().fill(BG_CARD, 0.22, easeOutCubic),
            rowRefs[i]().stroke(BG_BORDER, 0.22),
        );

        if (score != null) {
            const targetX = -BAR_W + BAR_W * score;
            const colour = scoreColor(score);
            barFillRefs[i]().fill(colour);

            yield* all(
                tween(0.45, v => {
                    barFillRefs[i]().x(-BAR_W + (targetX + BAR_W) * easeOutCubic(v));
                }),
                (function* () {
                    yield* waitFor(0.1);
                    scoreTxtRefs[i]().text(score.toFixed(2));
                    scoreTxtRefs[i]().fill(colour);
                    verdictRefs[i]().text(verdict ?? '');
                    verdictRefs[i]().fill(colour);
                })(),
            );
        }

        if (genPath) {
            genRefs[i]().src(genPath);
            yield* genRefs[i]().opacity(1, 0.32, easeOutCubic);
        }
    }

    // ── Initial scoring pass ──────────────────────────────────────────────────

    const firstCorr = state.corrections[0] ?? null;
    const scoredSlugs = firstCorr
        ? slugs.filter(s => firstCorr.scores[s] != null)
        : slugs.filter(s => state.sections[s]?.score != null);

    if (scoredSlugs.length > 0) {
        const firstIdx = slugs.indexOf(scoredSlugs[0]);
        if (firstIdx >= 0 && nRows > MAX_VISIBLE) {
            yield* containerRef().y(targetY(firstIdx, nRows), 0.45, easeInOutCubic);
        }

        for (let k = 0; k < scoredSlugs.length; k++) {
            const slug = scoredSlugs[k];
            const scored = firstCorr?.scores[slug] ?? null;
            const score = scored?.score ?? state.sections[slug]?.score ?? null;
            const verdict = scored?.verdict ?? state.sections[slug]?.verdict ?? null;
            const genPath = scored?.genPath ?? state.sections[slug]?.genPath ?? null;

            yield* scoreRow(slug, score, verdict, genPath);

            const next = scoredSlugs[k + 1];
            if (next && nRows > MAX_VISIBLE) {
                const nIdx = slugs.indexOf(next);
                if (nIdx >= 0) yield* containerRef().y(targetY(nIdx, nRows), 0.30, easeInOutCubic);
            }
        }
    }

    yield* waitFor(0.5);

    // ── Correction iterations ─────────────────────────────────────────────────

    for (const corr of state.corrections.slice(1)) {
        if (corr.activeSlugs.length === 0) continue;

        yield* waitFor(0.5);

        const firstIdx = slugs.indexOf(corr.activeSlugs[0]);
        if (firstIdx >= 0 && nRows > MAX_VISIBLE) {
            yield* containerRef().y(targetY(firstIdx, nRows), 0.5, easeInOutCubic);
        }
        yield* waitFor(0.2);

        for (let k = 0; k < corr.activeSlugs.length; k++) {
            const slug = corr.activeSlugs[k];
            const scored = corr.scores[slug];

            yield* scoreRow(
                slug,
                scored?.score ?? null,
                scored?.verdict ?? null,
                scored?.genPath ?? null,
            );

            const next = corr.activeSlugs[k + 1];
            if (next && nRows > MAX_VISIBLE) {
                const nIdx = slugs.indexOf(next);
                if (nIdx >= 0) yield* containerRef().y(targetY(nIdx, nRows), 0.30, easeInOutCubic);
            }
        }
    }

    // Scroll back for overview
    if (nRows > MAX_VISIBLE) {
        yield* waitFor(0.5);
        yield* containerRef().y(0, 0.8, easeInOutCubic);
    }

    yield* waitFor(1.5);
});
