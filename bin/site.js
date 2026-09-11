#!/usr/bin/env node
// Wraps the dashboard into a standalone site at site/index.html.
//
// The dashboard template is written as page content for an artifact viewer,
// which supplies the document shell. Served on its own the page needs that
// shell back: doctype, charset, viewport, and a description for link
// previews. Everything else is the same file the artifact shows.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
// Serve the file as-is; without this marker GitHub Pages runs Jekyll over it.
writeFileSync(join(SITE, '.nojekyll'), '');
console.log(`site/index.html  ${(html.length / 1024).toFixed(0)} KB`);
