// Deribit public API client. No authentication required for any endpoint used.

const BASE = 'https://www.deribit.com/api/v2/public';

// ACT/365. Crypto settles 24/7, so no business-day calendar applies and the
// 252-day equity convention would bias every annualised number we report.
const YEAR_MS = 365 * 24 * 3600 * 1000;

/**
 * The three conventions Deribit uses, and where each asset's data lives.
 *
 * Bitcoin and ether options are "reversed" (inverse): quoted in coin as a
 * fraction of one unit, so the USD premium is mark_price * forward. The
 * altcoin options are USDC-settled and linear: mark_price is already in
 * dollars. Reading one as the other misprices everything by a factor of the
 * spot, which put-call parity catches immediately.
 *
 * Altcoin options are not listed under their own ticker either: they sit in
 * the USDC bucket as SOL_USDC-…, so the chain is fetched wholesale and
 * filtered by prefix.
 *
 * `dvol` names the volatility index where one exists. Deribit publishes it for
 * BTC and ETH only, so anything built on it — the ex-post premium series, the
 * twelve-month context — is simply absent for the others rather than faked.
 */
export const ASSETS = {
  BTC: { fetchCurrency: 'BTC', prefix: 'BTC-', perpetual: 'BTC-PERPETUAL', dvol: 'BTC', name: 'Bitcoin' },
  ETH: { fetchCurrency: 'ETH', prefix: 'ETH-', perpetual: 'ETH-PERPETUAL', dvol: 'ETH', name: 'Ether' },
  SOL: { fetchCurrency: 'USDC', prefix: 'SOL_USDC-', perpetual: 'SOL_USDC-PERPETUAL', dvol: null, name: 'Solana' },
};

const NAME_RE = /^[A-Z]{2,6}(?:_[A-Z]{2,5})?-\d{1,2}[A-Z]{3}\d{2}-[\d.]+(?:d\d+)?-[CP]$/;

async function get(path, params = {}) {
  const url = `${BASE}/${path}?` + new URLSearchParams(params);
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status} on ${path}`);
      const json = await res.json();
      if (json.error) throw new Error(`${path}: ${JSON.stringify(json.error)}`);
      return json.result;
    } catch (e) {
      lastErr = e;
      await new Promise(r => setTimeout(r, 400 * (attempt + 1)));
    }
  }
  throw lastErr;
}

/**
 * Full option chain, joined from get_instruments (contract terms) and
 * get_book_summary_by_currency (live marks). Returned in USD price space.
 */
export async function fetchChain(code = 'BTC') {
  const a = ASSETS[code];
  if (!a) throw new Error(`unknown asset ${code}; known: ${Object.keys(ASSETS).join(', ')}`);

  const [instruments, summary] = await Promise.all([
    get('get_instruments', { currency: a.fetchCurrency, kind: 'option', expired: 'false' }),
    get('get_book_summary_by_currency', { currency: a.fetchCurrency, kind: 'option' }),
  ]);
  const meta = new Map(instruments.map(i => [i.instrument_name, i]));
  const mine = summary.filter(s => s.instrument_name.startsWith(a.prefix));
  if (!mine.length) throw new Error(`no ${code} options in the ${a.fetchCurrency} chain`);
  const asOf = Math.max(...mine.map(s => s.creation_timestamp));

  const rows = [];
  for (const s of mine) {
    const m = meta.get(s.instrument_name);
    if (!m || m.state !== 'open') continue;
    if (!s.mark_iv || !s.underlying_price) continue;
    // Instrument names end up rendered on the dashboard, so they are validated
    // rather than trusted. Anything that is not a Deribit option code is
    // dropped; if the format ever changes, the missing slices fail the health
    // gate instead of reaching the page.
    if (!NAME_RE.test(s.instrument_name)) continue;
    if (m.option_type !== 'call' && m.option_type !== 'put') continue;

    const T = (m.expiration_timestamp - asOf) / YEAR_MS;
    if (T <= 0) continue;
    const F = s.underlying_price;
    const K = m.strike;
    const linear = m.instrument_type === 'linear';
    const usd = p => (p == null ? null : linear ? p : p * F);

    rows.push({
      name: s.instrument_name,
      expiryTs: m.expiration_timestamp,
      expiryLabel: s.instrument_name.split('-')[1],
      T,
      dte: (m.expiration_timestamp - asOf) / 86400000,
      K,
      type: m.option_type,
      F,                                  // per-expiry forward, not spot
      r: s.interest_rate ?? 0,
      k: Math.log(K / F),                 // log-moneyness
      iv: s.mark_iv / 100,                // Deribit quotes IV in percent
      w: (s.mark_iv / 100) ** 2 * T,      // total implied variance
      linear,
      priceUsd: usd(s.mark_price),
      bidUsd: usd(s.bid_price),
      askUsd: usd(s.ask_price),
      // One tick in dollars, which is the unit the round-trip check reports in.
      tickUsd: usd(m.tick_size),
      oi: s.open_interest,
      volume: s.volume,
      isOtm: m.option_type === 'call' ? K >= F : K < F,
    });
  }
  rows.sort((a, b) => a.expiryTs - b.expiryTs || a.K - b.K);
  return { asOf, spot: rows.length ? rows[0].F : null, rows, currency: code };
}

/** Daily OHLC of the perpetual, used for realized-variance estimation. */
export async function fetchOhlc(days = 400, instrument = 'BTC-PERPETUAL') {
  const end = Date.now();
  const start = end - days * 86400000;
  const r = await get('get_tradingview_chart_data', {
    instrument_name: instrument,
    start_timestamp: start,
    end_timestamp: end,
    resolution: '1D',
  });
  return r.ticks.map((t, i) => ({
    ts: t, open: r.open[i], high: r.high[i], low: r.low[i], close: r.close[i],
  }));
}

/**
 * DVOL: Deribit's 30-day model-free implied volatility index, daily OHLC.
 * Published for BTC and ETH only; `index` is null for everything else, and the
 * empty series propagates as missing panels rather than as invented numbers.
 */
export async function fetchDvol(days = 400, index = 'BTC') {
  if (!index) return [];
  const end = Date.now();
  const start = end - days * 86400000;
  const r = await get('get_volatility_index_data', {
    currency: index, start_timestamp: start, end_timestamp: end, resolution: '1D',
  });
  return (r.data || []).map(([ts, o, h, l, c]) => ({ ts, open: o, high: h, low: l, close: c }));
}
