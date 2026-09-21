#!/usr/bin/env node
// Renders out/snapshot[-CCY].json into out/dashboard[-CCY].html.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDashboard } from '../src/build-dashboard.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = process.argv.slice(2).find(a => a.startsWith('--currency='));
const ccy = (arg ? arg.split('=')[1] : 'BTC').toUpperCase();
const r = buildDashboard(ROOT, ccy);
console.log(`${r.file.split(/[\\/]/).pop()}  ${(r.bytes / 1024).toFixed(0)} KB  (snapshot ${(r.snapshotBytes / 1024).toFixed(0)} KB)`);
