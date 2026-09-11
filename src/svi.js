// SVI (Stochastic Volatility Inspired, Gatheral 2004) calibration of a single
// expiry slice, in raw parametrisation on total implied variance:
//
//     w(k) = a + b * ( rho*(k - m) + sqrt((k - m)^2 + sig^2) )
//
// with k = log(K/F) and w = sigma_impl^2 * T.
//
// Calibration follows the quasi-explicit method of Zeliade Systems (2009):
// for fixed (m, sig) the substitution y = (k - m)/sig makes the problem linear
// in (a, d, c) with d = rho*b*sig and c = b*sig, so the inner problem is a
// small constrained least squares solved in closed form, and only the outer
// 2-D problem in (m, sig) needs a simplex search. Fitting all five parameters
// with a generic optimiser is what produces the unstable, wing-flapping SVI
// fits people complain about.
//
// No-arbitrage is verified after the fit rather than assumed: see
// durrleman() for the butterfly condition and calendarViolations() in
// surface.js for the term-structure condition.

import { nelderMead, solve, linspace } from './math.js';

/** Total variance under a raw-SVI parameter set. */
export function sviW(p, k) {
  const u = k - p.m;
  return p.a + p.b * (p.rho * u + Math.sqrt(u * u + p.sig * p.sig));
}

/** dw/dk. */
export function sviW1(p, k) {
  const u = k - p.m;
  const s = Math.sqrt(u * u + p.sig * p.sig);
  return p.b * (p.rho + u / s);
}

/** d2w/dk2. Always positive, so a raw-SVI slice is convex in k by construction. */
export function sviW2(p, k) {
  const u = k - p.m;
  const s = Math.sqrt(u * u + p.sig * p.sig);
  return p.b * p.sig * p.sig / (s * s * s);
}

/** Implied volatility at log-moneyness k for maturity T. */
export function sviIv(p, k, T) {
  return Math.sqrt(Math.max(sviW(p, k), 1e-12) / T);
}

/**
 * Durrleman's function. A slice is free of butterfly arbitrage iff g(k) >= 0
 * for every k (Gatheral & Jacquier 2014, Lemma 2.2). g < 0 means the implied
 * risk-neutral density is negative somewhere, which would make the
 * Breeden-Litzenberger density in rnd.js meaningless over that region.
 */
export function durrleman(p, k) {
  const w = sviW(p, k), w1 = sviW1(p, k), w2 = sviW2(p, k);
  const t1 = (1 - k * w1 / (2 * w)) ** 2;
  const t2 = (w1 * w1 / 4) * (1 / w + 0.25);
  return t1 - t2 + w2 / 2;
}

/** Asymptotic wing slopes. Roger Lee's moment formula requires both <= 2. */
export function wingSlopes(p) {
  return { left: p.b * (1 - p.rho), right: p.b * (1 + p.rho) };
}

/**
 * Inner problem: closed-form weighted least squares in (a, d, c) for fixed
 * (m, sig), then projection onto the domain
 *     0 <= c <= S*sig,  |d| <= c,  |d| <= S*sig - c,  0 <= a <= max(w)
 * which enforces b >= 0, |rho| <= 1 and wing slopes b*(1 +/- rho) <= S.
 *
 * S is passed in rather than fixed at Zeliade's 4 because the caller
 * calibrates on total variance normalised to max(w) = 1. A constant bound
 * would then mean b_real <= S*max(w), which is a bound in whatever units w
 * happens to carry: harmless at nine months, crippling at half a day, where
 * max(w) ~ 2.5e-4 and a perfectly ordinary smile needs b_real ~ 4e-3. The
 * caller therefore sets S from Roger Lee's moment formula, which bounds wing
 * growth of total variance at 2 in real units, independent of maturity.
 */
function innerFit(ys, ws, vs, sig, maxW, slopeMax) {
  const n = ys.length;
  const zs = ys.map(y => Math.sqrt(y * y + 1));
  // Normal equations for basis [1, y, z] under weights vs.
  const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const rhs = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const phi = [1, ys[i], zs[i]], v = vs[i];
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) A[r][c] += v * phi[r] * phi[c];
      rhs[r] += v * phi[r] * ws[i];
    }
  }
  // Tikhonov ridge. As sig shrinks, y blows up and [y] and [z] become
  // collinear, so the unregularised system is numerically singular.
  const ridge = 1e-12 * (A[0][0] + A[1][1] + A[2][2]);
  for (let r = 0; r < 3; r++) A[r][r] += ridge;

  let sol = solve(A, rhs);
  // A degenerate inner problem must be expensive, not cheap: returning a
  // plausible-looking fallback here lets the outer simplex converge straight
  // into the singular region and report a meaningless fit.
  if (!sol || sol.some(x => !Number.isFinite(x))) {
    return { abc: [maxW / 2, 0, sig], sse: Infinity };
  }

  const sse = ([a, d, c]) => {
    let s = 0;
    for (let i = 0; i < n; i++) {
      const e = a + d * ys[i] + c * zs[i] - ws[i];
      s += vs[i] * e * e;
    }
    return s;
  };
  const feasible = ([a, d, c]) =>
    c >= -1e-12 && c <= slopeMax * sig + 1e-12 &&
    Math.abs(d) <= c + 1e-12 && Math.abs(d) <= slopeMax * sig - c + 1e-12 &&
    a >= -1e-12 && a <= maxW + 1e-12;

  if (!feasible(sol)) {
    // Clip to the box, then refine inside the polytope with a penalised simplex.
    const clip = [
      Math.min(Math.max(sol[0], 0), maxW),
      sol[1],
      Math.min(Math.max(sol[2], 0), slopeMax * sig),
    ];
    clip[1] = Math.min(Math.max(clip[1], -Math.min(clip[2], slopeMax * sig - clip[2])),
                       Math.min(clip[2], slopeMax * sig - clip[2]));
    const pen = x => {
      let p = 0;
      const [a, d, c] = x;
      p += Math.max(0, -c) + Math.max(0, c - slopeMax * sig);
      p += Math.max(0, Math.abs(d) - c) + Math.max(0, Math.abs(d) - (slopeMax * sig - c));
      p += Math.max(0, -a) + Math.max(0, a - maxW);
      return sse(x) + 1e6 * p * p;
    };
    sol = nelderMead(pen, clip, { maxIter: 800, step: 0.2 }).x;
    sol = [
      Math.min(Math.max(sol[0], 0), maxW),
      sol[1],
      Math.min(Math.max(sol[2], 0), slopeMax * sig),
    ];
    sol[1] = Math.min(Math.max(sol[1], -Math.min(sol[2], slopeMax * sig - sol[2])),
                      Math.min(sol[2], slopeMax * sig - sol[2]));
  }
  return { abc: sol, sse: sse(sol) };
}

/**
 * Calibrate one expiry.
 * @param {number[]} ks  log-moneyness
 * @param {number[]} ws  market total variance
 * @param {number[]} vs  fit weights (see surface.js: vega mapped into w-space)
 */
export function fitSlice(ks, ws, vs) {
  // Total variance spans three orders of magnitude across the board: ~5e-4 for
  // a half-day expiry, ~0.15 at nine months. Calibrating on raw w wrecks the
  // conditioning of the inner system at the short end AND makes the domain
  // bound c <= 4*sig meaningless, since it is a bound on the wing slope in
  // whatever units w happens to carry. Normalising to max(w) = 1 fixes both.
  // Under w -> w/W0 the parameters scale as a -> a/W0, b -> b/W0, while
  // rho, m and sig are dimensionless in w and carry through unchanged.
  const W0 = Math.max(...ws);
  const wn = ws.map(w => w / W0);
  const kSpan = Math.max(...ks) - Math.min(...ks);

  // Roger Lee's moment formula caps the growth of total variance in the wings
  // at 2|k| in REAL units. Expressed against normalised variance that becomes
  // 2/W0, which is loose at long maturities and correctly permissive at short
  // ones, where the smile is steep relative to its own variance level.
  const slopeMax = 2 / W0;

  // sig sets the width of the smile's curved region and must scale with the
  // strike span actually quoted: a half-day slice lives inside |k| < 0.03, so
  // a floor tuned for a nine-month slice would smooth its entire smile away.
  const SIG_LO = Math.max(1e-3, 0.005 * kSpan);
  const SIG_HI = Math.max(2, 10 * kSpan);
  const clampSig = s => Math.min(Math.max(s, SIG_LO), SIG_HI);

  const objective = ([m, logSig]) => {
    const sig = Math.exp(logSig);
    if (!Number.isFinite(sig) || sig < SIG_LO || sig > SIG_HI) return 1e12;
    if (!Number.isFinite(m) || Math.abs(m) > 5 * kSpan + 1) return 1e12;
    const ys = ks.map(k => (k - m) / sig);
    const sse = innerFit(ys, wn, vs, sig, 1, slopeMax).sse;
    return Number.isFinite(sse) ? sse : 1e12;
  };

  // Multi-start: SVI has local minima, and a bad basin shows up as a smile
  // that fits the body but hinges wildly in the wings. Seeds are placed
  // relative to the observed span, not on absolute constants.
  const kMid = (Math.max(...ks) + Math.min(...ks)) / 2;
  let best = null;
  for (const f of [-0.4, -0.15, 0, 0.15, 0.4]) {
    const m0 = kMid + f * kSpan;
    for (const s0 of [0.03, 0.1, 0.25, 0.6, 1.2]) {
      const seed = clampSig(s0 * kSpan);
      const res = nelderMead(objective, [m0, Math.log(seed)], { maxIter: 1500, step: 0.25 });
      if (!best || res.fx < best.fx) best = res;
    }
  }

  // The simplex can terminate on a vertex the objective rejected (every
  // rejected point scores the same 1e12, so there is nothing to descend).
  // Clamp before the final solve so the returned parameters are always drawn
  // from the feasible set the search was actually scored on.
  const m = best.x[0], sig = clampSig(Math.exp(best.x[1]));
  const ys = ks.map(k => (k - m) / sig);
  const { abc } = innerFit(ys, wn, vs, sig, 1, slopeMax);
  const [a, d, c] = abc;
  const b = c / sig;
  const rho = c > 1e-12 ? d / c : 0;
  // Undo the normalisation: a and b carry the units of total variance.
  const p = { a: a * W0, b: b * W0, rho, m, sig };

  return { params: p, resid: ks.map((k, i) => sviW(p, k) - ws[i]), sse: best.fx };
}

/** Minimum of Durrleman's g over a dense grid, plus where it occurs. */
export function butterflyCheck(p, kLo = -1.5, kHi = 1.5, n = 601) {
  const grid = linspace(kLo, kHi, n);
  let min = Infinity, at = 0;
  for (const k of grid) {
    const g = durrleman(p, k);
    if (g < min) { min = g; at = k; }
  }
  return { minG: min, atK: at, arbFree: min >= 0 };
}
