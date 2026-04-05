/**
 * scene-preprocess.tsx
 *
 * Slide 2 — Preprocessing: source screenshot with animated section bounding
 * boxes, and a column of section label cards on the right.
 */

import {makeScene2D, Img, Rect, Txt, Layout} from '@motion-canvas/2d';
import {
  createRef,
  all,
  sequence,
  waitFor,
  easeOutCubic,
  easeInOutCubic,
} from '@motion-canvas/core';

import runData from '../data/run-data.json';
import {deriveState} from '../state';
import {BG_CARD, BG_BORDER, TXT_DIM, TXT_BODY, TXT_WHITE} from '../theme';

const sp    = (runData.meta.screenshotPaths ?? {}) as Record<string, unknown>;
const state = deriveState(runData.events as Parameters<typeof deriveState>[0]);

// Role → colour accent
const ROLE_COLOR: Record<string, string> = {
  header:  '#818cf8',
  hero:    '#60a5fa',
  feature: '#34d399',
  content: '#a3e635',
  footer:  '#f472b6',
  nav:     '#fb923c',
  section: '#94a3b8',
};
function roleColor(role: string): string {
  return ROLE_COLOR[role.toLowerCase()] ?? ROLE_COLOR['section'];
}

export default makeScene2D(function* (view) {

  const sourceUrl  = typeof sp?.source === 'string' ? sp.source : null;
  const ppData     = state.preprocess.data;
  const sections   = ppData?.sections ?? [];
  const pageHeight = ppData?.pageHeight ?? 6000;

  const CLIP_W   = 820;
  const CLIP_H   = 1080;
  const IMG_SCALE = CLIP_W / 1440;
  const imgH      = pageHeight * IMG_SCALE;

  const panRef       = createRef<Img>();
  const imgContainer = createRef<Rect>();
  const headerRef    = createRef<Layout>();
  const cardsRef     = createRef<Layout>();

  const bboxRefs = sections.map(() => createRef<Rect>());
  const cardRefs = sections.map(() => createRef<Rect>());

  const bboxNodes = sections.map((sec, i) => {
    const yPx    = sec.y * IMG_SCALE;
    const hPx    = sec.heightPx * IMG_SCALE;
    const colour = roleColor(sec.role);
    return (
      <Rect
        ref={bboxRefs[i]}
        x={0}
        y={yPx + hPx / 2 - imgH / 2}
        width={CLIP_W - 4}
        height={hPx}
        stroke={colour}
        lineWidth={2}
        radius={3}
        fill={`${colour}18`}
        opacity={0}
      />
    );
  });

  const cardNodes = sections.map((sec, i) => {
    const colour = roleColor(sec.role);
    return (
      <Rect
        ref={cardRefs[i]}
        fill={BG_CARD}
        stroke={colour}
        lineWidth={1}
        radius={6}
        paddingLeft={16}
        paddingRight={16}
        paddingTop={8}
        paddingBottom={8}
        opacity={0}
        layout
        direction="row"
        gap={12}
        alignItems="center"
      >
        <Rect width={8} height={8} radius={4} fill={colour} />
        <Txt text={sec.slug} fontSize={17} fill={TXT_BODY} fontFamily="system-ui, sans-serif" />
        <Txt text={sec.role} fontSize={15} fill={TXT_DIM}  fontFamily="system-ui, sans-serif" />
      </Rect>
    );
  });

  view.add(
    <>
      {/* Left: screenshot + bbox overlays */}
      <Rect x={-540} width={CLIP_W} height={CLIP_H} clip>
        <Rect
          ref={imgContainer}
          width={CLIP_W}
          height={imgH || CLIP_H}
          y={imgH > 0 ? -(imgH - CLIP_H) / 2 : 0}
        >
          {sourceUrl ? (
            <Img
              ref={panRef}
              src={sourceUrl}
              width={CLIP_W}
              opacity={0}
            />
          ) : (
            <Rect width={CLIP_W} height={CLIP_H} fill={BG_CARD} />
          )}
          {bboxNodes}
        </Rect>
      </Rect>

      {/* Right: header + cards */}
      <Layout
        x={440}
        direction="column"
        gap={20}
        alignItems="start"
        width={740}
        paddingLeft={60}
        paddingRight={40}
        height={CLIP_H}
        justifyContent="center"
      >
        <Layout ref={headerRef} direction="column" gap={6} opacity={0}>
          <Txt
            text="PREPROCESSING"
            fontSize={18}
            fill={TXT_DIM}
            fontFamily="system-ui, sans-serif"
            fontWeight={600}
            letterSpacing={2}
          />
          <Txt
            text={`${sections.length} sections identified`}
            fontSize={34}
            fill={TXT_WHITE}
            fontFamily="system-ui, sans-serif"
            fontWeight={700}
          />
        </Layout>

        <Rect width={660} height={820} clip>
          <Layout
            ref={cardsRef}
            direction="column"
            gap={8}
            alignItems="start"
            width={660}
          >
            {cardNodes}
          </Layout>
        </Rect>
      </Layout>
    </>,
  );

  const BBOX_DUR   = 0.28;
  const CARD_DUR   = 0.22;
  const STAGGER    = sections.length > 10 ? 0.08 : 0.12;
  const PAN_DUR    = Math.max(sections.length * STAGGER + 1.5, 4.0);

  if (sourceUrl) yield* panRef().opacity(1, 0.55, easeOutCubic);
  yield* headerRef().opacity(1, 0.4, easeOutCubic);

  yield* sequence(
    STAGGER,
    ...sections.map((_, i) =>
      all(
        bboxRefs[i]().opacity(1, BBOX_DUR, easeOutCubic),
        cardRefs[i]().opacity(1, CARD_DUR, easeOutCubic),
      ),
    ),
  );

  if (sourceUrl && imgH > CLIP_H) {
    const endY = (imgH - CLIP_H) / 2;
    yield* imgContainer().y(endY, PAN_DUR, easeInOutCubic);
  } else {
    yield* waitFor(PAN_DUR);
  }
});
