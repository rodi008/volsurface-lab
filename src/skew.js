// Wing structure: 25-delta risk reversal, butterfly, and the ATM anchor.
//
// The risk reversal is the market's price for asymmetry. RR25 = IV(25d call)
// - IV(25d put) is negative whenever downside strikes trade richer than
// equidistant upside strikes, which is the market paying up for crash
// protection. It is a cleaner fear gauge than the level of implied vol,
// because it is a DIFFERENCE of two vols and so is largely immune to the
// overall vol level: vol can double in a rally without RR25 moving, while a
// funding scare shows up in RR25 immediately.

import { delta } from './black76.js';
import { sviIv, sviW1, sviW } from './svi.js';
import { brent } from './math.js';

/**
 * Strike at a given forward delta, solved consistently with the smile: the
 * volatility used to evaluate delta at a candidate strike is the fitted
 * volatility AT that strike, not a single ATM vol. Ignoring that feedback
 * misplaces the 25-delta strike by hundreds of dollars on a skewed surface,
 * which then propagates straight into RR25.
 */
export function strikeAtDelta(slice, target, type) {
  const { params, T, F } = slice;
  const f = k => delta(F, F * Math.exp(k), T, sviIv(params, k, T), type) - target;
  // Calls: delta falls from 1 to 0 as k rises. Puts: delta rises from -1 to 0.
  const k = brent(f, -3, 3, 1e-12);
  if (k == null) return null;
  return { k, K: F * Math.exp(k), iv: sviIv(params, k, T) };
}

/** dIV/dk at the money: the local slope of the smile in log-moneyness. */
export function atmSkewSlope(slice) {
  const { params, T } = slice;
  const w = sviW(params, 0);
  // sigma = sqrt(w/T)  =>  dsigma/dk = w'/(2*sqrt(w*T))
  return sviW1(params, 0) / (2 * Math.sqrt(Math.max(w, 1e-12) * T));
}

export function sliceSkew(slice, d = 0.25) {
  const call = strikeAtDelta(slice, d, 'call');
  const put = strikeAtDelta(slice, -d, 'put');
  const atmIv = sviIv(slice.params, 0, slice.T);
  if (!call || !put) {
    return { label: slice.label, T: slice.T, dte: slice.dte, atmIv, rr: null, bf: null };
  }
  return {
    label: slice.label,
    T: slice.T,
    dte: slice.dte,
    F: slice.F,
    atmIv,
    callK: call.K, callIv: call.iv, callK_k: call.k,
    putK: put.K, putIv: put.iv, putK_k: put.k,
    // Risk reversal, in vol points. Negative = puts richer = downside fear.
    rr: (call.iv - put.iv) * 100,
    // Butterfly: the average wing over the ATM. Measures convexity, i.e. how
    // much the market pays for a large move in EITHER direction.
    bf: ((call.iv + put.iv) / 2 - atmIv) * 100,
    atmSlope: atmSkewSlope(slice),
  };
}

export function skewTermStructure(surface, d = 0.25) {
  return surface.slices.map(s => sliceSkew(s, d));
}

/**
 * Percentile of the current RR25 against its own recent history is the honest
 * way to read a fear gauge: -6 vol points means nothing until you know whether
 * this market normally sits at -2 or at -12. We do not have a stored RR25
 * history from the public API, so the caller supplies one if available;
 * otherwise the level is reported without a percentile rather than against a
 * made-up baseline.
 */
export function percentileOf(value, history) {
  if (!history || history.length < 20) return null;
  const below = history.filter(v => v <= value).length;
  return below / history.length;
}
