#!/usr/bin/env node
// Builds the static site: site/index.html (the dashboard) and site/uitleg.html
// (the plain-language guide).
//
// The dashboard template is written as page content for an artifact viewer,
// which supplies the document shell. Served on its own the page needs that
// shell back: doctype, charset, viewport, and a description for link
// previews. The guide is a complete document of its own and only receives the
// handful of numbers it quotes, not the whole snapshot.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { roundDeep } from '../src/publish.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = join(ROOT, 'site');
const page = readFileSync(join(ROOT, 'out', 'dashboard.html'), 'utf8');

const description = 'BTC options implied volatility surface from Deribit, refreshed daily: ' +
  'SVI calibration, variance risk premium, 25-delta skew and the Breeden-Litzenberger ' +
  'risk-neutral density, with the arbitrage checks each result depends on.';
const icon = "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'>" +
  "<text y='.9em' font-size='90'>%F0%9F%93%90</text></svg>";

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="${description}">
<meta property="og:title" content="Vol Surface Lab">
<meta property="og:description" content="${description}">
<meta property="og:type" content="website">
<link rel="icon" href="${icon}">
${page}
</html>
`;

mkdirSync(SITE, { recursive: true });
writeFileSync(join(SITE, 'index.html'), html);
// Serve the files as-is; without this marker GitHub Pages runs Jekyll over them.
writeFileSync(join(SITE, '.nojekyll'), '');
console.log(`site/index.html  ${(html.length / 1024).toFixed(0)} KB`);

// --- the guide -------------------------------------------------------------
const S = JSON.parse(readFileSync(join(ROOT, 'out', 'snapshot.json'), 'utf8'));
const hl = S.headline;
const sl = S.slices.find(s => s.label === hl.label) || S.slices[S.slices.length - 1];
const dn = S.densities.find(d => d.label === hl.label) || S.densities[S.densities.length - 1];
const e = S.vrpStats && S.vrpStats.expost;
const facts = roundDeep({
  asOfIso: S.meta.asOfIso,
  spot: S.meta.spot,
  cm: S.cm,
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
