#!/usr/bin/env node
// Builds the static site: one dashboard page per currency that has a snapshot,
// plus the Dutch guide.
//
// The dashboard template is written as page content for an artifact viewer,
// which supplies the document shell. Served on its own the page needs that
// shell back: doctype, charset, viewport, and a description for link previews.
//
// Each dashboard is handed the peer currency's readings, which a single
// pipeline run cannot know: the run only ever sees one asset.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { roundDeep } from '../src/publish.js';
import { buildDashboard } from '../src/build-dashboard.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = join(ROOT, 'site');
mkdirSync(SITE, { recursive: true });

const CURRENCIES = [
  { code: 'BTC', page: 'index.html', name: 'Bitcoin' },
  { code: 'ETH', page: 'eth.html', name: 'Ether' },
];
const snapPath = code => join(ROOT, 'out', `snapshot${code === 'BTC' ? '' : '-' + code}.json`);

const icon = "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'>" +
  "<text y='.9em' font-size='90'>%F0%9F%93%90</text></svg>";

const shell = (body, title, description) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="${description}">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${description}">
<meta property="og:type" content="website">
<link rel="icon" href="${icon}">
${body}
</html>
`;

// --- dashboards ------------------------------------------------------------
const available = CURRENCIES.filter(c => existsSync(snapPath(c.code)));
if (!available.length) throw new Error('no snapshot found; run bin/lab.js update first');
const snaps = new Map(available.map(c => [c.code, JSON.parse(readFileSync(snapPath(c.code), 'utf8'))]));
const nav = available.map(c => ({ code: c.code, page: c.page }));

for (const c of available) {
  const other = available.find(o => o.code !== c.code);
  let peer = null;
  if (other) {
    const s = snaps.get(other.code);
    peer = roundDeep({
      currency: other.code, page: other.page, spot: s.meta.spot, cm: s.cm,
      headline: s.headline ? { label: s.headline.label, level: s.headline.level, p: s.headline.p } : null,
    }, 6);
  }
  const built = buildDashboard(ROOT, c.code, { peer, nav });
  const title = c.code === 'BTC' ? 'Vol Surface Lab' : `Vol Surface Lab · ${c.code}`;
  const description = `${c.name} options implied volatility surface from Deribit, refreshed daily: ` +
    'SVI calibration, variance risk premium, 25-delta skew and the Breeden-Litzenberger ' +
    'risk-neutral density, with the arbitrage checks each result depends on.';
  const body = readFileSync(built.file, 'utf8').replace('<title>Vol Surface Lab</title>', `<title>${title}</title>`);
  const html = shell(body, title, description);
  writeFileSync(join(SITE, c.page), html);
  console.log(`site/${c.page}  ${(html.length / 1024).toFixed(0)} KB`);
}

// Serve the files as-is; without this marker GitHub Pages runs Jekyll over them.
writeFileSync(join(SITE, '.nojekyll'), '');

// --- the guide -------------------------------------------------------------
// Written against bitcoin, the asset the guide's examples use.
const S = snaps.get('BTC') || snaps.get(available[0].code);
const hl = S.headline;
const sl = S.slices.find(s => s.label === hl.label) || S.slices[S.slices.length - 1];
const dn = S.densities.find(d => d.label === hl.label) || S.densities[S.densities.length - 1];
const e = S.vrpStats && S.vrpStats.expost;
const facts = roundDeep({
  asOfIso: S.meta.asOfIso,
  spot: S.meta.spot,
  cm: S.cm,
  context: S.context,
  headline: { label: hl.label, dte: hl.dte, F: hl.F, level: hl.level, p: hl.p },
  term: S.vrp.map(r => ({ label: r.label, dte: r.dte, atmIv: r.atmIv, mfIv: r.mfIv })),
  smile: {
    label: sl.label, dte: sl.dte, T: sl.T, F: sl.F, params: sl.params,
    kLo: sl.kLo, kHi: sl.kHi, rmseVol: sl.rmseVol,
    points: sl.points.map(p => ({ k: p.k, iv: p.iv, type: p.type })),
  },
  density: { label: dn.label, dte: dn.dte, F: dn.F, Ks: dn.Ks, q: dn.q },
  expost: e ? { n: e.n, effectiveN: e.effectiveN, mean: e.mean, tStat: e.tStat, hitRate: e.hitRate, min: e.min } : null,
  medianRmse: S.meta.health.medianRmse,
  historyDays: S.history.length,
}, 5);

const guideTpl = readFileSync(join(ROOT, 'src', 'explainer-template.html'), 'utf8');
if (!guideTpl.includes('__FACTS__')) throw new Error('explainer template has no __FACTS__ placeholder');
const guide = guideTpl.replace('__FACTS__', () => JSON.stringify(facts).replace(/<\//g, '<\\/'));
writeFileSync(join(SITE, 'uitleg.html'), guide);
console.log(`site/uitleg.html  ${(guide.length / 1024).toFixed(0)} KB`);
