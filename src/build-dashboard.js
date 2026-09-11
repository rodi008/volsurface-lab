// Injects out/snapshot.json into the dashboard template. Kept as a build step
// rather than a hand-edited file so the page is always reproducible from a run.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function buildDashboard(root) {
  const tpl = readFileSync(join(root, 'src', 'dashboard-template.html'), 'utf8');
  const snap = readFileSync(join(root, 'out', 'snapshot.json'), 'utf8');
  if (!tpl.includes('__SNAPSHOT__')) throw new Error('template has no __SNAPSHOT__ placeholder');

  // The payload sits in a <script type="application/json"> block, so the only
  // sequence that can break out of it is a literal "</". Escaping the slash is
  // legal JSON and invisible to JSON.parse.
  const safe = snap.replace(/<\//g, '<\\/');
  const html = tpl.replace('__SNAPSHOT__', () => safe);
  const file = join(root, 'out', 'dashboard.html');
  writeFileSync(file, html);
  return { file, bytes: html.length, snapshotBytes: snap.length };
}
