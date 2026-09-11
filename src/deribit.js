// Deribit public API client. No authentication required for any endpoint used.

const BASE = 'https://www.deribit.com/api/v2/public';

// ACT/365. Crypto settles 24/7, so no business-day calendar applies and the
// 252-day equity convention would bias every annualised number we report.
const YEAR_MS = 365 * 24 * 3600 * 1000;

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
export async function fetchChain(currency = 'BTC') {
  const [instruments, summary] = await Promise.all([
    get('get_instruments', { currency, kind: 'option', expired: 'false' }),
    get('get_book_summary_by_currency', { currency, kind: 'option' }),
  ]);
  const meta = new Map(instruments.map(i => [i.instrument_name, i]));
  const asOf = Math.max(...summary.map(s => s.creation_timestamp));

  const rows = [];
  for (const s of summary) {
    const m = meta.get(s.instrument_name);
    if (!m || m.state !== 'open') continue;
    if (!s.mark_iv || !s.underlying_price) continue;
    // Instrument names end up rendered on the dashboard, so they are validated
    // rather than trusted. Anything that is not a Deribit option code such as
    // BTC-25DEC26-100000-C is dropped; if the format ever changes, the missing
    // slices fail the health gate instead of reaching the page.
    if (!/^[A-Z]{2,6}-\d{1,2}[A-Z]{3}\d{2}-\d+(?:d\d+)?-[CP]$/.test(s.instrument_name)) continue;
    if (m.option_type !== 'call' && m.option_type !== 'put') continue;
    const T = (m.expiration_timestamp - asOf) / YEAR_MS;
    if (T <= 0) continue;
    const F = s.underlying_price;
    const K = m.strike;
    const type = m.option_type;
    rows.push({
      name: s.instrument_name,
      expiryTs: m.expiration_timestamp,
      expiryLabel: s.instrument_name.split('-')[1],
      T,
      dte: (m.expiration_timestamp - asOf) / 86400000,
      K,
      type,
      F,                                  // per-expiry forward, not spot
      r: s.interest_rate ?? 0,
      k: Math.log(K / F),                 // log-moneyness
      iv: s.mark_iv / 100,                // Deribit quotes IV in percent
      w: (s.mark_iv / 100) ** 2 * T,      // total implied variance
      markBtc: s.mark_price,
      priceUsd: s.mark_price * F,
      bidUsd: s.bid_price != null ? s.bid_price * F : null,
      askUsd: s.ask_price != null ? s.ask_price * F : null,
      oi: s.open_interest,
      volume: s.volume,
      isOtm: type === 'call' ? K >= F : K < F,
    });
  }
  rows.sort((a, b) => a.expiryTs - b.expiryTs || a.K - b.K);
  return { asOf, spot: rows.length ? rows[0].F : null, rows, currency };
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

/** DVOL: Deribit 30-day model-free implied volatility index, daily OHLC. */
export async function fetchDvol(days = 400, currency = 'BTC') {
  const end = Date.now();
  const start = end - days * 86400000;
  const r = await get('get_volatility_index_data', {
    currency, start_timestamp: start, end_timestamp: end, resolution: '1D',
  });
  return r.data.map(([ts, o, h, l, c]) => ({ ts, open: o, high: h, low: l, close: c }));
}
