// Black-76: European options on a forward. This is the correct model for
// Deribit BTC options, which are quoted against a per-expiry forward index
// (the `underlying_price` field), not against spot.
//
// Deribit options are "reversed" (inverse): the premium is quoted in BTC as a
// fraction of one coin, and settlement is in BTC. The USD premium of a vanilla
// European payoff is therefore markPriceBTC * F. Deribit inverts its own
// mark_iv from that USD price under Black-76, so working in USD space keeps us
// bit-for-bit consistent with the exchange. See `lab.js validate` for the
// round trip that proves it.

import { normCdf, normPdf, brent } from './math.js';

export function d1d2(F, K, T, sigma) {
  const v = sigma * Math.sqrt(T);
  const d1 = (Math.log(F / K) + 0.5 * sigma * sigma * T) / v;
  return [d1, d1 - v];
}

export function price(F, K, T, sigma, r = 0, type = 'call') {
  const df = Math.exp(-r * T);
  if (T <= 0 || sigma <= 0) {
    return df * Math.max(0, type === 'call' ? F - K : K - F);
  }
  const [d1, d2] = d1d2(F, K, T, sigma);
  return type === 'call'
    ? df * (F * normCdf(d1) - K * normCdf(d2))
    : df * (K * normCdf(-d2) - F * normCdf(-d1));
}

/**
 * Forward delta, undiscounted: dC/dF = N(d1). This is the driftless delta
 * quoted by crypto desks and the convention the 25-delta wings refer to.
 * With r = 0 (Deribit reports interest_rate = 0 on BTC) it coincides with the
 * discounted spot delta, so the distinction is documented rather than material.
 */
export function delta(F, K, T, sigma, type = 'call') {
  if (T <= 0 || sigma <= 0) {
    const itm = type === 'call' ? F > K : F < K;
    return itm ? (type === 'call' ? 1 : -1) : 0;
  }
  const [d1] = d1d2(F, K, T, sigma);
  return type === 'call' ? normCdf(d1) : normCdf(d1) - 1;
}

/** dPrice/dSigma, per 1.00 of vol. Divide by 100 for one vol point. */
export function vega(F, K, T, sigma, r = 0) {
  if (T <= 0 || sigma <= 0) return 0;
  const [d1] = d1d2(F, K, T, sigma);
  return Math.exp(-r * T) * F * normPdf(d1) * Math.sqrt(T);
}

export function gamma(F, K, T, sigma, r = 0) {
  if (T <= 0 || sigma <= 0) return 0;
  const [d1] = d1d2(F, K, T, sigma);
  return Math.exp(-r * T) * normPdf(d1) / (F * sigma * Math.sqrt(T));
}

/**
 * Implied volatility by Newton on vega with a bracketed Brent fallback.
 * Newton is unreliable in the deep wings where vega collapses, so we hand off
 * rather than return a silently wrong root.
 */
export function impliedVol(target, F, K, T, r = 0, type = 'call') {
  const df = Math.exp(-r * T);
  const intrinsic = df * Math.max(0, type === 'call' ? F - K : K - F);
  const upper = df * (type === 'call' ? F : K);
  if (!(target > intrinsic + 1e-12) || target >= upper) return null;

  // Brenner-Subrahmanyam seed: sigma ~ sqrt(2*pi/T) * C/F, exact at the money.
  let sigma = Math.sqrt(2 * Math.PI / T) * target / (df * F);
  sigma = Math.min(Math.max(sigma, 1e-3), 5);
  for (let i = 0; i < 60; i++) {
    const diff = price(F, K, T, sigma, r, type) - target;
    if (Math.abs(diff) < 1e-12) return sigma;
    const v = vega(F, K, T, sigma, r);
    if (v < 1e-10) break;
    const next = sigma - diff / v;
    if (!Number.isFinite(next) || next <= 0 || next > 10) break;
    if (Math.abs(next - sigma) < 1e-14) return next;
    sigma = next;
  }
  return brent(s => price(F, K, T, s, r, type) - target, 1e-4, 10, 1e-13);
}
