// Breeden-Litzenberger (1978): the risk-neutral density is the second
// derivative of the call price with respect to strike,
//
//     q(K) = e^{rT} * d2C/dK2
//
// and the digital, i.e. the probability of finishing above a level, is the
// first derivative,
//
//     Q(S_T > X) = -e^{rT} * dC/dK |_{K=X}
//
// Both are exact, not approximations. The practical difficulty is that
// differentiating twice amplifies noise brutally: applied to raw quotes on a
// discrete strike grid it produces a jagged, partly negative "density". We
// therefore differentiate the CALIBRATED SVI call price, which is smooth by
// construction and, once butterflyCheck() passes, guaranteed non-negative.
// That check is a precondition for this module, not a nicety.

import { price } from './black76.js';
import { sviIv } from './svi.js';
import { linspace, cumTrapz, simpson, interp } from './math.js';

function callAt(slice, K) {
  const { params, T, F, r } = slice;
  return price(F, K, T, sviIv(params, Math.log(K / F), T), r, 'call');
}

/**
 * Risk-neutral density on a uniform strike grid.
 *
 * The grid is uniform in K (not log K) so that the central second difference
 * is second-order accurate without a non-uniform correction term. Its width
 * scales with the slice's own total variance, so a half-day expiry gets a tight
 * grid around the forward and a nine-month expiry a wide one.
 */
export function riskNeutralDensity(slice, { nStd = 8, n = 4001 } = {}) {
  const { T, F, r } = slice;
  const sd = Math.sqrt(Math.max(sviIv(slice.params, 0, T) ** 2 * T, 1e-12));
  const lo = Math.max(F * Math.exp(-nStd * sd), 1e-6);
  const hi = F * Math.exp(nStd * sd);
  const Ks = linspace(lo, hi, n);
  const h = Ks[1] - Ks[0];
  const C = Ks.map(K => callAt(slice, K));

  const df = Math.exp(r * T);
  const q = new Array(n).fill(0);
  const digital = new Array(n).fill(0);   // Q(S_T > K)
  for (let i = 1; i < n - 1; i++) {
    q[i] = df * (C[i + 1] - 2 * C[i] + C[i - 1]) / (h * h);
    digital[i] = -df * (C[i + 1] - C[i - 1]) / (2 * h);
  }
  q[0] = q[1]; q[n - 1] = q[n - 2];
  digital[0] = 1; digital[n - 1] = 0;
  for (let i = 0; i < n; i++) {
    if (q[i] < 0) q[i] = 0;                       // numerical dust only
    digital[i] = Math.min(Math.max(digital[i], 0), 1);
  }

  // Diagnostics. A density that does not integrate to one, or whose mean is not
  // the forward, means the grid truncated real probability mass or the slice is
  // mis-calibrated. Both are reported rather than silently normalised away.
  const mass = simpson(q, h);
  const meanK = simpson(q.map((v, i) => v * Ks[i]), h);
  const cdf = cumTrapz(q, h);

  const moment = p => simpson(q.map((v, i) => v * (Ks[i] - meanK) ** p), h);
  const var2 = moment(2);
  const sdK = Math.sqrt(Math.max(var2, 0));

  // Share of probability sitting outside the strike range actually quoted.
  // Inside that range the density reads the market; outside it reads SVI's
  // linear-in-variance wing extrapolation, which is a model, not a price.
  const kLoK = F * Math.exp(slice.kLo), kHiK = F * Math.exp(slice.kHi);
  const extrapMass = 1 - (interp(Ks, cdf, kHiK) - interp(Ks, cdf, kLoK)) / Math.max(mass, 1e-12);

  return {
    label: slice.label,
    T, F, r,
    dte: slice.dte,
    Ks, q, cdf, digital, h,
    diagnostics: {
      mass,                                    // target 1
      massError: mass - 1,
      meanK,                                   // target F (forward is a Q-martingale)
      meanErrorBp: (meanK / F - 1) * 1e4,
      sd: sdK,
      skew: var2 > 0 ? moment(3) / var2 ** 1.5 : null,
      excessKurtosis: var2 > 0 ? moment(4) / var2 ** 2 - 3 : null,
      extrapolatedMass: extrapMass,
      quotedRange: [kLoK, kHiK],
      gridRange: [lo, hi],
    },
  };
}

/** Q(S_T > X), read off the digital rather than by re-integrating the density. */
export function probAbove(rnd, X) {
  if (X <= rnd.Ks[0]) return 1;
  if (X >= rnd.Ks[rnd.Ks.length - 1]) return 0;
  return interp(rnd.Ks, rnd.digital, X);
}

export function probBelow(rnd, X) { return 1 - probAbove(rnd, X); }

export function probBetween(rnd, lo, hi) {
  return Math.max(0, probAbove(rnd, lo) - probAbove(rnd, hi));
}

/** Strike at a given cumulative probability, from the normalised CDF. */
export function quantile(rnd, p) {
  const { Ks, cdf } = rnd;
  const total = cdf[cdf.length - 1];
  const target = p * total;
  let lo = 0, hi = cdf.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cdf[mid] <= target) lo = mid; else hi = mid;
  }
  const span = cdf[hi] - cdf[lo];
  const t = span > 0 ? (target - cdf[lo]) / span : 0;
  return Ks[lo] + t * (Ks[hi] - Ks[lo]);
}

/**
 * Round price levels around a forward, from 0.6F to 2F. Relative to the
 * forward rather than fixed, so the ladder stays informative when the price
 * moves: a fixed $100k rung reads 100% or 0% after a large enough move.
 */
export const roundStep = F => (F < 20000 ? 1000 : F < 50000 ? 5000 : F < 200000 ? 10000 : 25000);

export function niceLevels(F, extra = []) {
  const step = roundStep(F);
  const set = new Set([0.6, 0.75, 0.9, 1.0, 1.25, 1.5, 2.0].map(r => Math.round(F * r / step) * step));
  for (const x of extra) set.add(x);
  return [...set].filter(x => x > 0).sort((a, b) => a - b);
}

/** The headline read: probabilities on round levels plus the distribution shape. */
export function densitySummary(rnd, levels = null) {
  const F = rnd.F;
  const auto = levels || niceLevels(F);

  return {
    label: rnd.label,
    dte: rnd.dte,
    F,
    levels: auto.map(X => ({ level: X, probAbove: probAbove(rnd, X) })),
    quantiles: {
      p05: quantile(rnd, 0.05),
      p25: quantile(rnd, 0.25),
      p50: quantile(rnd, 0.50),
      p75: quantile(rnd, 0.75),
      p95: quantile(rnd, 0.95),
    },
    diagnostics: rnd.diagnostics,
  };
}
