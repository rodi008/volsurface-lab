# Vol Surface Lab

BTC option analytics on Deribit's public API. No API key, no account, no paid data.

**Live:** https://rodi008.github.io/volsurface-lab/ — rebuilt daily at 08:40 UTC.

The pipeline is a dependency chain, and the order matters: a risk-neutral density
read off a slice that violates the butterfly condition is meaningless, so the
arbitrage checks run before the results rather than after.

```
chain  ->  Black-76  ->  SVI slices  ->  arbitrage checks  ->  { skew | VRP | density }
```

## Commands

Each stage is independently invocable.

```bash
node bin/lab.js validate    # analytic checks + exchange round trip
node bin/lab.js surface     # SVI calibration, per-slice diagnostics
node bin/lab.js skew        # 25-delta risk reversal / butterfly term structure
node bin/lab.js vrp         # variance risk premium, ex-ante and ex-post
node bin/lab.js rnd         # Breeden-Litzenberger density
node bin/lab.js all         # everything; writes out/snapshot.json
node bin/lab.js update      # the unattended daily run (see "Daily update")
node bin/dashboard.js       # renders out/snapshot.json into out/dashboard.html
node test/analytic.test.mjs # closed-form checks against Black-Scholes
```

Flags: `--json`, `--currency=BTC`, `--expiry=25DEC26`, `--levels=100000,150000`.

## Modules

| File | Contents |
|---|---|
| `src/math.js` | Hart/West cumulative normal (~1e-15), Brent, Nelder-Mead, Gaussian elimination, Simpson |
| `src/black76.js` | Forward-measure pricing, greeks, implied-vol inversion |
| `src/deribit.js` | Public API client; chain, index OHLC, DVOL history |
| `src/svi.js` | Raw-SVI calibration, Durrleman butterfly test, wing slopes |
| `src/surface.js` | Per-expiry fitting, calendar-arbitrage test, maturity interpolation |
| `src/skew.js` | Smile-consistent delta-to-strike inversion, RR25, BF25 |
| `src/varswap.js` | Model-free implied variance, four realized estimators, VRP |
| `src/rnd.js` | Breeden-Litzenberger density, digitals, quantiles, moments |
| `src/interpret.js` | Written readings, each carrying the number it rests on |

## Modelling decisions worth knowing

**Black-76 on the per-expiry forward, not Black-Scholes on spot.** Deribit quotes
each expiry against its own forward index (`underlying_price`), and the forward
curve is in contango — roughly 4.9% annualised across the board at the time of
writing. Using spot would misprice every slice by the basis.

**USD price space.** Deribit options are inverse: the premium is quoted in BTC as
a fraction of a coin. `markPriceBTC * F` is the USD premium, and inverting that
under Black-76 reproduces the exchange's own `mark_iv`. `lab.js validate` proves
it — across the chain the median pricing error is a small fraction of a tick and
put-call parity holds to a fraction of a basis point. The occasional miss of a
few ticks is a deep-in-the-money contract whose mark and forward were stamped a
moment apart, which is why the health gate reads the median and 99th
percentile rather than the maximum.

**ACT/365.** Crypto settles continuously. The 252-day equity convention would
inflate every annualised figure by about 20%.

**OTM only.** Deep-ITM options carry almost no vega, so inverting a volatility
from a tick-rounded price there is ill-posed — the round-trip error reaches 30+
vol points on those contracts and under a vol point on everything OTM.

**Quasi-explicit SVI calibration** (Zeliade Systems, 2009). For fixed `(m, sig)`
the problem is linear in the remaining three parameters and solves in closed
form, leaving only a 2-D simplex search. Fitting all five with a generic
optimiser is what produces unstable wing-flapping fits.

Two details that decide whether that fit works at all:

- *Calibrate on normalised total variance.* Total variance spans ~5e-4 at half a
  day to ~0.15 at nine months. On raw `w` the inner normal equations go singular
  at the short end.
- *Set the wing bound in real units.* The classic domain `c <= 4*sig` bounds the
  wing slope in whatever units `w` carries. Against normalised variance that
  means `b_real <= 4*max(w)`, which is harmless at nine months and crippling at
  half a day, where an ordinary smile needs four times what it allows. The bound
  comes from Roger Lee's moment formula instead, which caps wing growth of total
  variance at 2 independently of maturity. Fixing this took the half-day slice
  from 4.95 to 0.99 vol points of RMSE.

**Fit weights are the Jacobian plus a square-rooted liquidity tilt.** Weighting by
`1/(2*sigma*T)^2` turns least squares on `w` into least squares in vol points, so
the reported RMSE compares directly against the bid-ask width. Full price-error
weighting (`(vega/(2*sigma*T))^2`) collapses so fast that at half a day two
strikes carry the whole objective against five parameters, and the wings — which
are exactly what the density reads — float free.

**The implied leg of the VRP is the variance-swap strike, not ATM vol.** They
differ by the convexity of the smile, worth 4-6 vol points here, so ATM would
understate the premium systematically rather than randomly.

## What the numbers do not support

Two guards are built into the output rather than left to the reader.

**Short-tenor premiums are not measurements.** Realized volatility over a 5-day
window has a standard error of about 6 vol points — `SE(sigma) = sigma/sqrt(2n)`.
A `+12` premium there is under two standard errors of the realized leg alone.
The `t` column says so.

**The ex-post series uses overlapping windows.** Consecutive observations share 29
of 30 days, so 377 observations are roughly 12.6 independent ones. On that basis
the mean premium carries t ≈ 0.6 — the sample does not establish a variance
premium, and the dashboard says that rather than quoting the hit rate as an edge.

Beyond the quoted strike range the density is SVI's linear-in-variance wing
extrapolation, not a market price; the share of probability mass sitting out
there is reported per expiry.

## Validation

`test/analytic.test.mjs` fits a flat SVI slice, which *is* Black-Scholes, and
checks every derived quantity against its closed form:

| Quantity | Error |
|---|---|
| Model-free implied vol vs sigma | 1.6e-10 vol pts |
| Density mass vs 1 | 1.2e-12 |
| Density mean vs forward (martingale) | < 0.0001 bp |
| `Q(S_T > X)` vs lognormal | < 0.1 bp |
| Quantiles | < 0.35 bp |
| 25-delta strike | 0.0000 bp |

`lab.js validate` runs the same checks against live data, where the martingale
test is the sharp one: under Q the forward is a martingale, so the density's mean
must be the forward. Any drift there means the calibration is not
arbitrage-consistent.

## Daily update

The dashboard is a static site on GitHub Pages, rebuilt once a day by the
workflow in `.github/workflows/daily.yml`. It runs in GitHub's cloud, so no
machine of yours has to be on, and it costs nothing: Deribit's data is public
and the computation is plain Node.

Each run starts at 08:40 UTC, after Deribit's 08:00 UTC settlement:

1. `node bin/lab.js update` fetches, calibrates and runs the health gate. On
   `HEALTH: FAIL` it exits non-zero, the job stops, nothing is deployed, the
   site keeps serving the previous day, and GitHub emails the repository owner.
2. `node bin/site.js` wraps the dashboard into `site/index.html`.
3. `out/history.jsonl` is committed back. It is the only state that has to
   outlive the runner, and the daily commit counts as repository activity,
   which keeps GitHub from disabling the schedule after 60 quiet days.
4. `site/` is deployed to Pages.

A push to `main` runs the same job, so a template change goes live with fresh
data at once. The Actions tab has a "Run workflow" button for a manual run.

What keeps an unattended run from publishing something wrong:

- The health gate blocks deployment whenever the page's own claims would be
  false: pricing that no longer matches exchange marks, a fit that does not
  fit, a headline read off a slice whose density goes negative somewhere.
- History only grows on healthy runs, so a broken day never enters the
  baseline the RR25 percentile is computed against.
- The page's freshness chip turns amber once its data is more than 30 hours
  old, so a missed update is visible rather than silent.
- Instrument names are validated against Deribit's code format before they
  can reach the page, and every string the page renders is escaped.

**Constant maturity.** The headline figures are interpolated to a fixed 30-day
tenor — total variance, linear in T — which is the DVOL convention. Listed
expiries roll every day, so a "nearest listed expiry" number jumps on each
roll, and a day-over-day change on it would compare two different tenors.

**As a Claude artifact.** The same page also runs as an artifact. A viewer that
grants the `db` capability lets it swap in snapshots from the artifact's
database, and `update` stages that write set in `out/db/batch.json`, which
exists after a run if and only if the run passed the gate. On a plain static
host that code path finds no viewer and does nothing.

## Requirements

Node >= 18 (uses global `fetch`). No dependencies.
