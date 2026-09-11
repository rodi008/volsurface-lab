// Numerical primitives. No dependencies, double precision throughout.

/**
 * Cumulative standard normal. Hart (1968) rational approximation as given in
 * West, G. (2005) "Better Approximations to Cumulative Normal Functions",
 * Wilmott Magazine. Maximum absolute error ~1e-15 over the full real line,
 * i.e. at machine precision. Deliberately not the Abramowitz-Stegun 7.1.26
 * polynomial, whose 7.5e-8 error is visible in delta-to-strike inversion.
 */
export function normCdf(x) {
  const z = Math.abs(x);
  let c;
  if (z > 37) {
    c = 0;
  } else {
    const e = Math.exp(-z * z / 2);
    if (z < 7.07106781186547) {
      let n = 3.52624965998911e-02 * z + 0.700383064443688;
      n = n * z + 6.37396220353165;
      n = n * z + 33.912866078383;
      n = n * z + 112.079291497871;
      n = n * z + 221.213596169931;
      n = n * z + 220.206867912376;
      let d = 8.83883476483184e-02 * z + 1.75566716318264;
      d = d * z + 16.064177579207;
      d = d * z + 86.7807322029461;
      d = d * z + 296.564248779674;
      d = d * z + 637.333633378831;
      d = d * z + 793.826512519948;
      d = d * z + 440.413735824752;
      c = e * n / d;
    } else {
      let b = z + 0.65;
      b = z + 4 / b;
      b = z + 3 / b;
      b = z + 2 / b;
      b = z + 1 / b;
      c = e / (b * 2.506628274631);
    }
  }
  return x > 0 ? 1 - c : c;
}

const INV_SQRT_2PI = 0.3989422804014327;
export function normPdf(x) {
  return INV_SQRT_2PI * Math.exp(-0.5 * x * x);
}

/** Brent's method. Requires a sign change on [a,b]. */
export function brent(f, a, b, tol = 1e-12, maxIter = 200) {
  let fa = f(a), fb = f(b);
  if (fa * fb > 0) return null;
  if (Math.abs(fa) < Math.abs(fb)) { [a, b] = [b, a]; [fa, fb] = [fb, fa]; }
  let c = a, fc = fa, d = b - a, e = d, mflag = true, s = b, fs = fb;
  for (let i = 0; i < maxIter; i++) {
    if (fb === 0) return b;
    if (fa !== fc && fb !== fc) {
      s = a * fb * fc / ((fa - fb) * (fa - fc))
        + b * fa * fc / ((fb - fa) * (fb - fc))
        + c * fa * fb / ((fc - fa) * (fc - fb));
    } else {
      s = b - fb * (b - a) / (fb - fa);
    }
    const lo = (3 * a + b) / 4;
    const cond = (s - lo) * (s - b) > 0
      || (mflag && Math.abs(s - b) >= Math.abs(b - c) / 2)
      || (!mflag && Math.abs(s - b) >= Math.abs(c - d) / 2)
      || (mflag && Math.abs(b - c) < tol)
      || (!mflag && Math.abs(c - d) < tol);
    if (cond) { s = (a + b) / 2; mflag = true; } else { mflag = false; }
    fs = f(s);
    d = c; c = b; fc = fb;
    if (fa * fs < 0) { b = s; fb = fs; } else { a = s; fa = fs; }
    if (Math.abs(fa) < Math.abs(fb)) { [a, b] = [b, a]; [fa, fb] = [fb, fa]; }
    if (Math.abs(b - a) < tol) return b;
  }
  return b;
}

/** Nelder-Mead simplex. Used for the outer SVI calibration loop. */
export function nelderMead(f, x0, { maxIter = 3000, tol = 1e-13, step = 0.15 } = {}) {
  const n = x0.length;
  let simplex = [x0.slice()];
  for (let i = 0; i < n; i++) {
    const p = x0.slice();
    p[i] += p[i] !== 0 ? Math.abs(p[i]) * step : step;
    simplex.push(p);
  }
  let fv = simplex.map(f);
  const alpha = 1, gamma = 2, rho = 0.5, sigma = 0.5;
  for (let it = 0; it < maxIter; it++) {
    const ord = fv.map((_, i) => i).sort((p, q) => fv[p] - fv[q]);
    simplex = ord.map(i => simplex[i]);
    fv = ord.map(i => fv[i]);
    if (Math.abs(fv[n] - fv[0]) <= tol * (Math.abs(fv[0]) + tol)) break;
    const cen = new Array(n).fill(0);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) cen[j] += simplex[i][j] / n;
    const xr = cen.map((c, j) => c + alpha * (c - simplex[n][j]));
    const fr = f(xr);
    if (fr < fv[0]) {
      const xe = cen.map((c, j) => c + gamma * (xr[j] - c));
      const fe = f(xe);
      if (fe < fr) { simplex[n] = xe; fv[n] = fe; } else { simplex[n] = xr; fv[n] = fr; }
    } else if (fr < fv[n - 1]) {
      simplex[n] = xr; fv[n] = fr;
    } else {
      const xc = cen.map((c, j) => c + rho * (simplex[n][j] - c));
      const fc = f(xc);
      if (fc < fv[n]) { simplex[n] = xc; fv[n] = fc; }
      else {
        for (let i = 1; i <= n; i++) {
          simplex[i] = simplex[i].map((v, j) => simplex[0][j] + sigma * (v - simplex[0][j]));
          fv[i] = f(simplex[i]);
        }
      }
    }
  }
  let bi = 0;
  for (let i = 1; i < fv.length; i++) if (fv[i] < fv[bi]) bi = i;
  return { x: simplex[bi], fx: fv[bi] };
}

/** Dense linear solve, Gaussian elimination with partial pivoting. */
export function solve(A, b) {
  const n = b.length;
  const M = A.map((r, i) => [...r, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-14) return null;
    [M[col], M[piv]] = [M[piv], M[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col] / M[col][col];
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((r, i) => r[n] / r[i]);
}

/** Composite Simpson on a uniform grid. n intervals must be even. */
export function simpson(ys, h) {
  const n = ys.length - 1;
  if (n < 2) return 0;
  let s = ys[0] + ys[n];
  for (let i = 1; i < n; i++) s += ys[i] * (i % 2 === 1 ? 4 : 2);
  return s * h / 3;
}

/** Cumulative trapezoid, returns array of same length. */
export function cumTrapz(ys, h) {
  const out = new Array(ys.length).fill(0);
  for (let i = 1; i < ys.length; i++) out[i] = out[i - 1] + (ys[i] + ys[i - 1]) / 2 * h;
  return out;
}

export function linspace(a, b, n) {
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = a + (b - a) * i / (n - 1);
  return out;
}

/** Linear interpolation on sorted xs, clamped at the ends. */
export function interp(xs, ys, x) {
  if (x <= xs[0]) return ys[0];
  if (x >= xs[xs.length - 1]) return ys[ys.length - 1];
  let lo = 0, hi = xs.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (xs[mid] <= x) lo = mid; else hi = mid; }
  const t = (x - xs[lo]) / (xs[hi] - xs[lo]);
  return ys[lo] + t * (ys[hi] - ys[lo]);
}

export const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
export const quantile = (sorted, p) => {
  const i = (sorted.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
};
