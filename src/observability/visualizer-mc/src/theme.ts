// Score color thresholds matching the HTML visualizer
export const SCORE_GREEN  = '#22c55e';
export const SCORE_AMBER  = '#f59e0b';
export const SCORE_RED    = '#ef4444';

export const BG_DARK   = '#0d1117';
export const BG_CARD   = '#161b22';
export const BG_BORDER = '#21262d';
export const TXT_DIM   = '#6b7280';
export const TXT_MID   = '#9ca3af';
export const TXT_BODY  = '#e5e7eb';
export const TXT_WHITE = '#f9fafb';
export const BLUE      = '#3b82f6';
export const BLUE_DIM  = '#1d4ed8';

export function scoreColor(s: number): string {
  return s > 0.85 ? SCORE_GREEN : s >= 0.6 ? SCORE_AMBER : SCORE_RED;
}

export function fmtMs(ms: number): string {
  ms = Math.round(ms);
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
}

export function fmtNum(n: number): string {
  return Number(n).toLocaleString();
}
