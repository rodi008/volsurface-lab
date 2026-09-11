// Everything between "the numbers are computed" and "the numbers are shown":
// the health gate that decides whether a run may be published at all, the
// precision trim, and the split into database documents.

/**
 * Round every non-integer to `sig` significant digits. Display never needs
 * more than four decimals, and full doubles roughly triple the payload the
 * page and the database have to carry. Integers (timestamps, strikes) and
 * non-numbers pass through untouched; non-finite numbers become null, which
 * is what JSON would silently do anyway, only now on purpose.
 */
export function roundDeep(v, sig = 6) {
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return null;
    return Number.isInteger(v) ? v : Number(v.toPrecision(sig));
  }
  if (Array.isArray(v)) return v.map(x => roundDeep(x, sig));
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v)) o[k] = roundDeep(v[k], sig);
    return o;
  }
  return v;
}

/**
 * Decide whether a snapshot may be published.
 *
 * HARD failures block publication: the live page keeps the previous day,
 * which is a better answer than today's numbers from a broken run. They are
 * the conditions under which the page's own claims would be false — pricing
 * no longer matching the exchange, a fit that does not fit, a headline read
 * off a slice whose density is negative somewhere.
 *
 * SOFT findings publish, because the page reports them honestly in its own
 * diagnostics section; they are listed so the scheduled run can mention them.
 */
export function healthCheck(snap) {
  const hard = [], soft = [];
  const v = snap.meta.validation || {};

  if (snap.slices.length < 5) hard.push(`only ${snap.slices.length} expiries calibrated`);
  for (const s of snap.slices) {
    const p = s.params;
    if (![p.a, p.b, p.rho, p.m, p.sig, s.atmIv].every(Number.isFinite)) {
      hard.push(`${s.label}: non-finite SVI parameters`);
    }
  }
  if (!(v.maxTicks < 2)) hard.push(`Black-76 no longer reproduces exchange marks (${v.maxTicks} ticks)`);
  if (!(v.parityBp < 5)) hard.push(`put-call parity broken on exchange marks (${v.parityBp} bp)`);

  const rmses = snap.slices.map(s => s.rmseVol).filter(Number.isFinite).sort((a, b) => a - b);
  const medianRmse = rmses.length ? rmses[Math.floor(rmses.length / 2)] : NaN;
  if (!(medianRmse < 3)) hard.push(`median fit RMSE ${medianRmse} vol pts`);
  else if (medianRmse >= 1) soft.push(`median fit RMSE ${medianRmse.toFixed(2)} vol pts`);

  if (!snap.densities.length) hard.push('no risk-neutral densities');
  if (!snap.headline) hard.push('no headline expiry');
  else if (!snap.headline.arbFree) hard.push(`headline slice ${snap.headline.label} violates the butterfly condition`);

  const cm = snap.cm || {};
  if (![cm.atm30, cm.mf30, cm.rr30, cm.vrp30].every(Number.isFinite)) {
    hard.push('constant-maturity 30-day readings missing');
  }

  const bf = snap.slices.filter(s => !s.butterfly.arbFree).map(s => s.label);
  if (bf.length) soft.push(`butterfly violated on ${bf.join(', ')}`);
  const cal = snap.calendar.filter(c => c.violations > 0).map(c => `${c.from}->${c.to}`);
  if (cal.length) soft.push(`calendar violated on ${cal.join(', ')}`);
  const wing = Math.max(...snap.slices.map(s => Math.max(s.wings.left, s.wings.right)));
  if (wing > 2) soft.push(`wing slope ${wing.toFixed(2)} exceeds Lee's bound of 2`);
  for (const d of snap.densities) {
    const e = d.summary.diagnostics.meanErrorBp;
    if (!(Math.abs(e) < 10)) soft.push(`${d.label}: density mean off the forward by ${e} bp`);
  }

  return { ok: hard.length === 0, hard, soft, medianRmse };
}

/**
 * Split a snapshot into database documents, each well under the store's
 * 256 KiB cap. Every document carries the same runId; the page only swaps in
 * a live snapshot once all four agree, so a reader who opens the page halfway
 * through an update never sees today's surface drawn over yesterday's density.
 */
export function dbDocuments(snap) {
  const runId = String(snap.meta.asOf);
  return {
    core: {
      runId,
      meta: snap.meta,
      cm: snap.cm,
      headline: snap.headline,
      slices: snap.slices.map(({ points, ...rest }) => rest),
      calendar: snap.calendar,
      skew: snap.skew,
      vrp: snap.vrp,
      vrpStats: snap.vrpStats,
      realized: snap.realized,
      interpretation: snap.interpretation,
    },
    surface: {
      runId,
      mesh: snap.mesh,
      points: Object.fromEntries(snap.slices.map(s => [s.label, s.points])),
    },
    density: { runId, densities: snap.densities },
    series: { runId, vrpSeries: snap.vrpSeries },
  };
}
