#!/usr/bin/env node
// Vol Surface Lab. Every stage is independently invocable:
//
//   lab.js validate            analytic checks + exchange round trip
//   lab.js surface             SVI calibration, per-slice diagnostics
//   lab.js skew                25-delta risk reversal / butterfly term structure
//   lab.js vrp                 variance risk premium, ex-ante and ex-post
//   lab.js rnd [--expiry=X]    Breeden-Litzenberger density
//   lab.js all                 everything; writes out/snapshot.json
//   lab.js update              the unattended daily run, see cmdUpdate()
//
// Flags: --json  --quiet  --currency=BTC  --expiry=25DEC26  --levels=100000,150000

import { writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fetchChain, fetchOhlc, fetchDvol } from '../src/deribit.js';
import { buildSurface, surfaceMesh } from '../src/surface.js';
import { price, impliedVol } from '../src/black76.js';
import { skewTermStructure } from '../src/skew.js';
import { vrpByExpiry, expostVrpSeries, vrpStats, realizedAll, realizedCloseToClose } from '../src/varswap.js';
import { riskNeutralDensity, densitySummary, probAbove, niceLevels } from '../src/rnd.js';
import { readTermStructure, readSkew, readVrp, readDensity, readDiagnostics } from '../src/interpret.js';
import { cmVol, cmLinear } from '../src/constmat.js';
import { readHistory, upsertHistory } from '../src/history.js';
import { roundDeep, healthCheck, dbDocuments } from '../src/publish.js';
import { buildDashboard } from '../src/build-dashboard.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'out');
const HISTORY_FILE = join(OUT, 'history.jsonl');
const DB_DIR = join(OUT, 'db');
const BATCH_FILE = join(DB_DIR, 'batch.json');

const argv = process.argv.slice(2);
const cmd = argv.find(a => !a.startsWith('-')) || 'all';
const flag = (name, dflt = null) => {
  const hit = argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : dflt;
};
const has = name => argv.includes(`--${name}`);
const JSON_OUT = has('json');
let QUIET = has('quiet');
const CCY = flag('currency', 'BTC');

/** Report output; suppressed by --quiet and by the unattended update. */
const out = (...args) => { if (!QUIET) console.log(...args); };
const pad = (s, n) => String(s).padStart(n);
const padr = (s, n) => String(s).padEnd(n);
const p1 = x => (x * 100).toFixed(1);
const p2 = x => (x * 100).toFixed(2);
const fx = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : 'n/a');

function h(title) {
  if (JSON_OUT) return;
  out('\n' + title);
  out('-'.repeat(title.length));
}
function para(lines) {
  if (JSON_OUT) return;
  for (const l of lines) out('\n' + wrap(l, 96));
}
function wrap(s, width) {
  const words = s.split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    if ((line + ' ' + w).trim().length > width) { lines.push(line.trim()); line = w; }
    else line += ' ' + w;
  }
  if (line.trim()) lines.push(line.trim());
  return lines.join('\n');
}

// ---------------------------------------------------------------------------

async function load({ needHistory = false } = {}) {
  const jobs = [fetchChain(CCY)];
  if (needHistory) jobs.push(fetchOhlc(400), fetchDvol(400, CCY));
  const [chain, ohlc, dvol] = await Promise.all(jobs);
  const surface = buildSurface(chain);
  return { chain, surface, ohlc, dvol };
}

function pickSlice(surface) {
  const want = flag('expiry');
  if (want) {
    const s = surface.slices.find(x => x.label.toUpperCase() === want.toUpperCase());
    if (!s) {
      console.error(`No expiry ${want}. Available: ${surface.slices.map(x => x.label).join(', ')}`);
      process.exit(1);
    }
    return s;
  }
  // Default: the expiry nearest 100 days, the same slice the dashboard's
  // headline probability is read from.
  return surface.slices.reduce((a, b) => (Math.abs(b.dte - 100) < Math.abs(a.dte - 100) ? b : a));
}

/** Pricing convention and data integrity against the exchange's own marks. */
function exchangeChecks(chain) {
  let maxTicks = 0, maxTicksName = '', otmIv = 0, otmIvName = '';
  for (const o of chain.rows) {
    const p = price(o.F, o.K, o.T, o.iv, o.r, o.type);
    const ticks = Math.abs(p - o.priceUsd) / (1e-4 * o.F);
    if (ticks > maxTicks) { maxTicks = ticks; maxTicksName = o.name; }
    if (o.isOtm) {
      const back = impliedVol(o.priceUsd, o.F, o.K, o.T, o.r, o.type);
      if (back != null) {
        const e = Math.abs(back - o.iv) * 100;
        if (e > otmIv) { otmIv = e; otmIvName = o.name; }
      }
    }
  }
  const pairs = new Map();
  for (const o of chain.rows) {
    const key = o.expiryLabel + '|' + o.K;
    if (!pairs.has(key)) pairs.set(key, {});
    pairs.get(key)[o.type] = o;
  }
  let maxDev = 0, n = 0;
  for (const [, p] of pairs) {
    if (!p.call || !p.put) continue;
    const dev = Math.abs((p.call.priceUsd - p.put.priceUsd)
      - Math.exp(-p.call.r * p.call.T) * (p.call.F - p.call.K)) / p.call.F;
    maxDev = Math.max(maxDev, dev);
    n++;
  }
  return {
    contracts: chain.rows.length,
    maxTicks, maxTicksName,
    otmIvVolPts: otmIv, otmIvName,
    parityBp: maxDev * 1e4, parityPairs: n,
  };
}

// ---------------------------------------------------------------------------

async function cmdValidate() {
  const { chain, surface } = await load();
  const v = exchangeChecks(chain);
  h(`Exchange round trip  (${v.contracts} contracts, ${new Date(chain.asOf).toISOString()})`);
  out(`  Black-76 vs exchange mark : max ${v.maxTicks.toFixed(4)} ticks  (${v.maxTicksName})`);
  out(`  IV inversion, OTM only    : max ${v.otmIvVolPts.toExponential(2)} vol pts  (${v.otmIvName})`);
  out(`  Put-call parity           : max ${v.parityBp.toFixed(4)} bp of forward over ${v.parityPairs} pairs`);

  h('Density integrity  (per slice)');
  out('  expiry     mass      err        mean/F        bp    extrap%');
  for (const s of surface.slices) {
    const d = riskNeutralDensity(s, { n: 3001 }).diagnostics;
    out('  ' + padr(s.label, 10) + pad(d.mass.toFixed(6), 9) + pad(d.massError.toExponential(1), 10)
      + pad((d.meanK / s.F).toFixed(8), 14) + pad(d.meanErrorBp.toFixed(2), 8)
      + pad((d.extrapolatedMass * 100).toFixed(2), 10));
  }

  h('Arbitrage');
  para(readDiagnostics(surface));
}

async function cmdSurface(pre) {
  const { chain, surface } = pre || await load();
  if (JSON_OUT) { console.log(JSON.stringify({ surface, mesh: surfaceMesh(surface) }, null, 2)); return surface; }

  h(`IV surface  ${CCY}  spot ${chain.spot.toFixed(0)}  ${new Date(chain.asOf).toISOString()}`);
  out('  expiry      dte      F     n  core  ATM%   RMSE  core  max   stale |    a       b      rho      m      sig    minG');
  for (const s of surface.slices) {
    const p = s.params;
    out('  ' + padr(s.label, 10) + pad(s.dte.toFixed(1), 7) + pad(s.F.toFixed(0), 7)
      + pad(s.nPoints, 6) + pad(s.nCore, 6) + pad(p1(s.atmIv), 6)
      + pad(s.rmseVol.toFixed(2), 7) + pad(s.coreRmseVol.toFixed(2), 6) + pad(s.maxAbsVol.toFixed(2), 6)
      + pad(s.staleQuotes, 7) + '  | ' + pad(p.a.toFixed(5), 8) + pad(p.b.toFixed(4), 8)
      + pad(p.rho.toFixed(4), 8) + pad(p.m.toFixed(4), 8) + pad(p.sig.toFixed(4), 8)
      + pad(s.butterfly.minG.toExponential(1), 9));
  }
  para(readTermStructure(surface));
  para(readDiagnostics(surface));
  return surface;
}

function skewContext(skews, asOf) {
  const today = new Date(asOf).toISOString().slice(0, 10);
  return {
    rr30: cmLinear(skews.filter(s => s.rr != null), 30, 'rr'),
    rrHistory: readHistory(HISTORY_FILE).filter(r => r.date < today).map(r => r.rr30).filter(Number.isFinite),
  };
}

async function cmdSkew(pre) {
  const { chain, surface } = pre || await load();
  const skews = skewTermStructure(surface, 0.25);
  if (JSON_OUT) { console.log(JSON.stringify(skews, null, 2)); return skews; }

  h('25-delta wing structure');
  out('  expiry      dte    ATM%   25dP%   25dC%     RR25     BF25   putK      callK     dIV/dk');
  for (const s of skews) {
    if (s.rr == null) { out('  ' + padr(s.label, 10) + '  unsolvable'); continue; }
    out('  ' + padr(s.label, 10) + pad(s.dte.toFixed(1), 6) + pad(p1(s.atmIv), 7)
      + pad(p1(s.putIv), 8) + pad(p1(s.callIv), 8)
      + pad((s.rr >= 0 ? '+' : '') + s.rr.toFixed(2), 9) + pad((s.bf >= 0 ? '+' : '') + s.bf.toFixed(2), 9)
      + pad(Math.round(s.putK).toLocaleString('en-US'), 10) + pad(Math.round(s.callK).toLocaleString('en-US'), 10)
      + pad(s.atmSlope.toFixed(3), 11));
  }
  para(readSkew(skews, skewContext(skews, chain.asOf)));
  return skews;
}

async function cmdVrp(pre) {
  const ctx = pre && pre.ohlc ? pre : await load({ needHistory: true });
  const { chain, surface, ohlc, dvol } = ctx;
  const rows = vrpByExpiry(surface, ohlc, chain.rows);
  const series = expostVrpSeries(dvol, ohlc, 30);
  const stats = vrpStats(series);
  const realized = realizedAll(ohlc.slice(-31));

  if (JSON_OUT) { console.log(JSON.stringify({ rows, stats, realized, series }, null, 2)); return { rows, stats, series, realized }; }

  h('Variance risk premium by expiry');
  out('  expiry      dte   ATM%  MFIV%  CBOE%  smile   RVwin  RV%   RVse   VRP(vol)  t   VRP(var)');
  for (const r of rows) {
    out('  ' + padr(r.label, 10) + pad(r.dte.toFixed(1), 6) + pad(p1(r.atmIv), 7)
      + pad(p1(r.mfIv), 7) + pad(r.cboeIv != null ? p1(r.cboeIv) : '-', 7)
      + pad((r.smilePremiumVolPts >= 0 ? '+' : '') + r.smilePremiumVolPts.toFixed(2), 7)
      + pad(r.rvWindowDays + 'd', 8) + pad(r.rv != null ? p1(r.rv) : '-', 6)
      + pad(r.rvSeVolPts != null ? r.rvSeVolPts.toFixed(2) : '-', 7)
      + pad(r.vrpVolPts != null ? (r.vrpVolPts >= 0 ? '+' : '') + r.vrpVolPts.toFixed(2) : '-', 10)
      + pad(r.vrpTStat != null ? r.vrpTStat.toFixed(1) : '-', 5)
      + pad(r.vrpVariance != null ? r.vrpVariance.toFixed(4) : '-', 10));
  }

  h('Realized volatility, trailing 30d, by estimator');
  for (const [k, v] of Object.entries(realized)) {
    if (v) out('  ' + padr(k, 16) + pad(p2(v.vol) + '%', 8) + '   n=' + v.n);
  }

  h('Ex-post variance premium  (DVOL vs realized over the FOLLOWING 30 days)');
  for (const [name, s] of Object.entries(stats)) {
    if (!s) continue;
    out(`  ${padr(name, 8)} n=${pad(s.n, 4)} (eff ${s.effectiveN.toFixed(1)})  mean ${pad(s.mean.toFixed(2), 7)}`
      + `  se ${pad(s.seMean.toFixed(2), 6)}  t ${pad(s.tStat.toFixed(2), 6)}  median ${pad(s.median.toFixed(2), 7)}`
      + `  sd ${pad(s.sd.toFixed(2), 6)}  hit ${pad((s.hitRate * 100).toFixed(1) + '%', 7)}`
      + `  p05 ${pad(s.p05.toFixed(2), 7)}  min ${pad(s.min.toFixed(2), 8)}`);
  }
  para(readVrp(rows, stats, realized));
  return { rows, stats, series, realized };
}

async function cmdRnd(pre) {
  const { surface } = pre || await load();
  const slice = pickSlice(surface);
  const rnd = riskNeutralDensity(slice);
  const levelsArg = flag('levels');
  const levels = levelsArg ? levelsArg.split(',').map(Number).filter(Number.isFinite) : null;
  const summary = densitySummary(rnd, levels);

  if (JSON_OUT) {
    console.log(JSON.stringify({ summary, Ks: rnd.Ks, q: rnd.q, digital: rnd.digital }, null, 2));
    return { rnd, summary };
  }

  h(`Risk-neutral density  ${slice.label}  ${slice.dte.toFixed(1)}d  F=${slice.F.toFixed(0)}`);
  out('  level        Q(S_T > level)');
  for (const l of summary.levels) {
    out('  ' + padr('$' + l.level.toLocaleString('en-US'), 12) + pad((l.probAbove * 100).toFixed(2) + '%', 10));
  }
  const q = summary.quantiles;
  out('\n  quantiles   p05 ' + Math.round(q.p05).toLocaleString('en-US')
    + '   p25 ' + Math.round(q.p25).toLocaleString('en-US')
    + '   p50 ' + Math.round(q.p50).toLocaleString('en-US')
    + '   p75 ' + Math.round(q.p75).toLocaleString('en-US')
    + '   p95 ' + Math.round(q.p95).toLocaleString('en-US'));
  const d = summary.diagnostics;
  out('  shape       sd ' + Math.round(d.sd).toLocaleString('en-US')
    + '   skew ' + d.skew.toFixed(3) + '   excess kurtosis ' + d.excessKurtosis.toFixed(3));
  out('  integrity   mass ' + d.mass.toFixed(6) + '   mean/F ' + (d.meanK / slice.F).toFixed(8)
    + ' (' + d.meanErrorBp.toFixed(2) + ' bp)   extrapolated mass ' + (d.extrapolatedMass * 100).toFixed(2) + '%');
  para(readDensity(summary, rnd));
  return { rnd, summary };
}

// ---------------------------------------------------------------------------

async function cmdAll({ writeHistory = false } = {}) {
  const ctx = await load({ needHistory: true });
  const surface = await cmdSurface(ctx);
  const skews = await cmdSkew(ctx);
  const vrp = await cmdVrp(ctx);
  await cmdRnd(ctx);

  const validation = exchangeChecks(ctx.chain);
  const date = new Date(ctx.chain.asOf).toISOString().slice(0, 10);

  // Densities, thinned for transport. The headline probability is read off the
  // full-resolution grid before thinning.
  const full = surface.slices.filter(s => s.dte >= 5).map(s => ({ s, rnd: riskNeutralDensity(s, { n: 2001 }) }));
  const densities = full.map(({ s, rnd }) => {
    const step = Math.ceil(rnd.Ks.length / 280);
    const keep = (_, i) => i % step === 0;
    return {
      label: s.label, dte: s.dte, F: s.F,
      Ks: rnd.Ks.filter(keep), q: rnd.q.filter(keep), digital: rnd.digital.filter(keep),
      summary: densitySummary(rnd),
    };
  });

  // Headline: the expiry nearest 100 days and the first round $25k level at
  // least 20% above its forward. Both roll with the market; a pinned calendar
  // date and a pinned price both go stale on a page that refreshes daily.
  let headline = null, headlineRnd = null;
  if (full.length) {
    const pick = full.reduce((a, b) => (Math.abs(b.s.dte - 100) < Math.abs(a.s.dte - 100) ? b : a));
    const level = Math.ceil(pick.s.F * 1.2 / 25000) * 25000;
    headlineRnd = pick.rnd;
    headline = {
      label: pick.s.label, dte: pick.s.dte, F: pick.s.F, level,
      p: probAbove(pick.rnd, level),
      arbFree: pick.s.butterfly.arbFree,
      levels: niceLevels(pick.s.F, [level]),
    };
  }

  // 30-day constant-maturity readings: the numbers that are comparable from
  // one day to the next, whatever expired in between.
  const skewRows = skews.filter(s => s.rr != null);
  const rv = realizedCloseToClose(ctx.ohlc.slice(-31));
  const atm30 = cmVol(vrp.rows, 30, 'atmIv');
  const mf30 = cmVol(vrp.rows, 30, 'mfIv');
  const rvSe30 = rv ? rv.vol / Math.sqrt(2 * rv.n) * 100 : null;
  const vrp30 = rv && mf30 != null ? (mf30 - rv.vol) * 100 : null;
  const cm = {
    days: 30,
    atm30, mf30,
    rv30: rv ? rv.vol : null, rvSe30, vrp30,
    vrpT30: vrp30 != null && rvSe30 ? vrp30 / rvSe30 : null,
    rr30: cmLinear(skewRows, 30, 'rr'),
    bf30: cmLinear(skewRows, 30, 'bf'),
    dvol: ctx.dvol.length ? ctx.dvol[ctx.dvol.length - 1].close / 100 : null,
  };

  const past = readHistory(HISTORY_FILE).filter(r => r.date < date);
  const rrHistory = past.map(r => r.rr30).filter(Number.isFinite);
  const rmses = surface.slices.map(s => s.rmseVol).sort((a, b) => a - b);
  const today = {
    date,
    asOf: ctx.chain.asOf,
    spot: ctx.chain.spot,
    atm30: cm.atm30, mf30: cm.mf30, rv30: cm.rv30, vrp30: cm.vrp30, vrpT30: cm.vrpT30,
    rr30: cm.rr30, bf30: cm.bf30, dvol: cm.dvol,
    headline: headline ? { label: headline.label, level: headline.level, p: headline.p } : null,
    medRmse: rmses[Math.floor(rmses.length / 2)],
    bfFails: surface.slices.filter(s => !s.butterfly.arbFree).length,
    calFails: surface.calendar.filter(c => c.violations > 0).length,
  };

  const mesh = surfaceMesh(surface);
  const snapshot = {
    meta: {
      currency: CCY,
      asOf: ctx.chain.asOf,
      asOfIso: new Date(ctx.chain.asOf).toISOString(),
      spot: ctx.chain.spot,
      contracts: ctx.chain.rows.length,
      generated: new Date().toISOString(),
      validation,
    },
    slices: surface.slices.map(s => ({
      label: s.label, dte: s.dte, T: s.T, F: s.F, params: s.params,
      kLo: s.kLo, kHi: s.kHi, nPoints: s.nPoints, nCore: s.nCore, totalOi: s.totalOi,
      atmIv: s.atmIv, rmseVol: s.rmseVol, coreRmseVol: s.coreRmseVol,
      maxAbsVol: s.maxAbsVol, staleQuotes: s.staleQuotes,
      butterfly: s.butterfly, wings: s.wings,
      points: s.points.map(p => ({
        K: p.K, k: p.k, iv: p.iv, type: p.type, oi: p.oi, volume: p.volume, fitIv: p.fitIv,
      })),
    })),
    calendar: surface.calendar,
    mesh: { ks: mesh.ks, rows: mesh.rows.map(({ g, ...r }) => r) },
    skew: skews,
    vrp: vrp.rows,
    vrpStats: vrp.stats,
    vrpSeries: vrp.series.filter(r => r.rvForward != null).map(r => ({
      ts: r.ts, date: r.date, impliedVol: r.impliedVol, rvForward: r.rvForward, vrpPostVolPts: r.vrpPostVolPts,
    })),
    realized: vrp.realized,
    densities,
    headline,
    cm,
    history: [...past, today].slice(-120),
    interpretation: {
      termStructure: readTermStructure(surface),
      skew: readSkew(skews, { rr30: cm.rr30, rrHistory }),
      vrp: readVrp(vrp.rows, vrp.stats, vrp.realized),
      density: headlineRnd ? readDensity(densitySummary(headlineRnd, headline.levels), headlineRnd) : [],
      diagnostics: readDiagnostics(surface),
    },
  };
  snapshot.meta.health = healthCheck(snapshot);

  // A failed run must not become part of the record the percentiles are
  // computed against, so history only grows on a healthy snapshot.
  if (writeHistory && snapshot.meta.health.ok) upsertHistory(HISTORY_FILE, roundDeep(today));

  const rounded = roundDeep(snapshot);
  mkdirSync(OUT, { recursive: true });
  const json = JSON.stringify(rounded);
  writeFileSync(join(OUT, 'snapshot.json'), json);
  out(`\nsnapshot written: out/snapshot.json  (${(json.length / 1024).toFixed(0)} KB)`);
  if (JSON_OUT) console.log(json);
  return rounded;
}

/**
 * The unattended daily run: fetch, calibrate, gate, record, and stage the
 * database writes for the published page.
 *
 * out/db/batch.json is the publish signal: it exists after this command if and
 * only if this run passed the health gate. It is deleted before anything is
 * fetched, so a run that dies halfway — network down, an API format change, a
 * crash — can never leave yesterday's manifest behind to be published again.
 */
async function cmdUpdate() {
  QUIET = true;
  if (existsSync(BATCH_FILE)) unlinkSync(BATCH_FILE);

  const snap = await cmdAll({ writeHistory: true });
  const health = snap.meta.health;
  const built = buildDashboard(ROOT);

  const c = snap.cm, hl = snap.headline;
  console.log(`snapshot ${snap.meta.asOfIso.slice(0, 16)}Z  spot ${Math.round(snap.meta.spot)}`
    + `  ATM30 ${fx(c.atm30 * 100, 1)}%  RR25-30d ${fx(c.rr30)}  VRP30 ${fx(c.vrp30)} (t ${fx(c.vrpT30, 1)})`
    + (hl ? `  Q(>${hl.level / 1000}k, ${hl.label}) ${fx(hl.p * 100, 1)}%` : ''));
  console.log(`dashboard  out/dashboard.html  ${(built.bytes / 1024).toFixed(0)} KB`);
  for (const s of health.soft) console.log(`  note: ${s}`);
  for (const s of health.hard) console.log(`  FAIL: ${s}`);

  if (!health.ok) {
    console.log('HEALTH: FAIL - nothing to publish; the live dashboard keeps the previous data');
    process.exitCode = 1;
    return;
  }

  mkdirSync(DB_DIR, { recursive: true });
  const writes = [];
  for (const [id, body] of Object.entries(dbDocuments(snap))) {
    const json = JSON.stringify(body);
    // The store caps a document at 256 KiB. Fail here, before anything is
    // staged, rather than have one write rejected in the middle of a batch.
    if (json.length > 240 * 1024) {
      console.log(`  FAIL: database document snap/${id} is ${(json.length / 1024).toFixed(0)} KB, over the cap`);
      console.log('HEALTH: FAIL - nothing to publish; the live dashboard keeps the previous data');
      process.exitCode = 1;
      return;
    }
    const file = join(DB_DIR, `snap-${id}.json`);
    writeFileSync(file, json);
    writes.push({ op: 'set', collection: 'snap', doc_id: id, file_path: file });
  }
  // The last week of history rides along on every run, so a day the job
  // missed heals itself the next time it succeeds.
  for (const row of snap.history.slice(-7)) {
    const file = join(DB_DIR, `history-${row.date}.json`);
    writeFileSync(file, JSON.stringify(row));
    writes.push({ op: 'set', collection: 'history', doc_id: row.date, file_path: file });
  }
  writeFileSync(BATCH_FILE, JSON.stringify(writes, null, 2));
  console.log(`HEALTH: OK - ${writes.length} writes staged in ${BATCH_FILE}`);
}

const commands = {
  validate: cmdValidate, surface: cmdSurface, skew: cmdSkew, vrp: cmdVrp, rnd: cmdRnd,
  all: () => cmdAll(), update: cmdUpdate,
};
const fn = commands[cmd];
if (!fn) {
  console.error(`Unknown command "${cmd}". Use one of: ${Object.keys(commands).join(', ')}`);
  process.exit(1);
}
try {
  await fn();
} catch (e) {
  console.error(`ERROR: ${e && e.message ? e.message : e}`);
  if (cmd === 'update') console.log('HEALTH: FAIL - run aborted before completion; nothing to publish');
  process.exitCode = 1;
}
