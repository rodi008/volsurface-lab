// Constant-maturity readings.
//
// Listed expiries roll every day, so any series built on "the listed expiry
// nearest to 30 days" jumps each time one expires: a 15-day slice ages into a
// 14-day slice until it is abruptly replaced by a 50-day one. Interpolating to
// a fixed tenor removes that seam, which is what makes a day-over-day
// comparison mean anything. It is also the convention DVOL is quoted on.
//
// Vols are interpolated in TOTAL VARIANCE, linear in T — the scheme the surface
// itself uses between slices, and calendar-arbitrage-free whenever the slices
// pass calendarViolations(). Vol differences (RR25, BF25) have no variance
// interpretation and are interpolated linearly in T. Outside the listed range
// the nearest slice is held flat rather than extrapolated.

function usable(rows, key) {
  return rows.filter(r => Number.isFinite(r[key]) && r.T > 0).sort((a, b) => a.T - b.T);
}

function bracket(rows, T) {
  const first = rows[0], last = rows[rows.length - 1];
  if (T <= first.T) return [first, first, 0];
  if (T >= last.T) return [last, last, 0];
  let i = 0;
  while (rows[i + 1].T < T) i++;
  return [rows[i], rows[i + 1], (T - rows[i].T) / (rows[i + 1].T - rows[i].T)];
}

/** Volatility at a constant tenor, interpolating total variance. */
export function cmVol(rows, days, key) {
  const r = usable(rows, key);
  if (!r.length) return null;
  const T = days / 365;
  const [a, b, f] = bracket(r, T);
  if (a === b) return a[key];
  const wa = a[key] ** 2 * a.T, wb = b[key] ** 2 * b.T;
  return Math.sqrt(Math.max(wa + f * (wb - wa), 0) / T);
}

/** A vol difference (RR25, BF25) at a constant tenor, linear in T. */
export function cmLinear(rows, days, key) {
  const r = usable(rows, key);
  if (!r.length) return null;
  const [a, b, f] = bracket(r, days / 365);
  return a[key] + f * (b[key] - a[key]);
}
