// Quantitative readings of the calibrated surface.
//
// Every statement here is derived from the numbers in the same run and carries
// the number it rests on. Where the data does not support a claim the function
// says so instead of reaching for a weaker one.

import { percentileOf } from './skew.js';

const pct = (x, d = 1) => (x * 100).toFixed(d) + '%';
const ordinal = n => {
  const m = n % 100;
  if (m >= 11 && m <= 13) return n + 'th';
  return n + (['th', 'st', 'nd', 'rd'][n % 10] || 'th');
};
const vp = (x, d = 2) => (x >= 0 ? '+' : '') + x.toFixed(d) + ' vol pts';
const usd = x => '$' + Math.round(x).toLocaleString('en-US');

/**
 * The two or three things worth knowing before reading anything else.
 *
 * Only what sits outside its usual range earns a line, so on an ordinary day
 * this is short and says so. Every claim is a level the page shows elsewhere;
 * nothing here is a forecast or a recommendation.
 */
export function readNotable({ currency, cm, context, headline, term }) {
  const out = [];

  if (context && context.impliedVol && Number.isFinite(context.impliedVol.pct)) {
    const p = Math.round(context.impliedVol.pct * 100);
    if (p <= 15) {
      out.push(`30-day implied volatility sits in the ${ordinal(p)} percentile of its own year at ` +
        `${pct(cm.atm30)}: the market is pricing an unusually quiet month.`);
    } else if (p >= 85) {
      out.push(`30-day implied volatility sits in the ${ordinal(p)} percentile of its own year at ` +
        `${pct(cm.atm30)}: the market is pricing an unusually turbulent month.`);
    }
  }

  if (term && term.length > 1) {
    // Measured from the shortest expiry beyond a few days. At one day to
    // expiry ATM vol is dominated by the expiry itself and routinely prints
    // ten points away from the curve, which would report an inversion on an
    // ordinary day.
    const front = term.find(r => r.dte >= 5) || term[0];
    const slope = (term[term.length - 1].atmIv - front.atmIv) * 100;
    if (slope < -1.5) {
      out.push(`The term structure is inverted by ${Math.abs(slope).toFixed(1)} vol points — near-dated ` +
        `options price more volatility than long-dated ones, which is what stress looks like.`);
    }
  }

  if (Number.isFinite(cm.rr30)) {
    if (cm.rr30 <= -3) {
      out.push(`RR25 is ${vp(cm.rr30)}: downside protection is bid well over upside.`);
    } else if (cm.rr30 >= 3) {
      out.push(`RR25 is ${vp(cm.rr30)}, with upside calls bid over downside puts — the ` +
        `unusual direction for a crypto smile.`);
    }
  }

  if (Number.isFinite(cm.vrp30)) {
    if (cm.vrp30 < 0) {
      out.push(`The 30-day variance premium is negative at ${vp(cm.vrp30)}: options price ` +
        `less volatility than the past month actually delivered.`);
    } else if (Number.isFinite(cm.vrpT30) && cm.vrpT30 >= 2) {
      out.push(`The 30-day variance premium is ${vp(cm.vrp30)} at t = ${cm.vrpT30.toFixed(1)}, ` +
        `clear of the sampling noise in the realized leg.`);
    }
  }

  if (headline && Number.isFinite(headline.p)) {
    out.push(`The market prices a ${pct(headline.p)} chance of ${currency} above ${usd(headline.level)} ` +
      `by ${headline.label}.`);
  }

  if (!out.length) out.push('Every reading sits inside its usual range today.');
  return out.slice(0, 3);
}

export function readTermStructure(surface) {
  const s = surface.slices;
  if (s.length < 2) return [];
  // The front is the shortest expiry beyond a few days: a one-day option's ATM
  // vol is an expiry-day artefact rather than a point on the curve.
  const front = s.find(x => x.dte >= 5) || s[0];
  const back = s[s.length - 1];
  const out = [];

  const slope = (back.atmIv - front.atmIv) * 100;
  out.push(
    `ATM term structure runs ${pct(front.atmIv)} at ${front.dte.toFixed(1)}d to ` +
    `${pct(back.atmIv)} at ${back.dte.toFixed(0)}d, a ${vp(slope)} spread. ` +
    (slope > 1.5
      ? 'Upward sloping: the market prices near-term calm against longer-dated uncertainty. ' +
        'Forward variance is being sold cheaply at the front and bid further out, which is the ' +
        'normal shape outside a stress episode.'
      : slope < -1.5
      ? 'Inverted: near-dated variance is bid above longer-dated. Term-structure inversion is a ' +
        'stress signature — an identified near-term event, or spot already moving — and it ' +
        'typically mean-reverts faster than the level of vol does.'
      : 'Effectively flat, which gives no directional information about the timing of risk.')
  );

  // Forward variance between consecutive slices: the vol the market implies for
  // the interval alone, stripped of everything before it.
  const fwds = [];
  for (let i = 0; i + 1 < s.length; i++) {
    const w1 = s[i].atmIv ** 2 * s[i].T, w2 = s[i + 1].atmIv ** 2 * s[i + 1].T;
    const dT = s[i + 1].T - s[i].T;
    if (dT > 1e-9 && w2 > w1) fwds.push({ from: s[i].label, to: s[i + 1].label, vol: Math.sqrt((w2 - w1) / dT) });
  }
  if (fwds.length) {
    const hi = fwds.reduce((a, b) => (b.vol > a.vol ? b : a));
    const lo = fwds.reduce((a, b) => (b.vol < a.vol ? b : a));
    out.push(
      `Forward ATM variance is richest over ${hi.from}–${hi.to} at ${pct(hi.vol)} and cheapest ` +
      `over ${lo.from}–${lo.to} at ${pct(lo.vol)}. Forward vol strips out the variance already ` +
      `priced into the nearer expiry, so it isolates what the market charges for that interval ` +
      `alone — the calendar-spread signal that the raw term structure hides.`
    );
  }
  return out;
}

/**
 * @param ctx optional { rr30, rrHistory }: RR25 at 30-day constant maturity and
 *            the stored daily readings before today, for a percentile read.
 */
export function readSkew(skews, ctx = null) {
  const out = [];
  const usable = skews.filter(s => s.rr != null);
  if (!usable.length) return ['No expiry produced a solvable 25-delta pair.'];

  const mid = usable.reduce((a, b) => (Math.abs(b.dte - 30) < Math.abs(a.dte - 30) ? b : a));
  out.push(
    `RR25 at the ${mid.dte.toFixed(0)}-day tenor is ${vp(mid.rr)}: the 25-delta put trades at ` +
    `${pct(mid.putIv)} against ${pct(mid.callIv)} for the 25-delta call, on strikes ` +
    `${usd(mid.putK)} and ${usd(mid.callK)} around a ${usd(mid.F)} forward. ` +
    (mid.rr < -1
      ? `Negative: downside strikes are bid over equidistant upside. The market is paying a ` +
        `premium for protection, not for participation.`
      : mid.rr > 1
      ? `Positive: upside strikes are bid over equidistant downside. This is call-skew, an ` +
        `unusual configuration outside a squeeze, and it means the tail being hedged is a ` +
        `rally rather than a selloff.`
      : `Near zero: the market is charging symmetrically for both tails.`)
  );

  const sorted = [...usable].sort((a, b) => a.dte - b.dte);
  const near = sorted[0], far = sorted[sorted.length - 1];
  out.push(
    `Across tenors RR25 moves from ${vp(near.rr)} at ${near.dte.toFixed(1)}d to ${vp(far.rr)} at ` +
    `${far.dte.toFixed(0)}d. ` +
    (far.rr < near.rr - 1
      ? `Skew steepens with maturity: the feared move is a slow one, not an imminent gap.`
      : near.rr < far.rr - 1
      ? `Skew is steepest at the front: the market is pricing a near-term downside event and ` +
        `expects the asymmetry to decay.`
      : `The asymmetry is roughly flat across the curve, so no single tenor carries an ` +
        `identified event.`)
  );

  const bf = usable.reduce((a, b) => (Math.abs(b.dte - 30) < Math.abs(a.dte - 30) ? b : a));
  out.push(
    `BF25 at the same tenor is ${vp(bf.bf)}, the average 25-delta wing over the ATM. Butterfly ` +
    `prices convexity — the cost of a large move in either direction — and is the part of the ` +
    `smile that RR25, being a difference, cannot see. ` +
    (bf.bf > 3
      ? `At this level the market is paying materially for tails on both sides.`
      : `That is a moderate convexity charge.`)
  );

  out.push(
    `Read RR25 as a difference, not a level: it is nearly immune to the overall vol level, so ` +
    `it moves when the market re-prices ASYMMETRY rather than when it re-prices risk. A doubling ` +
    `of ATM vol in a rally can leave RR25 untouched; a funding scare shows up in it immediately.`
  );

  if (ctx && Number.isFinite(ctx.rr30)) {
    const hist = ctx.rrHistory || [];
    const p = percentileOf(ctx.rr30, hist);
    out.push(p != null
      ? `At 30-day constant maturity RR25 reads ${vp(ctx.rr30)}, the ${ordinal(Math.round(p * 100))} ` +
        `percentile of the last ${hist.length} daily readings. That percentile, not the level, is ` +
        `the fear gauge: it says whether today's asymmetry is unusual for this market.`
      : `At 30-day constant maturity RR25 reads ${vp(ctx.rr30)}. A percentile against its own history ` +
        `needs at least 20 daily readings and ${hist.length} ${hist.length === 1 ? 'is' : 'are'} stored so ` +
        `far, so the level is reported without one rather than against an invented baseline.`);
  }
  return out;
}

export function readVrp(vrpRows, stats, realized) {
  const out = [];
  const near = vrpRows.reduce((a, b) => (Math.abs(b.dte - 30) < Math.abs(a.dte - 30) ? b : a));

  out.push(
    `At the ${near.dte.toFixed(0)}-day tenor the fair variance-swap strike is ${pct(near.mfIv)} ` +
    `against ${pct(near.rv)} realized over the trailing ${near.rvWindowDays} days: ` +
    `${vp(near.vrpVolPts)} of premium. In variance terms that is ` +
    `${near.vrpVariance.toFixed(4)}, which is the quantity a variance swap actually settles on.`
  );

  const short = vrpRows.filter(r => r.rvWindowDays <= 8 && r.vrpTStat != null);
  if (short.length) {
    const worst = short.reduce((a, b) => (b.vrpTStat < a.vrpTStat ? b : a));
    out.push(
      `The short-tenor premiums are not measurements. Realized vol over a ${worst.rvWindowDays}-day ` +
      `window carries a standard error of ${worst.rvSeVolPts.toFixed(2)} vol pts — for iid returns ` +
      `SE(sigma) = sigma/sqrt(2n) — so ${worst.label}'s ${vp(worst.vrpVolPts)} is ` +
      `${worst.vrpTStat.toFixed(1)} standard errors of the realized leg alone. Anything under ` +
      `roughly 2 there is a quiet sample, not an edge, and the front of this curve should be read ` +
      `as an implied level rather than as a premium.`
    );
  }

  out.push(
    `The implied leg is the model-free strike, ${vp(near.smilePremiumVolPts)} above ATM implied ` +
    `of ${pct(near.atmIv)}. That gap is the convexity of the smile, and it is why using ATM vol ` +
    `for the implied leg understates the premium systematically rather than randomly.`
  );

  if (stats && stats.expost) {
    const e = stats.expost;
    out.push(
      `Measured ex post over ${e.n} overlapping 30-day windows, selling variance earned a mean ` +
      `${vp(e.mean)} with a median of ${vp(e.median)}, positive on ${pct(e.hitRate)} of days, ` +
      `dispersion ${e.sd.toFixed(2)} vol pts, 5th percentile ${vp(e.p05)} and worst case ` +
      `${vp(e.min)}. This is the premium the seller was PAID, comparing DVOL on each date with ` +
      `variance realized over the following 30 days.`
    );
    out.push(
      `Note the shape of that distribution rather than its mean. A ${pct(e.hitRate)} hit rate ` +
      `with a ${vp(e.min)} worst case is the signature of a short-volatility payoff: it collects ` +
      `steadily and loses violently. The mean is a poor summary of a return series whose left ` +
      `tail is ${(Math.abs(e.min) / Math.max(e.mean, 0.01)).toFixed(0)}x its average gain.`
    );
    out.push(
      `Those ${e.n} windows overlap: consecutive observations share 29 of their 30 days, so the ` +
      `series is close to a random walk in its own right and the nominal count is not the ` +
      `evidence. Dividing by the horizon leaves ${e.effectiveN.toFixed(1)} independent windows, ` +
      `against which the mean carries a standard error of ${e.seMean.toFixed(2)} vol pts and a ` +
      `t-statistic of ${e.tStat.toFixed(2)}. ` +
      (Math.abs(e.tStat) < 2
        ? `That does not clear conventional significance. Roughly a year of history is simply too ` +
          `short to establish a variance premium; the literature that does so uses decades.`
        : `That clears the usual bar, though a sample this short over a single regime should not ` +
          `be treated as a stable estimate of the premium.`)
    );
    if (stats.exante) {
      out.push(
        `The ex-ante series — implied against TRAILING realized, the only version observable in ` +
        `real time — averages ${vp(stats.exante.mean)}. The gap against the ex-post mean of ` +
        `${vp(e.mean)} is the error from using past variance as a forecast of future variance, ` +
        `and it is the reason the live signal is weaker than the backtest.`
      );
    }
  }

  if (realized) {
    const r = realized;
    const parts = [];
    if (r.closeToClose) parts.push(`close-to-close ${pct(r.closeToClose.vol)}`);
    if (r.parkinson) parts.push(`Parkinson ${pct(r.parkinson.vol)}`);
    if (r.garmanKlass) parts.push(`Garman-Klass ${pct(r.garmanKlass.vol)}`);
    if (r.yangZhang) parts.push(`Yang-Zhang ${pct(r.yangZhang.vol)}`);
    out.push(
      `Realized vol over the same trailing window by estimator: ${parts.join(', ')}. ` +
      `Close-to-close is the reference here because it is what a variance swap settles on; the ` +
      `range-based estimators are more efficient but measure a different functional, and the ` +
      `spread between them is itself a read on whether the move is trending or choppy.`
    );
  }
  return out;
}

export function readDensity(summary, rnd) {
  const out = [];
  const d = summary.diagnostics;
  const q = summary.quantiles;

  out.push(
    `Over ${summary.dte.toFixed(0)} days to ${summary.label}, the option-implied distribution puts ` +
    `its median at ${usd(q.p50)} against a forward of ${usd(summary.F)}, with a 90% interval of ` +
    `${usd(q.p05)} to ${usd(q.p95)} and an interquartile range of ${usd(q.p25)} to ${usd(q.p75)}.`
  );

  const above = summary.levels.filter(l => l.probAbove > 0.001 && l.probAbove < 0.999);
  if (above.length) {
    out.push(
      'Level probabilities read directly off the digital, Q(S_T > X) = -e^{rT} dC/dK: ' +
      above.map(l => `${usd(l.level)} ${pct(l.probAbove, 1)}`).join(', ') + '.'
    );
  }

  if (d.skew != null) {
    out.push(
      `The distribution carries skewness ${d.skew.toFixed(3)} and excess kurtosis ` +
      `${d.excessKurtosis.toFixed(3)}. ` +
      (d.skew > 0.3
        ? `Positive skew in the RND is the arithmetic consequence of lognormality — price cannot ` +
          `go below zero but has no ceiling — and does NOT mean the market expects a rally. The ` +
          `market's directional fear lives in RR25, not in the sign of this moment.`
        : `Negative skew here is a genuine signal: it survives the lognormal baseline, which by ` +
          `itself would produce positive skew.`) +
      ` Excess kurtosis of ${d.excessKurtosis.toFixed(2)} against 0 for a Gaussian is the market ` +
      `pricing fat tails on both sides.`
    );
  }

  out.push(
    `Integrity of the density: total mass ${d.mass.toFixed(6)} (target 1, error ` +
    `${d.massError.toExponential(1)}) and mean ${usd(d.meanK)} against a forward of ` +
    `${usd(summary.F)}, off by ${d.meanErrorBp.toFixed(2)} bp. The second is the sharper test: ` +
    `under Q the forward is a martingale, so the density's mean MUST be the forward, and any ` +
    `drift there would mean the calibration is not arbitrage-consistent.`
  );

  if (d.extrapolatedMass > 0.005) {
    out.push(
      `${pct(d.extrapolatedMass, 2)} of the probability mass falls outside the quoted strike ` +
      `range ${usd(d.quotedRange[0])}–${usd(d.quotedRange[1])}. Inside that range the density ` +
      `reads market prices; outside it reads SVI's linear-in-variance wing extrapolation. Tail ` +
      `probabilities beyond the listed strikes are a model output, not a market observation.`
    );
  }
  return out;
}

export function readDiagnostics(surface) {
  const out = [];
  const worst = surface.slices.reduce((a, b) => (b.rmseVol > a.rmseVol ? b : a));
  const median = [...surface.slices].sort((a, b) => a.rmseVol - b.rmseVol)[Math.floor(surface.slices.length / 2)];
  out.push(
    `Calibration residuals: median slice RMSE ${median.rmseVol.toFixed(2)} vol pts, worst ` +
    `${worst.label} at ${worst.rmseVol.toFixed(2)} (core |k| <= 0.5: ${worst.coreRmseVol.toFixed(2)}). ` +
    `Residuals are quoted in vol points so they can be compared against the bid-ask width, which ` +
    `is the only benchmark that decides whether a fit is good enough to trade on.`
  );

  const bad = surface.slices.filter(s => !s.butterfly.arbFree);
  out.push(
    bad.length === 0
      ? `Butterfly: Durrleman's g(k) >= 0 on every slice, so the implied density is non-negative ` +
        `everywhere and the Breeden-Litzenberger output is well defined.`
      : `Butterfly VIOLATED on ${bad.map(s => s.label).join(', ')}: the implied density goes ` +
        `negative there, and any probability read off those slices is meaningless.`
  );

  const cal = surface.calendar.filter(c => c.violations > 0);
  out.push(
    cal.length === 0
      ? `Calendar: total variance is non-decreasing in maturity across every adjacent pair, so the ` +
        `surface admits no calendar-spread arbitrage and interpolation in T is monotone.`
      : `Calendar VIOLATED on ${cal.map(c => `${c.from}->${c.to} (${c.worstVolPts.toFixed(2)} vol pts)`).join(', ')}: ` +
        `a shorter expiry prices above a longer one at the same log-moneyness.`
  );

  const maxWing = surface.slices.reduce((m, s) => Math.max(m, s.wings.left, s.wings.right), 0);
  out.push(
    `Wing slopes peak at ${maxWing.toFixed(3)} against Roger Lee's bound of 2. Total variance ` +
    `growing faster than 2|k| in the wings would imply a distribution with no finite moment of ` +
    `the corresponding order, so this bound is a hard consistency requirement, not a preference.`
  );
  return out;
}
