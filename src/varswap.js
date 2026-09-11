// Variance risk premium: what the market charges for variance, against what
// variance actually turns out to be.
//
// The implied leg is the fair strike of a variance swap, not ATM implied vol.
// Those differ by the convexity of the smile, and on BTC the gap is several
// vol points, so using ATM here would understate the premium systematically.
// The fair strike comes from the log-contract replication (Neuberger 1994;
// Carr & Madan 1998; Demeterfi et al. 1999):
//
//     E^Q[ (1/T) integral sigma_t^2 dt ]
//        = (2/T) * e^{rT} * [ int_0^F P(K)/K^2 dK + int_F^inf C(K)/K^2 dK ]
//
// In log-moneyness k = ln(K/F) this collapses to a single integral, since
// dK = K dk:
//
//     = (2/T) * e^{rT} * int_{-inf}^{inf} O(F e^k) / (F e^k) dk
//
// with O the out-of-the-money option at that strike. We evaluate O off the
// fitted SVI slice rather than off raw quotes, so the integrand is smooth and
// defined at every strike instead of only on the listed grid.

import { price } from './black76.js';
import { sviIv } from './svi.js';
import { linspace, simpson } from './math.js';

const ANNUAL = 365; // crypto trades continuously; 252 would understate by ~20%

/** OTM option value in USD at log-moneyness k, off the fitted smile. */
function otmPrice(slice, k) {
  const { params, T, F, r } = slice;
  const K = F * Math.exp(k);
  const iv = sviIv(params, k, T);
  return price(F, K, T, iv, r, k >= 0 ? 'call' : 'put');
}

/**
 * Fair variance swap strike from a fitted slice.
 * @returns annualised variance, its square root (the "model-free implied vol"),
 *          and a truncation diagnostic.
 */
export function modelFreeVariance(slice, { nStd = 8, n = 2001 } = {}) {
  const { T, F, r } = slice;
  const wAtm = sviIv(slice.params, 0, T) ** 2 * T;
  const halfWidth = Math.max(1.2, nStd * Math.sqrt(Math.max(wAtm, 1e-12)));

  const integrate = (hw, pts) => {
    const ks = linspace(-hw, hw, pts);
    const ys = ks.map(k => otmPrice(slice, k) / (F * Math.exp(k)));
    return 2 / T * Math.exp(r * T) * simpson(ys, ks[1] - ks[0]);
  };

  const v = integrate(halfWidth, n);
  // Widening the domain by 40% must not move the answer; if it does, the wings
  // still carry mass and the number is truncated rather than converged.
  const vWide = integrate(halfWidth * 1.4, n);

  return {
    variance: v,
    vol: Math.sqrt(Math.max(v, 0)),
    halfWidth,
    truncationVolPts: (Math.sqrt(Math.max(vWide, 0)) - Math.sqrt(Math.max(v, 0))) * 100,
  };
}

/**
 * The literal CBOE/VIX discrete sum over listed OTM strikes, for cross-check.
 * It is the same estimator the exchange publishes DVOL from, so agreement
 * between this, the smile integral, and DVOL is a three-way validation that
 * the surface is not quietly wrong.
 */
export function cboeVariance(slice, chainRows) {
  const rows = chainRows.filter(o => o.expiryLabel === slice.label);
  const { T, F, r } = slice;
  const byStrike = new Map();
  for (const o of rows) {
    if (!byStrike.has(o.K)) byStrike.set(o.K, {});
    byStrike.get(o.K)[o.type] = o;
  }
  const strikes = [...byStrike.keys()].sort((a, b) => a - b);
  if (strikes.length < 3) return null;

  // K0: highest strike at or below the forward.
  let K0 = strikes[0];
  for (const K of strikes) if (K <= F) K0 = K;

  let sum = 0;
  for (let i = 0; i < strikes.length; i++) {
    const K = strikes[i];
    const pair = byStrike.get(K);
    let q;
    if (K < K0) q = pair.put ? pair.put.priceUsd : null;
    else if (K > K0) q = pair.call ? pair.call.priceUsd : null;
    else q = pair.put && pair.call ? (pair.put.priceUsd + pair.call.priceUsd) / 2 : null;
    if (q == null) continue;
    const dK = i === 0 ? strikes[1] - strikes[0]
      : i === strikes.length - 1 ? strikes[i] - strikes[i - 1]
      : (strikes[i + 1] - strikes[i - 1]) / 2;
    sum += dK / (K * K) * Math.exp(r * T) * q;
  }
  const variance = 2 / T * sum - (1 / T) * (F / K0 - 1) ** 2;
  return { variance, vol: Math.sqrt(Math.max(variance, 0)), K0, nStrikes: strikes.length };
}

// ---------------------------------------------------------------------------
// Realized variance estimators. All annualised at 365.
// ---------------------------------------------------------------------------

export function logReturns(bars) {
  const out = [];
  for (let i = 1; i < bars.length; i++) out.push(Math.log(bars[i].close / bars[i - 1].close));
  return out;
}

/**
 * Close-to-close. This is the primary estimator because it is the payoff a
 * variance swap actually settles on; the range-based estimators below are more
 * statistically efficient but measure a slightly different quantity.
 * Zero-mean convention (no drift subtraction), matching swap documentation.
 */
export function realizedCloseToClose(bars) {
  const r = logReturns(bars);
  if (r.length < 2) return null;
  const variance = ANNUAL / r.length * r.reduce((s, x) => s + x * x, 0);
  return { variance, vol: Math.sqrt(variance), n: r.length };
}

/** Parkinson (1980), high-low range. ~5x the efficiency of close-to-close. */
export function realizedParkinson(bars) {
  const n = bars.length;
  if (n < 2) return null;
  const s = bars.reduce((acc, b) => acc + Math.log(b.high / b.low) ** 2, 0);
  const variance = ANNUAL / (4 * Math.log(2) * n) * s;
  return { variance, vol: Math.sqrt(variance), n };
}

/** Garman-Klass (1980), uses the full OHLC bar. */
export function realizedGarmanKlass(bars) {
  const n = bars.length;
  if (n < 2) return null;
  let s = 0;
  for (const b of bars) {
    s += 0.5 * Math.log(b.high / b.low) ** 2
       - (2 * Math.log(2) - 1) * Math.log(b.close / b.open) ** 2;
  }
  const variance = ANNUAL / n * s;
  return { variance, vol: Math.sqrt(Math.max(variance, 0)), n };
}

/**
 * Yang-Zhang (2000): drift-independent and handles overnight gaps, which for a
 * 24/7 market means the daily-bar boundary rather than a true session gap.
 */
export function realizedYangZhang(bars) {
  const n = bars.length;
  if (n < 3) return null;
  const o = [], c = [], rs = [];
  for (let i = 1; i < n; i++) {
    const b = bars[i], prev = bars[i - 1];
    o.push(Math.log(b.open / prev.close));
    c.push(Math.log(b.close / b.open));
    rs.push(Math.log(b.high / b.close) * Math.log(b.high / b.open)
          + Math.log(b.low / b.close) * Math.log(b.low / b.open));
  }
  const m = o.length;
  const varOf = arr => {
    const mu = arr.reduce((s, x) => s + x, 0) / arr.length;
    return arr.reduce((s, x) => s + (x - mu) ** 2, 0) / (arr.length - 1);
  };
  const vo = varOf(o), vc = varOf(c);
  const vrs = rs.reduce((s, x) => s + x, 0) / m;
  const k = 0.34 / (1.34 + (m + 1) / (m - 1));
  const variance = ANNUAL * (vo + k * vc + (1 - k) * vrs);
  return { variance, vol: Math.sqrt(Math.max(variance, 0)), n: m };
}

export function realizedAll(bars) {
  return {
    closeToClose: realizedCloseToClose(bars),
    parkinson: realizedParkinson(bars),
    garmanKlass: realizedGarmanKlass(bars),
    yangZhang: realizedYangZhang(bars),
  };
}

// ---------------------------------------------------------------------------
// Variance risk premium
// ---------------------------------------------------------------------------

/**
 * VRP per expiry, implied against TRAILING realized variance over a window
 * matched to the option's tenor.
 *
 * Caveat, stated because it decides how the number may be used: the variance
 * swap pays on variance realized over [t, t+T], and trailing realized variance
 * is only a proxy for that. This is the number an observer can compute live;
 * it is not the premium the trade earned. For the realized premium see
 * expostVrpSeries(), which waits for the outcome.
 */
export function vrpByExpiry(surface, bars, chainRows = null) {
  return surface.slices.map(s => {
    const mf = modelFreeVariance(s);
    const win = Math.max(5, Math.min(Math.round(s.dte), bars.length - 1));
    const rv = realizedCloseToClose(bars.slice(-win - 1));
    const cboe = chainRows ? cboeVariance(s, chainRows) : null;

    // Sampling error of the realized leg. For iid returns the variance
    // estimator has relative standard error sqrt(2/n), so the volatility
    // estimator has SE(sigma) ~ sigma/sqrt(2n). At a 5-day window that is
    // roughly a third of the estimate, which means a large short-tenor VRP can
    // be entirely an artefact of measuring realized vol over five returns.
    // Reporting the premium without this number invites exactly that mistake.
    const rvSeVolPts = rv ? rv.vol / Math.sqrt(2 * rv.n) * 100 : null;
    const vrpVolPts = rv ? (mf.vol - rv.vol) * 100 : null;

    return {
      label: s.label,
      dte: s.dte,
      T: s.T,
      atmIv: s.atmIv,
      mfIv: mf.vol,
      mfTruncationVolPts: mf.truncationVolPts,
      cboeIv: cboe ? cboe.vol : null,
      // Convexity premium: how much the whole smile adds over the ATM vol.
      smilePremiumVolPts: (mf.vol - s.atmIv) * 100,
      rvWindowDays: win,
      rv: rv ? rv.vol : null,
      rvSeVolPts,
      vrpVariance: rv ? mf.variance - rv.variance : null,
      vrpVolPts,
      // Premium expressed in standard errors of the realized leg. Below ~2 the
      // measurement cannot distinguish a premium from a quiet sample.
      vrpTStat: vrpVolPts != null && rvSeVolPts ? vrpVolPts / rvSeVolPts : null,
    };
  });
}

/**
 * Ex-post variance risk premium: DVOL observed on day t, against the variance
 * actually realized over the following `horizon` days. This is the premium the
 * variance seller was paid, and the only version of the series that measures
 * an edge rather than an observation.
 */
export function expostVrpSeries(dvol, bars, horizon = 30) {
  const closes = new Map(bars.map(b => [new Date(b.ts).toISOString().slice(0, 10), b]));
  const dates = bars.map(b => new Date(b.ts).toISOString().slice(0, 10));
  const idx = new Map(dates.map((d, i) => [d, i]));

  const out = [];
  for (const d of dvol) {
    const day = new Date(d.ts).toISOString().slice(0, 10);
    const i = idx.get(day);
    if (i == null) continue;
    const impliedVol = d.close / 100;
    const fwd = bars.slice(i, i + horizon + 1);
    const trailing = bars.slice(Math.max(0, i - horizon), i + 1);
    const rvFwd = fwd.length > horizon * 0.8 ? realizedCloseToClose(fwd) : null;
    const rvTrail = trailing.length > 5 ? realizedCloseToClose(trailing) : null;
    out.push({
      ts: d.ts,
      date: day,
      dvol: d.close,
      impliedVol,
      rvForward: rvFwd ? rvFwd.vol : null,
      rvTrailing: rvTrail ? rvTrail.vol : null,
      // Ex-ante: what you could see at the time.
      vrpAnteVolPts: rvTrail ? (impliedVol - rvTrail.vol) * 100 : null,
      // Ex-post: what selling variance that day actually earned.
      vrpPostVolPts: rvFwd ? (impliedVol - rvFwd.vol) * 100 : null,
      vrpPostVariance: rvFwd ? impliedVol ** 2 - rvFwd.variance : null,
    });
  }
  return out;
}

/**
 * Summary statistics of the ex-post premium: level, hit rate, dispersion.
 *
 * The windows overlap by construction — consecutive observations share 29 of
 * 30 days — so the series is heavily autocorrelated and its nominal length
 * badly overstates the evidence. effectiveN below divides by the horizon to
 * give the count of non-overlapping windows, which is the number any
 * significance claim has to be built on. A naive standard error computed from
 * the nominal n would be too small by roughly sqrt(horizon).
 */
export function vrpStats(series, horizon = 30) {
  const post = series.map(s => s.vrpPostVolPts).filter(v => v != null);
  const ante = series.map(s => s.vrpAnteVolPts).filter(v => v != null);
  const stat = arr => {
    if (!arr.length) return null;
    const mu = arr.reduce((s, x) => s + x, 0) / arr.length;
    const sd = Math.sqrt(arr.reduce((s, x) => s + (x - mu) ** 2, 0) / Math.max(arr.length - 1, 1));
    const sorted = [...arr].sort((a, b) => a - b);
    const effN = Math.max(1, arr.length / horizon);
    return {
      n: arr.length,
      effectiveN: effN,
      // Standard error on the effective, not the nominal, sample size.
      seMean: sd / Math.sqrt(effN),
      tStat: mu / (sd / Math.sqrt(effN)),
      mean: mu,
      median: sorted[Math.floor(sorted.length / 2)],
      sd,
      hitRate: arr.filter(x => x > 0).length / arr.length,
      p05: sorted[Math.floor(sorted.length * 0.05)],
      p95: sorted[Math.floor(sorted.length * 0.95)],
      min: sorted[0],
      max: sorted[sorted.length - 1],
    };
  };
  return { expost: stat(post), exante: stat(ante) };
}
