// Builds the full implied-volatility surface: one SVI slice per listed expiry,
// plus arbitrage diagnostics across slices and an interpolator in maturity.

import { vega } from './black76.js';
import { fitSlice, sviW, sviIv, butterflyCheck, wingSlopes, durrleman } from './svi.js';
import { linspace } from './math.js';

const MIN_TICKS = 2;      // marks below two ticks carry no vol information
const MIN_POINTS = 6;     // an SVI slice has five free parameters

/**
 * Fit weights, in total-variance space (the inner SVI problem is only linear
 * there). Two effects are combined:
 *
 * 1. Jacobian. dSigma = dw / (2*sigma*T), so weighting by 1/(2*sigma*T)^2
 *    turns a least-squares fit on w into a least-squares fit in VOL POINTS.
 *    That makes the reported RMSE directly comparable to the bid-ask width,
 *    which is the number a trader judges a surface by.
 *
 * 2. Liquidity tilt, as sqrt(vega/max vega) floored at 0.05. Full price-error
 *    weighting would be (vega/(2*sigma*T))^2, but vega collapses so fast that
 *    at half a day to expiry roughly two strikes end up carrying the entire
 *    objective against five free parameters — the wings then float free, and
 *    the wings are exactly what the risk-neutral density in rnd.js reads. The
 *    square root keeps illiquid wings from dominating without erasing them.
 */
function fitWeights(pts) {
  const vegas = pts.map(o => vega(o.F, o.K, o.T, o.iv, o.r));
  const mxV = Math.max(...vegas);
  return pts.map((o, i) => {
    const jac = 1 / (2 * o.iv * o.T) ** 2;
    const liq = Math.max(Math.sqrt(vegas[i] / mxV), 0.05);
    return jac * liq;
  });
}

export function buildSurface(chain) {
  const labels = [...new Set(chain.rows.map(r => r.expiryLabel))];
  const slices = [];

  for (const label of labels) {
    const all = chain.rows.filter(r => r.expiryLabel === label);
    // Expressed against the instrument's own tick in dollars, so the filter
    // means the same thing for an inverse bitcoin option quoted in coin and a
    // linear altcoin option quoted in USDC.
    const pts = all.filter(o => o.isOtm && o.priceUsd >= MIN_TICKS * (o.tickUsd || 1e-4 * o.F)
                             && o.iv > 0.01 && o.iv < 6);
    if (pts.length < MIN_POINTS) continue;

    const ks = pts.map(o => o.k);
    const ws = pts.map(o => o.w);
    const vs = fitWeights(pts);
    const { params } = fitSlice(ks, ws, vs);

    const T = pts[0].T;
    // Residuals reported in vol points: the unit a trader can compare to spread.
    const resid = pts.map(o => (sviIv(params, o.k, T) - o.iv) * 100);
    const rmse = Math.sqrt(resid.reduce((s, e) => s + e * e, 0) / resid.length);
    const maxAbs = Math.max(...resid.map(Math.abs));

    // A single SVI hyperbola cannot bend enough to hold both a steep left wing
    // and a right wing still climbing at k = +1.1, and the strikes out there
    // are typically untraded marks rather than live prices. Reporting only the
    // all-strike RMSE would blame the fit for stale data, so we also report the
    // core region, which is where essentially all the vega actually sits.
    const core = pts.map((o, i) => ({ k: o.k, e: resid[i] })).filter(x => Math.abs(x.k) <= 0.5);
    const coreRmse = core.length
      ? Math.sqrt(core.reduce((s, x) => s + x.e * x.e, 0) / core.length) : rmse;
    const stale = pts.filter(o => !o.volume).length;

    const kLo = Math.min(...ks), kHi = Math.max(...ks);
    const bf = butterflyCheck(params, kLo, kHi, 801);

    slices.push({
      label,
      expiryTs: pts[0].expiryTs,
      T,
      dte: pts[0].dte,
      F: pts[0].F,
      r: pts[0].r,
      params,
      kLo,
      kHi,
      nPoints: pts.length,
      nAll: all.length,
      totalOi: all.reduce((s, o) => s + (o.oi || 0), 0),
      rmseVol: rmse,
      coreRmseVol: coreRmse,
      nCore: core.length,
      maxAbsVol: maxAbs,
      staleQuotes: stale,
      atmIv: sviIv(params, 0, T),
      butterfly: bf,
      wings: wingSlopes(params),
      points: pts.map(o => ({
        K: o.K, k: o.k, iv: o.iv, type: o.type, oi: o.oi, volume: o.volume,
        priceUsd: o.priceUsd, fitIv: sviIv(params, o.k, T),
      })),
    });
  }

  slices.sort((a, b) => a.T - b.T);
  return {
    asOf: chain.asOf,
    currency: chain.currency,
    spot: chain.spot,
    slices,
    calendar: calendarViolations(slices),
  };
}

/**
 * Calendar-spread arbitrage: total variance must be non-decreasing in maturity
 * at fixed log-moneyness. A violation means a shorter-dated option is priced
 * above a longer-dated one on the same strike, which is a free lunch and also
 * breaks the maturity interpolation below.
 */
export function calendarViolations(slices) {
  const out = [];
  for (let i = 0; i + 1 < slices.length; i++) {
    const A = slices[i], B = slices[i + 1];
    const lo = Math.max(A.kLo, B.kLo), hi = Math.min(A.kHi, B.kHi);
    if (!(hi > lo)) continue;
    let worst = 0, worstK = 0, bad = 0;
    const grid = linspace(lo, hi, 201);
    for (const k of grid) {
      const gap = sviW(B.params, k) - sviW(A.params, k);
      if (gap < 0) { bad++; if (-gap > worst) { worst = -gap; worstK = k; } }
    }
    out.push({
      from: A.label, to: B.label,
      violations: bad, gridPoints: grid.length,
      worstVarianceGap: worst, atK: worstK,
      // Same violation expressed in vol points on the longer expiry.
      worstVolPts: worst > 0
        ? (Math.sqrt(sviW(A.params, worstK) / B.T) - Math.sqrt(sviW(B.params, worstK) / B.T)) * 100
        : 0,
    });
  }
  return out;
}

/** Total variance at arbitrary (k, T), linear in T between fitted slices. */
export function surfaceW(surface, k, T) {
  const s = surface.slices;
  if (!s.length) return NaN;
  if (T <= s[0].T) return sviW(s[0].params, k) * (T / s[0].T);
  const last = s[s.length - 1];
  if (T >= last.T) return sviW(last.params, k) * (T / last.T);
  let i = 0;
  while (i + 1 < s.length && s[i + 1].T < T) i++;
  const A = s[i], B = s[i + 1];
  const t = (T - A.T) / (B.T - A.T);
  return sviW(A.params, k) * (1 - t) + sviW(B.params, k) * t;
}

export function surfaceIv(surface, k, T) {
  return Math.sqrt(Math.max(surfaceW(surface, k, T), 1e-12) / T);
}

/**
 * Dense mesh for plotting. Returned in log-moneyness so slices with wildly
 * different strike ranges stay comparable, with strikes attached for labels.
 */
export function surfaceMesh(surface, { nK = 61, kLo = -0.9, kHi = 0.9 } = {}) {
  const ks = linspace(kLo, kHi, nK);
  return {
    ks,
    rows: surface.slices.map(s => ({
      label: s.label,
      T: s.T,
      dte: s.dte,
      F: s.F,
      inRange: ks.map(k => k >= s.kLo && k <= s.kHi),
      iv: ks.map(k => sviIv(s.params, k, s.T)),
      strikes: ks.map(k => s.F * Math.exp(k)),
      g: ks.map(k => durrleman(s.params, k)),
    })),
  };
}
