/**
 * scene-start.tsx
 *
 * Slide 1 — Title card + source screenshot pan.
 *
 * Left half  → source screenshot, cropped, panning top→bottom
 * Right half → title, URL, config chips, run stats
 */

import { makeScene2D, Img, Rect, Txt, Layout } from '@motion-canvas/2d';
import {
    createRef,
    all,
    waitFor,
    easeOutCubic,
    easeInOutCubic,
    linear,
} from '@motion-canvas/core';

import runData from '../data/run-data.json';
import { deriveState } from '../state';
import { BG_CARD, BG_BORDER, TXT_WHITE, TXT_MID, TXT_DIM, BLUE } from '../theme';

const sp = (runData.meta.screenshotPaths ?? {}) as Record<string, unknown>;
const state = deriveState(runData.events as Parameters<typeof deriveState>[0]);

// Derive config from run:start event
const runStartEv = (runData.events as Array<{ phase: string; data?: Record<string, unknown> }>)
    .find(e => e.phase === 'run:start');
const qualityMode = (runStartEv?.data?.qualityMode as string | undefined) ?? null;
const correctionEnabled = !!(runStartEv?.data?.correctionEnabled);
const baselineEnabled = !!(runStartEv?.data?.baselineEnabled);

// ── Chip ─────────────────────────────────────────────────────────────────────

function chip(label: string) {
    return (
        <Rect
            fill={BG_CARD}
            stroke={BG_BORDER}
            lineWidth={1}
            radius={6}
            paddingLeft={14}
            paddingRight={14}
            paddingTop={8}
            paddingBottom={8}
        >
            <Txt text={label} fontSize={20} fill={TXT_MID} fontFamily="system-ui, sans-serif" />
        </Rect>
    );
}

// ── Stat row ─────────────────────────────────────────────────────────────────

function statRow(label: string, value: string) {
    return (
        <Layout direction="row" gap={12} alignItems="center">
            <Txt text={label} fontSize={20} fill={TXT_DIM} fontFamily="system-ui, sans-serif" width={120} />
            <Txt text={value} fontSize={20} fill={TXT_MID} fontFamily="system-ui, sans-serif" fontWeight={600} />
        </Layout>
    );
}

// ── Scene ─────────────────────────────────────────────────────────────────────

export default makeScene2D(function* (view) {

    const sourceUrl = typeof sp?.source === 'string' ? sp.source : null;

    const CLIP_W = 880;
    const CLIP_H = 1080;

    // Compute pan geometry from preprocess page height (assumes 1440px capture width)
    const pageH = state.preprocess.data?.pageHeight ?? 6000;
    const imgH = pageH * (CLIP_W / 1440);
    const diff = imgH - CLIP_H;
    const panDiff = diff > 20 ? diff : 0;
    const PAN_DUR = panDiff > 0 ? Math.max(4, Math.min(panDiff / 150, 12)) : 3.7;
    const startY = panDiff / 2;   // image top aligned with clip top
    const endY = -panDiff / 2;   // image bottom aligned with clip bottom

    const htmlSnippet = state.preprocess.data?.htmlSnippet ?? null;
    const readMs = Math.max(2500, Math.min(
        (runData.meta.url.length + (htmlSnippet?.length ?? 0) / 3) * 8,
        10000,
    ));

    const titleRef = createRef<Txt>();
    const urlRef = createRef<Txt>();
    const chipsRef = createRef<Layout>();
    const statsRef = createRef<Layout>();
    const divRef = createRef<Rect>();
    const panRef = createRef<Img>();
    const htmlRef = createRef<Layout>();
    const codeScrollRef = createRef<Txt>();

    const events = runData.events as Array<{ phase: string }>;

    view.add(
        <>
            {/* Left: screenshot pan */}
            <Rect x={-520} width={CLIP_W} height={CLIP_H} clip>
                {sourceUrl ? (
                    <Img
                        ref={panRef}
                        src={sourceUrl}
                        width={CLIP_W}
                        y={startY}
                        opacity={0}
                    />
                ) : (
                    <Rect width={CLIP_W} height={CLIP_H} fill={BG_CARD} />
                )}
            </Rect>

            {/* Right: text panel */}
            <Layout
                x={440}
                direction="column"
                gap={28}
                alignItems="start"
                width={760}
                padding={60}
            >
                <Txt
                    ref={titleRef}
                    text={runData.meta.name ?? runData.meta.runId}
                    fontSize={52}
                    fill={TXT_WHITE}
                    fontFamily="system-ui, sans-serif"
                    fontWeight={700}
                    opacity={0}
                    maxWidth={680}
                />

                <Txt
                    ref={urlRef}
                    text={runData.meta.url}
                    fontSize={24}
                    fill={BLUE}
                    fontFamily="system-ui, sans-serif"
                    opacity={0}
                />

                <Rect ref={divRef} width={320} height={1} fill={BG_BORDER} opacity={0} />

                <Layout ref={chipsRef} direction="row" gap={10} wrap="wrap" opacity={0}>
                    {qualityMode ? chip(qualityMode) : null}
                    {correctionEnabled ? chip('correction') : null}
                    {baselineEnabled ? chip('baseline') : null}
                </Layout>

                <Layout ref={statsRef} direction="column" gap={14} opacity={0}>
                    {statRow('sections', String(events.filter(e => e.phase === 'section:start').length))}
                    {statRow('corrections', String(events.filter(e => e.phase === 'correction-iter:start').length))}
                    {statRow(
                        'duration',
                        (() => {
                            const ms = runData.meta.completedAt - runData.meta.startedAt;
                            if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
                            return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
                        })(),
                    )}
                    {runData.meta.estimatedCostUsd
                        ? statRow('est. cost', `$${runData.meta.estimatedCostUsd.toFixed(3)}`)
                        : null}
                </Layout>

                {/* Source HTML panel */}
                <Layout ref={htmlRef} direction="column" gap={8} opacity={0}>
                    <Txt
                        text="SOURCE HTML"
                        fontSize={13}
                        fill={TXT_DIM}
                        fontFamily="system-ui, sans-serif"
                        fontWeight={600}
                        letterSpacing={2}
                    />
                    <Rect width={640} height={300} radius={6} fill={BG_CARD} stroke={BG_BORDER} lineWidth={1} clip>
                        {htmlSnippet ? (
                            <Txt
                                ref={codeScrollRef}
                                text={htmlSnippet.slice(0, 2000)}
                                fontSize={13}
                                fill="#9ca3af"
                                fontFamily="'Courier New', monospace"
                                width={600}
                                y={-200}
                            />
                        ) : null}
                    </Rect>
                </Layout>
            </Layout>
        </>,
    );

    // Four sequential beats, each 0.45s, 0.6s apart:
    //   beat 1 (0.45s) – screenshot
    //   beat 2 (1.05s) – URL + title panel
    //   beat 3 (1.65s) – config chips
    //   beat 4 (2.25s) – source HTML panel
    const BEAT = 0.45;

    if (sourceUrl) {
        yield* panRef().opacity(1, BEAT, easeOutCubic);
    } else {
        yield* waitFor(BEAT);
    }
    yield* waitFor(0.6 - BEAT); // pad so each beat starts 0.6s after the previous

    yield* all(
        titleRef().opacity(1, BEAT, easeOutCubic),
        urlRef().opacity(1, BEAT, easeOutCubic),
        divRef().opacity(1, BEAT, easeOutCubic),
    );
    yield* waitFor(0.6 - BEAT);

    yield* all(
        chipsRef().opacity(1, BEAT, easeOutCubic),
        statsRef().opacity(1, BEAT, easeOutCubic),
    );
    yield* waitFor(0.6 - BEAT);

    yield* htmlRef().opacity(1, BEAT, easeOutCubic);

    // Reading pause scaled to URL + snippet length
    yield* waitFor(readMs / 1000);

    // 6. Pan screenshot top→bottom + scroll code panel in parallel
    if (sourceUrl && panDiff > 0) {
        yield* all(
            panRef().y(endY, PAN_DUR, linear),
            ...(htmlSnippet ? [codeScrollRef().y(200, PAN_DUR, easeInOutCubic)] : []),
        );
    } else {
        if (htmlSnippet) yield* codeScrollRef().y(200, 3.7, easeInOutCubic);
        else yield* waitFor(3.7);
    }
});
