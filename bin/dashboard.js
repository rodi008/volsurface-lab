#!/usr/bin/env node
// Renders out/snapshot.json into out/dashboard.html.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDashboard } from '../src/build-dashboard.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const r = buildDashboard(ROOT);
console.log(`out/dashboard.html  ${(r.bytes / 1024).toFixed(0)} KB  (snapshot ${(r.snapshotBytes / 1024).toFixed(0)} KB)`);
