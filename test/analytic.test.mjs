// Analytic checks. A flat SVI slice (b = 0) IS Black-Scholes, so every
// derived quantity has a closed form to compare against.
import { modelFreeVariance, cboeVariance } from '../src/varswap.js';
import { riskNeutralDensity, probAbove, quantile } from '../src/rnd.js';
import { normCdf } from '../src/math.js';
import { strikeAtDelta } from '../src/skew.js';

const SIG = 0.65, T = 0.25, F = 79000, r = 0;
const flat = {
  label: 'FLAT', T, F, r, dte: T * 365,
  params: { a: SIG * SIG * T, b: 0, rho: 0, m: 0, sig: 0.1 },
  kLo: -2, kHi: 2,
  atmIv: SIG,
};

console.log('=== flat smile, sigma =', SIG, 'T =', T, '===');

const mf = modelFreeVariance(flat);
console.log('model-free vol   :', mf.vol.toFixed(10), ' error:', ((mf.vol - SIG) * 100).toExponential(2), 'vol pts');
console.log('truncation check :', mf.truncationVolPts.toExponential(2), 'vol pts on a 40% wider domain');

const rnd = riskNeutralDensity(flat);
const d = rnd.diagnostics;
console.log('density mass     :', d.mass.toFixed(10), ' error:', d.massError.toExponential(2));
console.log('density mean / F :', (d.meanK / F).toFixed(10), ' error:', d.meanErrorBp.toFixed(4), 'bp');

// Lognormal closed forms
const sT = SIG * Math.sqrt(T);
const d2 = k => (-Math.log(k / F) - 0.5 * SIG * SIG * T) / sT;
for (const K of [50000, 79000, 100000, 150000]) {
  const exact = normCdf(d2(K));
  const got = probAbove(rnd, K);
  console.log(`P(S>${String(K).padStart(6)}) : model ${(got * 100).toFixed(6)}%   exact ${(exact * 100).toFixed(6)}%   diff ${((got - exact) * 1e4).toFixed(3)} bp`);
}

// Quantile check: the p-quantile of a lognormal with mean F.
const zq = { p05: -1.6448536269514722, p50: 0, p95: 1.6448536269514722 };
for (const [name, z] of Object.entries(zq)) {
  const exact = F * Math.exp(-0.5 * SIG * SIG * T + z * sT);
  const got = quantile(rnd, name === 'p05' ? 0.05 : name === 'p50' ? 0.5 : 0.95);
  console.log(`${name} : model ${got.toFixed(2)}  exact ${exact.toFixed(2)}  diff ${((got / exact - 1) * 1e4).toFixed(3)} bp`);
}

// 25-delta strike on a flat smile: N(d1) = 0.25  =>  d1 = N^-1(0.25)
const c25 = strikeAtDelta(flat, 0.25, 'call');
const d1Target = -0.6744897501960817;
const exactK = F * Math.exp(-d1Target * sT + 0.5 * SIG * SIG * T);
console.log('25d call strike  : model', c25.K.toFixed(2), ' exact', exactK.toFixed(2),
  ' diff', ((c25.K / exactK - 1) * 1e4).toFixed(4), 'bp');
console.log('25d call IV      :', (c25.iv * 100).toFixed(6), '% (flat smile: must equal', (SIG * 100).toFixed(1) + '%)');
