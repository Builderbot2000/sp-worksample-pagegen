/**
 * scripts/viz-mc.ts
 *
 * Prepares run data for the Motion Canvas visualizer and launches the Vite dev
 * server so the user can play back / export the animation.
 *
 * Usage:
 *   npm run viz:mc -- output/<run-dir>
 *   npx tsx scripts/viz-mc.ts output/1775350622628-stripe-en-ca-payments-reference
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawn, spawnSync } from 'child_process';

// ── 1. Parse CLI arg ──────────────────────────────────────────────────────────

const runDirArg = process.argv[2];
if (!runDirArg) {
  console.error('Usage: tsx scripts/viz-mc.ts <run-directory>');
  process.exit(1);
}

const absRunDir = path.resolve(runDirArg);

if (!fs.existsSync(absRunDir)) {
  console.error(`Run directory not found: ${absRunDir}`);
  process.exit(1);
}

// ── 2. Read run.json and run.ndjson ───────────────────────────────────────────

const runJsonPath   = path.join(absRunDir, 'run.json');
const runNdjsonPath = path.join(absRunDir, 'run.ndjson');

if (!fs.existsSync(runJsonPath)) {
  console.error(`run.json not found in: ${absRunDir}`);
  process.exit(1);
}
if (!fs.existsSync(runNdjsonPath)) {
  console.error(`run.ndjson not found in: ${absRunDir}`);
  process.exit(1);
}

const runRecord = JSON.parse(fs.readFileSync(runJsonPath, 'utf-8')) as Record<string, unknown>;
const rawNdjson = fs.readFileSync(runNdjsonPath, 'utf-8').trim();

// Parse NDJSON — each line is a JSON object.  The format uses either `ts` or
// `timestamp` depending on the pipeline version; normalise to `ts`.
const rawEvents = rawNdjson
  .split('\n')
  .filter(Boolean)
  .map(line => {
    const ev = JSON.parse(line) as Record<string, unknown>;
    // Normalise timestamp field name
    if (ev.timestamp !== undefined && ev.ts === undefined) {
      ev.ts = ev.timestamp;
    }
    return ev;
  });

// ── 3. Convert screenshot paths to /@fs absolute URLs ─────────────────────────
//
// The run.json stores paths relative to the run directory (e.g. "source.png").
// Vite can serve arbitrary files via /@fs/<absolute-path> when
// server.fs.allow includes '/'.

function toFsUrl(relPath: string): string {
  return `/@fs${path.join(absRunDir, relPath)}`;
}

const rawPaths = (runRecord.screenshotPaths ?? {}) as Record<string, unknown>;

const screenshotPaths: Record<string, unknown> = {};
if (typeof rawPaths.source === 'string') {
  screenshotPaths.source = toFsUrl(rawPaths.source);
}
if (rawPaths.sections && typeof rawPaths.sections === 'object') {
  const sections: Record<string, string> = {};
  for (const [slug, relPath] of Object.entries(rawPaths.sections as Record<string, string>)) {
    sections[slug] = toFsUrl(relPath);
  }
  screenshotPaths.sections = sections;
}
if (typeof rawPaths.fidelityMain === 'string') {
  screenshotPaths.fidelityMain = toFsUrl(rawPaths.fidelityMain);
}
if (rawPaths.fidelitySections && typeof rawPaths.fidelitySections === 'object') {
  const fidelitySections: Record<string, string> = {};
  for (const [slug, relPath] of Object.entries(rawPaths.fidelitySections as Record<string, string>)) {
    fidelitySections[slug] = toFsUrl(relPath);
  }
  screenshotPaths.fidelitySections = fidelitySections;
}

// Rewrite image paths inside section-score events so scenes can use them as
// /@fs URLs directly.
const events = rawEvents.map(ev => {
  if (ev.phase === 'section-score' && ev.data && typeof ev.data === 'object') {
    const d = { ...(ev.data as Record<string, unknown>) };
    if (typeof d.generatedScreenshotPath === 'string') {
      d.generatedScreenshotPath = toFsUrl(d.generatedScreenshotPath);
    }
    if (typeof d.sourceScreenshotPath === 'string') {
      d.sourceScreenshotPath = toFsUrl(d.sourceScreenshotPath);
    }
    return { ...ev, data: d };
  }
  return ev;
});

// ── 4. Derive lightweight meta flags ─────────────────────────────────────────

const hasFidelity   = events.some(e => e.phase === 'fidelity:start');
const hasCorrection = events.some(e => e.phase === 'correction-iter:start');

// Skeleton screenshot and HTML content (from skeleton:complete event)
const skeletonEvent = events.find(e => e.phase === 'skeleton:complete') as
  | { data?: { screenshotPath?: string; outputFile?: string } }
  | undefined;
const skeletonScreenshotPath =
  skeletonEvent?.data?.screenshotPath != null
    ? toFsUrl(skeletonEvent.data.screenshotPath)
    : null;

// Read skeleton HTML content (first 30k chars) for the animated code panel
let skeletonHtml: string | null = null;
if (skeletonEvent?.data?.outputFile) {
  const skelHtmlPath = path.join(absRunDir, skeletonEvent.data.outputFile);
  if (fs.existsSync(skelHtmlPath)) {
    skeletonHtml = fs.readFileSync(skelHtmlPath, 'utf-8').slice(0, 30000);
  }
}

// Assembled/final HTML path (from assemble:complete event)
const assembleEvent = events.find(e => e.phase === 'assemble:complete') as
  | { data?: { outputFile?: string } }
  | undefined;
const generatedHtmlPath =
  assembleEvent?.data?.outputFile != null
    ? toFsUrl(assembleEvent.data.outputFile)
    : null;

// Read generated HTML content (first 30k chars) for the animated code panel in Seq 5
let generatedHtml: string | null = null;
if (assembleEvent?.data?.outputFile) {
  const genHtmlAbsPath = path.join(absRunDir, assembleEvent.data.outputFile);
  if (fs.existsSync(genHtmlAbsPath)) {
    generatedHtml = fs.readFileSync(genHtmlAbsPath, 'utf-8').slice(0, 30000);
  }
}

// ── 5. Build the run-data.json payload ────────────────────────────────────────

const runData = {
  meta: {
    runId:             runRecord.runId as string,
    name:              (runRecord.name as string | undefined) ?? null,
    url:               runRecord.url as string,
    startedAt:         runRecord.startedAt as number,
    completedAt:       runRecord.completedAt as number,
    estimatedCostUsd:  runRecord.estimatedCostUsd as number,
    screenshotPaths,
    hasFidelity,
    hasCorrection,
    skeletonScreenshotPath,
    skeletonHtml,
    generatedHtmlPath,
    generatedHtml,
  },
  events,
  fsBase: absRunDir,
};

// ── 6. Write to the MC sub-project's data file ────────────────────────────────

const mcDir        = path.join(process.cwd(), 'src/observability/visualizer-mc');
const dataDir      = path.join(mcDir, 'src/data');
const dataFilePath = path.join(dataDir, 'run-data.json');

fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(dataFilePath, JSON.stringify(runData, null, 2));

const label = runData.meta.name ?? runData.meta.runId;
console.log(`[viz:mc] Run data written  → ${dataFilePath}`);
console.log(`[viz:mc] Run: ${label}`);
console.log(`[viz:mc] Sections: ${events.filter(e => e.phase === 'section:start').length}`);
console.log(`[viz:mc] Fidelity: ${hasFidelity}, Correction: ${hasCorrection}`);
console.log();

// ── 7. Launch the Vite dev server ─────────────────────────────────────────────

// Check that node_modules are present (synchronous install so no top-level await)
if (!fs.existsSync(path.join(mcDir, 'node_modules'))) {
  console.log('[viz:mc] node_modules not found — running npm install first…');
  const result = spawnSync('npm', ['install'], {
    cwd: mcDir,
    stdio: 'inherit',
    shell: false,
  });
  if (result.status !== 0) {
    console.error(`[viz:mc] npm install failed (exit ${result.status})`);
    process.exit(1);
  }
  console.log('[viz:mc] npm install complete.');
  console.log();
}

console.log('[viz:mc] Starting Motion Canvas dev server on http://localhost:9000 …');

const vite = spawn('npx', ['vite', '--port', '9000'], {
  cwd: mcDir,
  stdio: 'inherit',
  shell: false,
});

vite.on('close', code => process.exit(code ?? 0));
