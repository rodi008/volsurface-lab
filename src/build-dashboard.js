// Injects a snapshot into the dashboard template. Kept as a build step rather
// than a hand-edited file so the page is always reproducible from a run.
//
// `extra` is merged into the payload at build time. It carries what one
// currency cannot know on its own — the peer asset's readings — which the
// site build has and a single pipeline run does not.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function buildDashboard(root, currency = 'BTC', extra = null) {
  const sfx = currency === 'BTC' ? '' : `-${currency}`;
  const tpl = readFileSync(join(root, 'src', 'dashboard-template.html'), 'utf8');
  if (!tpl.includes('__SNAPSHOT__')) throw new Error('template has no __SNAPSHOT__ placeholder');

  let snap = readFileSync(join(root, 'out', `snapshot${sfx}.json`), 'utf8');
  if (extra) snap = JSON.stringify(Object.assign(JSON.parse(snap), extra));

  // The payload sits in a <script type="application/json"> block, so the only
  // sequence that can break out of it is a literal "</". Escaping the slash is
  // legal JSON and invisible to JSON.parse.
  const html = tpl.replace('__SNAPSHOT__', () => snap.replace(/<\//g, '<\\/'));
  const file = join(root, 'out', `dashboard${sfx}.html`);
  writeFileSync(file, html);
  return { file, bytes: html.length, snapshotBytes: snap.length };
}
