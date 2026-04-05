/**
 * scene-skeleton.tsx
 *
 * Slide 3 — Skeleton generation: skeleton screenshot pan on the left,
 * HTML snippet scroll on the right.
 */

import { makeScene2D, Img, Rect, Txt, Layout } from '@motion-canvas/2d';
import {
    createRef,
    all,
    waitFor,
    easeOutCubic,
    easeInOutCubic,
} from '@motion-canvas/core';

import runData from '../data/run-data.json';
import { deriveState } from '../state';
import { BG_CARD, BG_BORDER, TXT_DIM, TXT_WHITE } from '../theme';

const state = deriveState(runData.events as Parameters<typeof deriveState>[0]);

export default makeScene2D(function* (view) {

    const skeletonUrl = runData.meta.skeletonScreenshotPath ?? null;
    const htmlSnippet = state.preprocess.data?.htmlSnippet ?? null;

    const imgContainerRef = createRef<Rect>();
    const skeletonImgRef = createRef<Img>();
    const headerRef = createRef<Layout>();
    const codeRef = createRef<Txt>();
    const codePanelRef = createRef<Layout>();

    const CLIP_W = 820;
    const CLIP_H = 1080;

    view.add(
        <>
            {/* Left: skeleton screenshot */}
            <Rect x={-540} width={CLIP_W} height={CLIP_H} clip>
                <Rect ref={imgContainerRef} width={CLIP_W} y={0}>
                    {skeletonUrl ? (
                        <Img
                            ref={skeletonImgRef}
                            src={skeletonUrl}
                            width={CLIP_W}
                            opacity={0}
                        />
                    ) : (
                        <Layout
                            direction="column"
                            gap={16}
                            alignItems="center"
                            justifyContent="center"
                            width={CLIP_W}
                            height={CLIP_H}
                        >
                            <Rect width={600} height={40} radius={4} fill={BG_CARD} />
                            <Rect width={600} height={600} radius={8} fill={BG_CARD} />
                            <Rect width={600} height={40} radius={4} fill={BG_CARD} />
                        </Layout>
                    )}
                </Rect>
            </Rect>

            {/* Right: header + code */}
            <Layout
                x={440}
                direction="column"
                gap={28}
                alignItems="start"
                width={740}
                paddingLeft={60}
                paddingRight={40}
                height={CLIP_H}
                justifyContent="center"
            >
                <Layout ref={headerRef} direction="column" gap={6} opacity={0}>
                    <Txt
                        text="SKELETON"
                        fontSize={18}
                        fill={TXT_DIM}
                        fontFamily="system-ui, sans-serif"
                        fontWeight={600}
                        letterSpacing={2}
                    />
                    <Txt
                        text="HTML structure generated"
                        fontSize={34}
                        fill={TXT_WHITE}
                        fontFamily="system-ui, sans-serif"
                        fontWeight={700}
                    />
                </Layout>

                <Layout ref={codePanelRef} direction="column" width={660} opacity={0}>
                    <Rect fill={BG_CARD} stroke={BG_BORDER} lineWidth={1} radius={8} padding={24} width={660} height={520} clip>
                        {htmlSnippet ? (
                            <Txt
                                ref={codeRef}
                                text={htmlSnippet.slice(0, 1200)}
                                fontSize={15}
                                fill="#a5f3fc"
                                fontFamily="'Courier New', monospace"
                                width={610}
                                y={-240}
                            />
                        ) : (
                            <Layout direction="column" gap={12}>
                                {[600, 480, 600, 380, 560, 440, 600, 320].map((w, j) => (
                                    <Rect key={String(j)} width={w} height={22} radius={3} fill={BG_BORDER} />
                                ))}
                            </Layout>
                        )}
                    </Rect>
                </Layout>
            </Layout>
        </>,
    );

    yield* all(
        skeletonUrl ? skeletonImgRef().opacity(1, 0.6, easeOutCubic) : waitFor(0),
        headerRef().opacity(1, 0.5, easeOutCubic),
    );

    yield* codePanelRef().opacity(1, 0.4, easeOutCubic);

    const PAN_DUR = 4.5;

    yield* all(
        skeletonUrl ? imgContainerRef().y(200, PAN_DUR, easeInOutCubic) : waitFor(0),
        htmlSnippet
            ? codeRef().y(240, PAN_DUR, easeInOutCubic)
            : waitFor(0),
        waitFor(PAN_DUR),
    );
});
