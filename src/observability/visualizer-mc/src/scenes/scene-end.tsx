/**
 * scene-end.tsx
 *
 * Slide 5 — Fidelity check result: source vs generated side-by-side,
 * score count-up, and summary stats.
 *
 * Only included in the project when hasFidelity === true.
 */

import { makeScene2D, Img, Rect, Txt, Layout } from '@motion-canvas/2d';
import {
    createRef,
    all,
    waitFor,
    easeOutCubic,
    tween,
} from '@motion-canvas/core';

import runData from '../data/run-data.json';
import { deriveState } from '../state';
import {
    BG_CARD, BG_BORDER,
    TXT_DIM, TXT_BODY, TXT_WHITE,
    SCORE_AMBER,
    scoreColor, fmtMs,
} from '../theme';

const PLACEHOLDER = 'data:image/gif;base64,R0lGODlhAQABAIAAAAUEBAAAACwAAAAAAQABAAACAkQBADs=';

const state = deriveState(runData.events as Parameters<typeof deriveState>[0]);
const sp = (runData.meta.screenshotPaths ?? {}) as Record<string, unknown>;

export default makeScene2D(function* (view) {

    const fidelityData = state.fidelity.data;
    const mainScore = fidelityData?.mainScore ?? null;
    const sourceUrl = typeof sp?.source === 'string' ? sp.source : null;
    const mainUrl = typeof sp?.fidelityMain === 'string' ? sp.fidelityMain : null;

    const totalDurationMs = runData.meta.completedAt - runData.meta.startedAt;
    const costUsd = runData.meta.estimatedCostUsd;

    const headerRef = createRef<Layout>();
    const srcImgRef = createRef<Img>();
    const genImgRef = createRef<Img>();
    const srcLabelRef = createRef<Txt>();
    const genLabelRef = createRef<Txt>();
    const scoreValRef = createRef<Txt>();
    const scorePanel = createRef<Layout>();
    const statsPanel = createRef<Layout>();

    const THUMB_W = 780;
    const THUMB_H = 840;
    const colorFinal = mainScore != null ? scoreColor(mainScore) : SCORE_AMBER;

    const stats: [string, string][] = [
        ['sections', String(state.sectionOrder.length)],
        ['corrections', String(state.corrections.length)],
        ['duration', fmtMs(totalDurationMs)],
        ...(costUsd ? [['est. cost', `$${costUsd.toFixed(3)}`] as [string, string]] : []),
    ];

    view.add(
        <Layout direction="column" width={1920} height={1080} gap={0}>

            {/* Header */}
            <Layout
                ref={headerRef}
                direction="row"
                gap={20}
                alignItems="center"
                width={1920}
                height={72}
                paddingLeft={48}
                opacity={0}
            >
                <Txt
                    text="fidelity check"
                    fontSize={18}
                    fill={TXT_DIM}
                    fontFamily="system-ui, sans-serif"
                    fontWeight={600}
                    letterSpacing={2}
                />
            </Layout>

            {/* Body */}
            <Layout
                direction="row"
                gap={24}
                alignItems="center"
                paddingLeft={24}
                paddingRight={24}
                height={1008}
            >

                {/* Source screenshot */}
                <Layout direction="column" gap={14} alignItems="center">
                    <Rect width={THUMB_W} height={THUMB_H} fill={BG_CARD} stroke={BG_BORDER} lineWidth={1} radius={8} clip>
                        <Img
                            ref={srcImgRef}
                            src={sourceUrl ?? PLACEHOLDER}
                            width={THUMB_W}
                            height={THUMB_H}
                            opacity={0}
                        />
                    </Rect>
                    <Txt ref={srcLabelRef} text="source" fontSize={18} fill={TXT_DIM} fontFamily="system-ui, sans-serif" opacity={0} />
                </Layout>

                {/* Centre: score + stats */}
                <Layout
                    direction="column"
                    gap={40}
                    alignItems="center"
                    justifyContent="center"
                    grow={1}
                    height={THUMB_H + 24}
                >
                    <Layout ref={scorePanel} direction="column" alignItems="center" gap={10} opacity={0}>
                        <Txt
                            ref={scoreValRef}
                            text="0.00"
                            fontSize={96}
                            fill={colorFinal}
                            fontFamily="system-ui, sans-serif"
                            fontWeight={800}
                        />
                        <Txt
                            text={
                                mainScore != null
                                    ? mainScore > 0.85 ? 'close' : mainScore >= 0.6 ? 'partial' : 'distant'
                                    : ''
                            }
                            fontSize={28}
                            fill={colorFinal}
                            fontFamily="system-ui, sans-serif"
                            letterSpacing={3}
                        />
                        <Txt text="fidelity score" fontSize={18} fill={TXT_DIM} fontFamily="system-ui, sans-serif" />
                    </Layout>

                    <Layout ref={statsPanel} direction="column" gap={16} alignItems="start" opacity={0}>
                        {stats.map(([label, value]) => (
                            <Layout key={label} direction="row" gap={16} alignItems="center">
                                <Txt text={label} fontSize={18} fill={TXT_DIM} fontFamily="system-ui, sans-serif" width={120} />
                                <Txt text={value} fontSize={18} fill={TXT_BODY} fontFamily="system-ui, sans-serif" fontWeight={600} />
                            </Layout>
                        ))}
                    </Layout>
                </Layout>

                {/* Generated screenshot */}
                <Layout direction="column" gap={14} alignItems="center">
                    <Rect width={THUMB_W} height={THUMB_H} fill={BG_CARD} stroke={colorFinal} lineWidth={2} radius={8} clip>
                        <Img
                            ref={genImgRef}
                            src={mainUrl ?? PLACEHOLDER}
                            width={THUMB_W}
                            height={THUMB_H}
                            opacity={0}
                        />
                    </Rect>
                    <Txt ref={genLabelRef} text="generated" fontSize={18} fill={TXT_DIM} fontFamily="system-ui, sans-serif" opacity={0} />
                </Layout>

            </Layout>
        </Layout>,
    );

    // ── Animation ─────────────────────────────────────────────────────────────

    yield* all(
        headerRef().opacity(1, 0.4, easeOutCubic),
        sourceUrl ? srcImgRef().opacity(1, 0.65, easeOutCubic) : waitFor(0),
        mainUrl ? genImgRef().opacity(1, 0.65, easeOutCubic) : waitFor(0),
        srcLabelRef().opacity(1, 0.4, easeOutCubic),
        genLabelRef().opacity(1, 0.4, easeOutCubic),
    );

    yield* waitFor(0.3);

    yield* scorePanel().opacity(1, 0.45, easeOutCubic);

    if (mainScore != null) {
        yield* tween(1.2, v => {
            const cur = mainScore * easeOutCubic(v);
            scoreValRef().text(cur.toFixed(2));
            scoreValRef().fill(scoreColor(cur));
        });
    }

    yield* waitFor(0.2);
    yield* statsPanel().opacity(1, 0.5, easeOutCubic);
    yield* waitFor(2.5);
});
