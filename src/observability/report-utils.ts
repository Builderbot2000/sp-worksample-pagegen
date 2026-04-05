import type { Severity } from "./types";

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

export function formatDate(ts: number): string {
  return new Date(ts).toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

export function severityColor(severity: Severity): string {
  if (severity === "high") return "#ef4444";
  if (severity === "medium") return "#f59e0b";
  return "#22c55e";
}

export function scoreBarWidth(score: number): number {
  return Math.round(Math.max(0, Math.min(1, score)) * 100);
}

export function scoreColor(score: number): string {
  if (score > 0.85) return "#22c55e";
  if (score >= 0.6) return "#f59e0b";
  return "#ef4444";
}
