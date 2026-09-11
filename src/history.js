// Daily history: one compact row per UTC date.
//
// The local JSONL file is the authoritative record. Each update run also pushes
// the most recent rows to the artifact's database so the published page can
// show day-over-day changes. Rows are keyed by date and upserted, so a re-run
// on the same day replaces that day's row instead of duplicating it.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

export function readHistory(file) {
  if (!existsSync(file)) return [];
  const rows = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* a torn line from an interrupted write */ }
  }
  return rows.filter(r => typeof r.date === 'string').sort((a, b) => a.date.localeCompare(b.date));
}

export function upsertHistory(file, row) {
  const rows = readHistory(file).filter(r => r.date !== row.date);
  rows.push(row);
  rows.sort((a, b) => a.date.localeCompare(b.date));
  writeFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  return rows;
}
