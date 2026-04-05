import * as fs from "fs";
import * as path from "path";
import type { LogLine } from "../types";

export function parseEventStream(runDir: string): LogLine[] {
  const ndjsonPath = path.join(runDir, "run.ndjson");
  if (!fs.existsSync(ndjsonPath)) return [];
  const lines = fs.readFileSync(ndjsonPath, "utf-8").split("\n");
  const events: LogLine[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed) as LogLine);
    } catch {
      // skip malformed lines
    }
  }
  return events;
}
