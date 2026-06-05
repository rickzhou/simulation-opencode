#!/usr/bin/env tsx
/**
 * AI bubble-bust simulation v7 — NINE dials.
 *
 *   Dial 1  Severity   : melt / mild / base / severe        (the equity-bust shape)
 *   Dial 2  Inflation  : down / sticky / high                (the CPI regime)
 *   Dial 3  Fed        : cut / hold / hike                   (the Fed funds path)
 *   Dial 4  GDP        : soft / recession / hard              (the real-economy outcome)
 *   Dial 5  Tariffs    : truce / deescalate / escalate        (the trade regime)
 *   Dial 6  Geopolitics: stable / tension / conflict          (the world political environment)
 *   Dial 7  JGB / Japan: anchored / normalization / crisis    (the Japanese bond market)
 *   Dial 8  Fiscal     : austerity / neutral / stimulus       (government spending & deficits)
 *   Dial 9  USD        : weak / neutral / strong              (the dollar regime)
 *
 *   -> 4 x 3 x 3 x 3 x 3 x 3 x 3 x 3 x 3 = 26244 scenarios.
 *
 * Faithful TypeScript port of simulate.py. See the README for the model writeup.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

type KF = Array<[number, number]>;
type Dial = Record<string, any>;

// ---------- Python-compatible round ----------
// Python's round() rounds the *exact* IEEE-754 double value to `ndigits`
// decimals using round-half-to-even. Neither `x * 10**n` (binary error) nor
// `x.toFixed(n)` (V8 mis-rounds halves, e.g. (5.565).toFixed(2) === "5.56"
// although the exact double 5.56500000000000039 should round up) is reliable.
// Instead we expand the exact double to many decimals via toFixed with a large
// digit count, then round that decimal string ourselves with banker's rounding.
function pyRound(x: number, ndigits = 0): number {
  if (Number.isNaN(x) || !Number.isFinite(x) || x === 0) return x;
  const neg = x < 0;
  // toFixed with a generous buffer yields the true decimal digits of the double
  // (its exact dyadic expansion, then zeros) — enough to decide rounding.
  const buf = Math.min(100, ndigits + 25);
  const str = Math.abs(x).toFixed(buf);
  const dot = str.indexOf('.');
  const intPart = str.slice(0, dot);
  const fracPart = str.slice(dot + 1);
  const keep = fracPart.slice(0, ndigits);
  const rest = fracPart.slice(ndigits);
  // digits we will keep, as one contiguous string (no decimal point)
  let digits = intPart + keep;
  let roundUp = false;
  if (rest.length > 0) {
    const first = rest.charCodeAt(0) - 48;
    if (first > 5) roundUp = true;
    else if (first === 5) {
      const restNonZero = /[1-9]/.test(rest.slice(1));
      if (restNonZero) roundUp = true;
      else {
        const lastKept = digits.length > 0 ? digits.charCodeAt(digits.length - 1) - 48 : 0;
        roundUp = lastKept % 2 === 1; // half-to-even
      }
    }
  }
  if (roundUp) {
    const arr = digits.split('');
    let i = arr.length - 1;
    for (; i >= 0; i--) {
      if (arr[i] === '9') arr[i] = '0';
      else { arr[i] = String.fromCharCode(arr[i].charCodeAt(0) + 1); break; }
    }
    if (i < 0) arr.unshift('1');
    digits = arr.join('');
  }
  // reinsert the decimal point: last `ndigits` chars are the fraction
  let resultStr: string;
  if (ndigits > 0) {
    const padded = digits.padStart(ndigits + 1, '0');
    resultStr = padded.slice(0, padded.length - ndigits) + '.' + padded.slice(padded.length - ndigits);
  } else {
    resultStr = digits;
  }
  const result = Number(resultStr);
  return neg ? -result : result;
}

// ---------- monotone cubic (PCHIP) interpolation ----------
function pchip(xs: number[], ys: number[]): (x: number) => number {
  const n = xs.length;
  const h: number[] = [];
  for (let i = 0; i < n - 1; i++) h.push(xs[i + 1] - xs[i]);
  const delta: number[] = [];
  for (let i = 0; i < n - 1; i++) delta.push((ys[i + 1] - ys[i]) / h[i]);
  const d: number[] = new Array(n).fill(0.0);
  if (n === 2) {
    d[0] = d[1] = delta[0];
    return (x: number) => {
      if (x <= xs[0]) return ys[0];
      if (x >= xs[n - 1]) return ys[n - 1];
      return ys[0] + delta[0] * (x - xs[0]);
    };
  }
  for (let i = 1; i < n - 1; i++) {
    if (delta[i - 1] * delta[i] <= 0) {
      d[i] = 0.0;
    } else {
      const w1 = 2 * h[i] + h[i - 1];
      const w2 = h[i] + 2 * h[i - 1];
      d[i] = (w1 + w2) / (w1 / delta[i - 1] + w2 / delta[i]);
    }
  }
  const endp = (h0: number, h1: number, d0: number, d1: number): number => {
    let v = ((2 * h0 + h1) * d0 - h0 * d1) / (h0 + h1);
    if (v * d0 <= 0) v = 0.0;
    else if (d0 * d1 <= 0 && Math.abs(v) > Math.abs(3 * d0)) v = 3 * d0;
    return v;
  };
  d[0] = endp(h[0], h[1], delta[0], delta[1]);
  d[n - 1] = endp(h[n - 2], h[n - 3], delta[n - 2], delta[n - 3]);
  return (x: number) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (i < n - 1 && xs[i + 1] < x) i += 1;
    const t = (x - xs[i]) / h[i];
    return (
      (2 * t ** 3 - 3 * t ** 2 + 1) * ys[i] +
      (t ** 3 - 2 * t ** 2 + t) * h[i] * d[i] +
      (-2 * t ** 3 + 3 * t ** 2) * ys[i + 1] +
      (t ** 3 - t ** 2) * h[i] * d[i + 1]
    );
  };
}

function ser(keyframes: KF): number[] {
  const f = pchip(keyframes.map((k) => k[0]), keyframes.map((k) => k[1]));
  const out: number[] = [];
  for (let m = 0; m < 61; m++) out.push(f(m));
  return out;
}

function rampscalar(full: number, end = 12): number[] {
  const out: number[] = [];
  for (let m = 0; m < 61; m++) out.push(full * Math.min(1.0, m / end));
  return out;
}

const MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function label(m: number): string {
  const idx = 4 + m;
  return `${MO[idx % 12]} ${2026 + Math.floor(idx / 12)}`;
}
const DATES: string[] = [];
for (let m = 0; m < 61; m++) DATES.push(label(m));
const SP0 = 7473.0;

const zeroTilt = (keys: string[]): Record<string, number> =>
  Object.fromEntries(keys.map((k) => [k, 0.0]));

const SECTORS = ['tech', 'comm', 'discretionary', 'industrials', 'materials', 'financials',
  'realestate', 'utilities', 'energy', 'healthcare', 'staples'];
const EQ = ['ai_complex', 'ex_ai', ...SECTORS];
const COMK = ['gold', 'wti', 'natgas', 'copper', 'uranium', 'silver', 'agriculture'];

// ---------- Dial 1: Severity ----------
const SEV: Record<string, Dial> = {};
SEV['mild'] = {
  ai_complex: [[0, 100], [3, 110], [6, 95], [10, 80], [14, 68], [18, 72], [24, 82], [32, 95], [42, 110], [52, 124], [60, 134]],
  ex_ai: [[0, 100], [3, 101], [7, 99], [11, 98], [15, 99], [20, 102], [28, 107], [38, 113], [48, 120], [60, 127]],
  tech: [[0, 100], [3, 112], [7, 95], [11, 82], [15, 74], [20, 80], [28, 92], [38, 107], [48, 122], [60, 134]],
  comm: [[0, 100], [3, 107], [8, 94], [13, 86], [18, 84], [26, 93], [36, 105], [48, 118], [60, 128]],
  discretionary: [[0, 100], [3, 105], [8, 95], [14, 89], [20, 90], [30, 99], [42, 111], [54, 121], [60, 125]],
  industrials: [[0, 100], [3, 103], [9, 96], [15, 92], [22, 94], [32, 101], [44, 110], [54, 118], [60, 121]],
  materials: [[0, 100], [4, 102], [10, 97], [16, 95], [24, 98], [34, 104], [46, 111], [60, 118]],
  financials: [[0, 100], [4, 102], [10, 97], [16, 95], [24, 100], [34, 108], [46, 117], [60, 124]],
  realestate: [[0, 100], [4, 101], [10, 96], [16, 93], [24, 96], [34, 103], [46, 111], [60, 117]],
  utilities: [[0, 100], [3, 105], [8, 97], [14, 92], [20, 93], [30, 99], [42, 106], [54, 112], [60, 115]],
  energy: [[0, 100], [4, 103], [10, 98], [16, 96], [24, 99], [34, 104], [46, 110], [60, 114]],
  healthcare: [[0, 100], [6, 101], [14, 100], [22, 103], [32, 108], [44, 115], [60, 122]],
  staples: [[0, 100], [8, 101], [18, 103], [28, 106], [40, 111], [52, 116], [60, 119]],
  vix: [[0, 17], [3, 15], [7, 26], [12, 29], [16, 24], [24, 18], [36, 16], [48, 15], [60, 15]],
  unemployment: [[0, 4.3], [10, 4.5], [18, 4.7], [26, 4.6], [38, 4.4], [50, 4.2], [60, 4.1]],
  mmf_assets: [[0, 7.0], [6, 7.3], [12, 7.7], [18, 7.9], [24, 7.6], [36, 7.2], [48, 6.9], [60, 6.7]],
  hy_spread: [[0, 320], [6, 330], [11, 420], [16, 460], [22, 400], [30, 350], [40, 320], [50, 300], [60, 300]],
  ig_spread: [[0, 95], [8, 120], [16, 150], [26, 130], [40, 110], [60, 100]],
  cpi_sev: 0.15, dem_shift: 0.06, uran_shift: 0.09, gold_shift: -0.03, silver_shift: 0.02, ag_shift: 0.01,
};
SEV['base'] = {
  ai_complex: [[0, 100], [4, 118], [7, 88], [11, 98], [16, 66], [22, 46], [28, 34], [34, 30], [40, 38], [46, 50], [52, 64], [60, 72]],
  ex_ai: [[0, 100], [4, 103], [8, 95], [12, 99], [18, 89], [24, 84], [30, 80], [34, 78], [40, 84], [48, 93], [54, 99], [60, 103]],
  tech: [[0, 100], [4, 116], [8, 84], [12, 94], [17, 62], [23, 45], [29, 37], [34, 36], [41, 45], [48, 58], [54, 68], [60, 75]],
  comm: [[0, 100], [4, 110], [8, 86], [12, 95], [18, 68], [24, 55], [30, 49], [34, 48], [41, 56], [48, 68], [54, 78], [60, 85]],
  discretionary: [[0, 100], [4, 108], [8, 88], [12, 96], [18, 72], [24, 62], [30, 57], [34, 56], [41, 64], [48, 76], [54, 86], [60, 93]],
  industrials: [[0, 100], [4, 107], [8, 90], [12, 98], [18, 76], [24, 68], [30, 64], [34, 63], [41, 71], [48, 83], [54, 92], [60, 99]],
  materials: [[0, 100], [4, 104], [8, 92], [12, 99], [18, 82], [24, 76], [30, 73], [34, 72], [41, 78], [48, 88], [54, 95], [60, 101]],
  financials: [[0, 100], [4, 103], [8, 93], [12, 99], [18, 82], [24, 73], [29, 68], [33, 67], [40, 75], [48, 88], [54, 97], [60, 104]],
  realestate: [[0, 100], [4, 101], [8, 92], [12, 96], [18, 80], [24, 72], [30, 68], [34, 67], [41, 74], [48, 85], [54, 93], [60, 99]],
  utilities: [[0, 100], [4, 108], [8, 95], [12, 101], [17, 84], [23, 78], [29, 75], [34, 76], [41, 82], [48, 90], [54, 96], [60, 101]],
  energy: [[0, 100], [3, 105], [7, 97], [11, 100], [16, 86], [22, 79], [28, 77], [34, 79], [41, 86], [48, 94], [54, 100], [60, 105]],
  healthcare: [[0, 100], [4, 101], [9, 97], [13, 100], [20, 90], [26, 85], [32, 83], [36, 84], [44, 90], [52, 97], [60, 103]],
  staples: [[0, 100], [4, 100], [10, 99], [16, 101], [24, 93], [30, 90], [36, 89], [42, 91], [50, 97], [60, 103]],
  vix: [[0, 17], [4, 15], [8, 32], [12, 24], [17, 38], [23, 44], [29, 41], [34, 36], [41, 28], [48, 22], [54, 19], [60, 18]],
  unemployment: [[0, 4.3], [6, 4.4], [12, 4.8], [20, 5.6], [28, 6.3], [34, 6.6], [40, 6.5], [48, 6.0], [54, 5.5], [60, 5.1]],
  mmf_assets: [[0, 7.0], [6, 7.5], [12, 8.1], [20, 9.0], [28, 9.7], [34, 9.95], [42, 9.3], [50, 8.7], [60, 8.2]],
  hy_spread: [[0, 320], [5, 310], [9, 430], [14, 560], [20, 720], [26, 840], [30, 820], [34, 700], [42, 540], [50, 450], [60, 400]],
  ig_spread: [[0, 95], [8, 135], [16, 185], [26, 210], [34, 180], [46, 135], [60, 115]],
  cpi_sev: 0.0, dem_shift: 0.0, uran_shift: 0.0, gold_shift: 0.0, silver_shift: 0.0, ag_shift: 0.0,
};
SEV['severe'] = {
  ai_complex: [[0, 100], [2, 115], [5, 82], [8, 55], [11, 33], [14, 21], [18, 26], [24, 34], [32, 44], [42, 56], [52, 66], [60, 73]],
  ex_ai: [[0, 100], [2, 102], [5, 92], [8, 84], [11, 77], [15, 71], [18, 70], [24, 75], [32, 82], [42, 90], [52, 97], [60, 102]],
  tech: [[0, 100], [2, 113], [5, 80], [8, 52], [11, 33], [14, 25], [18, 30], [24, 39], [32, 50], [42, 62], [52, 72], [60, 79]],
  comm: [[0, 100], [2, 108], [5, 82], [8, 62], [11, 46], [15, 37], [19, 42], [25, 51], [33, 62], [43, 74], [53, 84], [60, 90]],
  discretionary: [[0, 100], [2, 105], [5, 84], [8, 68], [12, 54], [15, 49], [19, 54], [25, 63], [33, 73], [43, 84], [53, 93], [60, 99]],
  industrials: [[0, 100], [2, 104], [5, 86], [9, 70], [13, 58], [16, 54], [20, 59], [26, 68], [34, 77], [44, 87], [54, 95], [60, 100]],
  materials: [[0, 100], [3, 102], [7, 88], [11, 76], [15, 68], [18, 66], [24, 72], [32, 80], [42, 89], [52, 96], [60, 101]],
  financials: [[0, 100], [3, 101], [6, 88], [9, 74], [12, 62], [15, 57], [18, 60], [24, 70], [32, 81], [42, 92], [52, 101], [60, 107]],
  realestate: [[0, 100], [3, 100], [7, 86], [11, 72], [15, 62], [18, 59], [24, 66], [32, 75], [42, 85], [52, 93], [60, 99]],
  utilities: [[0, 100], [2, 106], [6, 90], [10, 76], [14, 68], [17, 66], [22, 72], [30, 80], [40, 88], [50, 94], [60, 99]],
  energy: [[0, 100], [3, 103], [7, 90], [11, 78], [15, 70], [18, 69], [24, 75], [32, 83], [42, 91], [52, 98], [60, 103]],
  healthcare: [[0, 100], [4, 99], [9, 90], [14, 82], [18, 80], [24, 85], [32, 92], [42, 100], [52, 107], [60, 112]],
  staples: [[0, 100], [4, 98], [10, 92], [16, 88], [22, 89], [30, 94], [40, 101], [50, 107], [60, 112]],
  vix: [[0, 17], [2, 16], [5, 48], [8, 62], [12, 71], [15, 58], [20, 42], [28, 33], [38, 25], [48, 21], [60, 19]],
  unemployment: [[0, 4.3], [5, 4.6], [10, 5.4], [15, 6.8], [20, 7.8], [26, 8.1], [34, 7.7], [44, 6.7], [54, 5.8], [60, 5.3]],
  mmf_assets: [[0, 7.0], [4, 7.6], [9, 8.8], [14, 10.6], [20, 11.1], [26, 10.7], [36, 9.8], [48, 9.0], [60, 8.4]],
  hy_spread: [[0, 320], [3, 340], [6, 560], [9, 880], [12, 1180], [15, 1320], [18, 1150], [24, 860], [32, 640], [42, 500], [52, 430], [60, 400]],
  ig_spread: [[0, 95], [6, 160], [12, 250], [16, 290], [24, 220], [34, 160], [48, 125], [60, 110]],
  cpi_sev: -0.35, dem_shift: -0.10, uran_shift: -0.15, gold_shift: 0.05, silver_shift: -0.03, ag_shift: -0.02,
};
SEV['melt'] = {
  is_melt: true,
  ai_complex: [[0, 100], [7, 140], [12, 128], [20, 172], [30, 198], [38, 184], [46, 222], [54, 242], [60, 256]],
  ex_ai: [[0, 100], [8, 107], [18, 113], [30, 121], [42, 131], [52, 140], [60, 147]],
  tech: [[0, 100], [7, 138], [12, 127], [20, 168], [30, 194], [38, 181], [46, 216], [54, 236], [60, 250]],
  comm: [[0, 100], [8, 126], [16, 136], [28, 158], [40, 176], [52, 192], [60, 205]],
  discretionary: [[0, 100], [8, 119], [18, 130], [30, 143], [42, 154], [54, 164], [60, 170]],
  industrials: [[0, 100], [8, 121], [18, 134], [30, 147], [42, 157], [54, 165], [60, 171]],
  materials: [[0, 100], [10, 114], [22, 125], [34, 135], [46, 143], [60, 151]],
  financials: [[0, 100], [8, 117], [20, 128], [32, 139], [44, 149], [60, 160]],
  realestate: [[0, 100], [10, 108], [22, 114], [34, 120], [46, 126], [60, 131]],
  utilities: [[0, 100], [8, 124], [18, 137], [30, 149], [42, 157], [54, 163], [60, 167]],
  energy: [[0, 100], [8, 115], [20, 126], [32, 136], [44, 144], [60, 153]],
  healthcare: [[0, 100], [12, 107], [26, 114], [40, 121], [54, 127], [60, 131]],
  staples: [[0, 100], [14, 105], [30, 111], [46, 117], [60, 122]],
  vix: [[0, 17], [8, 14], [14, 20], [22, 15], [34, 13], [40, 19], [48, 15], [60, 16]],
  unemployment: [[0, 4.3], [10, 4.1], [24, 3.9], [38, 3.8], [50, 3.9], [60, 4.0]],
  mmf_assets: [[0, 7.0], [10, 6.7], [22, 6.4], [34, 6.2], [46, 6.3], [60, 6.4]],
  hy_spread: [[0, 320], [12, 290], [24, 270], [36, 280], [48, 300], [60, 312]],
  ig_spread: [[0, 95], [14, 82], [30, 78], [46, 86], [60, 93]],
  cpi_sev: 0.30, dem_shift: 0.0, uran_shift: 0.0, gold_shift: 0.0, silver_shift: 0.0, ag_shift: 0.0,
  commod: {
    gold: [[0, 3300], [12, 3450], [26, 3600], [40, 3750], [54, 3880], [60, 3950]],
    wti: [[0, 98], [10, 103], [24, 108], [38, 112], [50, 115], [60, 118]],
    natgas: [[0, 3.80], [10, 4.20], [22, 4.55], [34, 4.80], [48, 5.05], [60, 5.30]],
    copper: [[0, 4.60], [10, 5.20], [22, 5.90], [34, 6.40], [46, 6.90], [60, 7.40]],
    uranium: [[0, 80], [8, 98], [16, 92], [26, 118], [38, 140], [50, 158], [60, 172]],
    silver: [[0, 34], [10, 38], [22, 42], [34, 46], [48, 50], [60, 53]],
    agriculture: [[0, 100], [12, 104], [26, 108], [40, 112], [54, 116], [60, 119]],
  },
};

// ---------- Dial 2: Inflation ----------
const INF: Record<string, Dial> = {};
INF['down'] = {
  name: 'Disinflation',
  cpi: [[0, 3.0], [6, 2.6], [14, 1.9], [24, 1.2], [34, 1.0], [44, 1.3], [60, 1.8]],
  gold: [[0, 3300], [8, 3450], [18, 3650], [30, 3800], [44, 3850], [60, 3950]],
  wti: [[0, 98], [6, 86], [14, 70], [22, 60], [32, 57], [44, 63], [60, 68]],
  natgas: [[0, 3.80], [6, 3.10], [14, 2.40], [24, 2.20], [36, 2.55], [48, 2.95], [60, 3.20]],
  copper: [[0, 4.60], [6, 4.15], [13, 3.35], [22, 2.95], [32, 2.85], [44, 3.15], [60, 3.55]],
  uranium: [[0, 80], [5, 70], [11, 48], [18, 34], [28, 30], [40, 35], [52, 42], [60, 47]],
  silver: [[0, 34], [6, 32], [14, 30], [24, 32], [36, 35], [48, 38], [60, 40]],
  agriculture: [[0, 100], [10, 97], [22, 94], [34, 95], [48, 99], [60, 102]],
  eq_mult: [[0, 1.00], [10, 1.00], [24, 1.02], [40, 1.06], [60, 1.11]],
  unemp_add: [[0, 0], [18, -0.2], [60, -0.3]],
  vix_mult: 0.95, hy_inf_mult: 0.82, ig_inf_mult: 0.85, mmf_asset_mult: 1.0,
};
INF['sticky'] = {
  name: 'Sticky inflation',
  cpi: [[0, 3.0], [8, 3.1], [18, 3.0], [30, 2.8], [44, 2.6], [60, 2.5]],
  gold: [[0, 3300], [6, 3450], [12, 3650], [20, 3950], [28, 4200], [34, 4300], [42, 4150], [50, 4100], [60, 4200]],
  wti: [[0, 98], [4, 95], [9, 88], [14, 78], [20, 68], [26, 61], [32, 58], [38, 62], [46, 68], [54, 72], [60, 75]],
  natgas: [[0, 3.80], [4, 3.95], [9, 3.40], [14, 2.95], [20, 2.55], [27, 2.35], [33, 2.45], [40, 2.70], [48, 2.95], [54, 3.10], [60, 3.25]],
  copper: [[0, 4.60], [6, 4.25], [13, 3.60], [22, 3.25], [32, 3.25], [44, 3.65], [60, 4.00]],
  uranium: [[0, 80], [5, 73], [11, 54], [18, 42], [28, 39], [40, 46], [52, 54], [60, 60]],
  silver: [[0, 34], [6, 33], [14, 32], [24, 35], [36, 39], [48, 43], [60, 46]],
  agriculture: [[0, 100], [6, 99], [12, 98], [20, 95], [28, 94], [34, 95], [42, 98], [50, 101], [60, 104]],
  eq_mult: [[0, 1.00], [60, 1.00]],
  unemp_add: [[0, 0], [60, 0]],
  vix_mult: 1.0, hy_inf_mult: 1.0, ig_inf_mult: 1.0, mmf_asset_mult: 1.0,
};
INF['high'] = {
  name: 'High inflation / stagflation',
  // Raised peak from 8.3 to 10.0 — original under-reached 1970s analog (14.5% CPI peak).
  // With geo/tariff/fiscal add-ons the combined CPI can now approach 12-13%.
  cpi: [[0, 3.0], [5, 4.2], [11, 6.5], [18, 10.0], [26, 8.8], [36, 7.0], [48, 5.8], [60, 5.0]],
  gold: [[0, 3300], [6, 3750], [14, 4500], [24, 5400], [34, 6000], [46, 6250], [60, 6450]],
  wti: [[0, 98], [4, 118], [9, 136], [15, 128], [22, 108], [32, 96], [44, 92], [60, 95]],
  natgas: [[0, 3.80], [5, 4.80], [12, 5.65], [20, 5.05], [30, 4.45], [42, 4.15], [60, 4.00]],
  copper: [[0, 4.60], [5, 4.90], [11, 4.35], [19, 4.05], [28, 4.45], [40, 5.30], [60, 6.10]],
  uranium: [[0, 80], [5, 80], [11, 60], [18, 49], [28, 48], [40, 57], [52, 67], [60, 73]],
  silver: [[0, 34], [6, 38], [14, 46], [24, 56], [36, 64], [48, 70], [60, 74]],
  agriculture: [[0, 100], [8, 112], [18, 128], [30, 138], [44, 143], [60, 149]],
  eq_mult: [[0, 1.00], [6, 0.99], [16, 0.95], [30, 0.88], [45, 0.83], [60, 0.80]],
  unemp_add: [[0, 0], [6, 0.3], [20, 1.5], [40, 1.6], [60, 1.3]],
  vix_mult: 1.18, hy_inf_mult: 1.35, ig_inf_mult: 1.32, mmf_asset_mult: 0.95,
};

// ---------- Dial 3: Fed ----------
const FED: Record<string, Dial> = {};
FED['cut'] = {
  name: 'Fed cuts',
  path: [[0, 3.625], [4, 3.50], [9, 2.875], [15, 2.0], [24, 1.375], [33, 1.125], [44, 1.375], [54, 1.875], [60, 2.25]],
  eq: [[0, 1.0], [16, 1.012], [36, 1.04], [60, 1.055]], cpi_add: 0.6, gold_mult: 0.08,
};
FED['hold'] = {
  name: 'Fed on hold',
  path: [[0, 3.625], [10, 3.625], [24, 3.50], [40, 3.50], [54, 3.625], [60, 3.75]],
  eq: [[0, 1.0], [60, 1.0]], cpi_add: 0.0, gold_mult: 0.0,
};
FED['hike'] = {
  name: 'Fed hikes',
  // Peak lowered from 6.0 to 5.5 to better match modern Fed cycles (2022-23 peak was 5.25-5.50%)
  path: [[0, 3.625], [4, 4.125], [9, 4.875], [16, 5.375], [24, 5.5], [32, 5.375], [42, 4.875], [52, 4.5], [60, 4.25]],
  eq: [[0, 1.0], [10, 0.98], [30, 0.93], [60, 0.90]], cpi_add: -1.0,
  // Increased gold suppression: rate hikes raise real yields, which are gold's main headwind
  // (gold was flat/negative in 2022 despite 9% CPI because real yields surged +250bp)
  gold_mult: -0.28,
};

// ---------- Dial 4: GDP ----------
const GDP: Record<string, Dial> = {};
GDP['soft'] = {
  name: 'Soft landing',
  eq: [[0, 1.0], [12, 1.02], [30, 1.05], [60, 1.08]], unemp: -1.0, spread_mult: 0.72,
  commod: 0.08, vix_mult: 0.90, cpi_add: 0.25, mmf_mult: 0.95,
};
GDP['recession'] = {
  name: 'Recession',
  eq: [[0, 1.0], [60, 1.0]], unemp: 0.0, spread_mult: 1.0,
  commod: 0.0, vix_mult: 1.0, cpi_add: 0.0, mmf_mult: 1.0,
};
GDP['hard'] = {
  name: 'Hard landing',
  eq: [[0, 1.0], [8, 0.97], [20, 0.92], [36, 0.87], [60, 0.87]], unemp: 2.2, spread_mult: 1.5,
  commod: -0.12, vix_mult: 1.20, cpi_add: -0.35, mmf_mult: 1.08,
};

// ---------- Dial 5: Tariffs ----------
const TAR: Record<string, Dial> = {};
TAR['truce'] = {
  name: 'Tariff truce',
  short: 'US-China deal — effective tariffs drop to ~10%',
  cpi_add: -0.40,
  eq: [[0, 1.00], [6, 1.015], [18, 1.035], [36, 1.05], [60, 1.055]],
  sector_tilt: { tech: 0.04, discretionary: 0.035, industrials: 0.03, materials: 0.03, comm: 0.015, financials: 0.01, energy: -0.01, staples: 0.005, utilities: 0.0, healthcare: 0.0, realestate: 0.005 },
  commod_tilt: { copper: 0.08, silver: 0.04, natgas: 0.02, wti: 0.02, gold: -0.04, agriculture: -0.02, uranium: 0.03 },
  hy_inf_mult: 0.92, vix_mult: 0.95, unemp_add: -0.10, fed_add: -0.10,
  desc: 'China deal cuts effective tariffs from ~31% to ~10%. Supply chains thaw, goods inflation eases, and trade-sensitive sectors get a boost.',
};
TAR['deescalate'] = {
  name: 'De-escalate',
  short: 'Gradual easing from ~31% toward ~25%',
  cpi_add: 0.0,
  eq: [[0, 1.00], [60, 1.00]],
  sector_tilt: zeroTilt(SECTORS),
  commod_tilt: zeroTilt(COMK),
  hy_inf_mult: 1.0, vix_mult: 1.0, unemp_add: 0.0, fed_add: 0.0,
  desc: 'The status-quo baseline. Tariffs hold near 31% effective, drifting down modestly as the administration cuts targeted deals.',
};
TAR['escalate'] = {
  name: 'Tariff escalation',
  short: 'Tariffs to ~60%+ broad, full decoupling, retaliation',
  cpi_add: 1.05,
  eq: [[0, 1.00], [8, 0.985], [20, 0.955], [36, 0.93], [60, 0.92]],
  sector_tilt: { tech: -0.07, discretionary: -0.06, industrials: -0.04, materials: -0.04, comm: -0.03, financials: -0.025, realestate: -0.015, utilities: 0.005, energy: 0.015, staples: -0.01, healthcare: -0.005 },
  commod_tilt: { copper: -0.10, silver: -0.04, natgas: -0.03, wti: -0.04, gold: 0.12, agriculture: 0.08, uranium: -0.05 },
  hy_inf_mult: 1.18, vix_mult: 1.10, unemp_add: 0.35, fed_add: 0.30,
  desc: 'Tariffs jump to 60%+ on China, broaden to allies. China retaliates on rare earths and ag exports. Goods inflation surges, real growth stalls, the Fed leans hawkish on tariff pass-through.',
};

// ---------- Dial 6: Geopolitics ----------
const GEO: Record<string, Dial> = {};
GEO['stable'] = {
  name: 'Geopolitical stability',
  short: 'Relative peace — multilateral order holds',
  cpi_add: 0.0,
  eq: [[0, 1.00], [60, 1.00]],
  sector_tilt: zeroTilt(SECTORS),
  commod_tilt: zeroTilt(COMK),
  hy_mult: 1.0, vix_mult: 1.0, unemp_add: 0.0, fed_add: 0.0,
  desc: 'The status-quo baseline. No significant geopolitical shock — the post-WWII multilateral trade and security order holds with manageable friction.',
};
GEO['tension'] = {
  name: 'Geopolitical tension',
  short: 'Sanctions, proxy wars, trade-bloc fragmentation',
  cpi_add: 0.50,
  eq: [[0, 1.00], [8, 0.988], [20, 0.972], [36, 0.962], [60, 0.958]],
  sector_tilt: { tech: -0.04, comm: -0.03, discretionary: -0.02, industrials: 0.03, materials: 0.02, financials: -0.015, realestate: -0.01, utilities: 0.01, energy: 0.04, healthcare: 0.01, staples: 0.01 },
  commod_tilt: { gold: 0.10, wti: 0.12, natgas: 0.10, uranium: 0.08, copper: -0.04, silver: 0.05, agriculture: 0.06 },
  hy_mult: 1.12, vix_mult: 1.08, unemp_add: 0.20, fed_add: 0.15,
  desc: 'Sanctions, proxy conflicts and trade-bloc fragmentation raise a persistent geopolitical risk premium. Energy and defense benefit; tech and global supply chains face friction. A ~4% drag on equities over five years.',
};
GEO['conflict'] = {
  name: 'Active geopolitical conflict',
  short: 'Major-power war or regional conflict disrupting global supply',
  cpi_add: 1.40,
  eq: [[0, 1.00], [6, 0.976], [14, 0.932], [26, 0.892], [40, 0.876], [60, 0.882]],
  sector_tilt: { tech: -0.07, comm: -0.04, discretionary: -0.05, industrials: 0.06, materials: 0.03, financials: -0.04, realestate: -0.03, utilities: 0.02, energy: 0.07, healthcare: 0.02, staples: 0.02 },
  commod_tilt: { gold: 0.25, wti: 0.30, natgas: 0.38, uranium: 0.14, copper: -0.08, silver: 0.12, agriculture: 0.18 },
  hy_mult: 1.38, vix_mult: 1.22, unemp_add: 0.50, fed_add: 0.45,
  desc: 'An active major-power or regional conflict disrupts global energy, food and semiconductor supply chains. Oil and gold spike; natgas surges. Tech, financials and discretionary are hit hard — defensives and energy shelter capital.',
};

// ---------- Dial 7: Japanese bond market (JGB) ----------
const JGB: Record<string, Dial> = {};
JGB['anchored'] = {
  name: 'BoJ anchored',
  short: 'Yield-curve control holds — carry trade intact',
  cpi_add: 0.0,
  eq: [[0, 1.00], [60, 1.00]],
  y10_add: [[0, 0.0], [60, 0.0]],
  sector_tilt: zeroTilt(SECTORS),
  commod_tilt: zeroTilt(COMK),
  hy_mult: 1.0, vix_mult: 1.0, unemp_add: 0.0, fed_add: 0.0,
  desc: 'The status-quo baseline. The Bank of Japan keeps the JGB curve anchored, 10-year JGB yields stay low, and the multi-trillion-dollar yen-carry trade stays intact. No incremental Japanese selling pressure on US Treasuries.',
};
JGB['normalization'] = {
  name: 'BoJ normalization',
  short: '10Y JGB drifts to ~2.5%, yen firms, carry unwinds gradually',
  cpi_add: 0.0,
  eq: [[0, 1.00], [8, 0.992], [24, 0.978], [44, 0.972], [60, 0.972]],
  y10_add: [[0, 0.0], [8, 0.12], [24, 0.28], [40, 0.34], [60, 0.32]],
  sector_tilt: { financials: 0.015, tech: -0.015, discretionary: -0.012, realestate: -0.012, industrials: -0.006, comm: -0.008, materials: -0.004, utilities: 0.004, energy: 0.0, staples: 0.003, healthcare: 0.002 },
  commod_tilt: { gold: 0.03, silver: 0.01 },
  hy_mult: 1.05, vix_mult: 1.04, unemp_add: 0.05, fed_add: 0.0,
  desc: 'The BoJ exits yield-curve control and hikes gradually; the 10-year JGB drifts toward ~2.5%. The yen firms and the carry trade bleeds out slowly. Japanese investors trim US Treasury holdings, adding ~30bp of term premium to the US 10-year. A modest, persistent headwind for global equities; higher rates help financials, hurt rate-sensitive tech and real estate.',
};
JGB['crisis'] = {
  name: 'JGB crisis / carry unwind',
  short: 'Disorderly JGB selloff, violent yen-carry unwind, UST repatriation',
  cpi_add: 0.0,
  eq: [[0, 1.00], [3, 0.965], [8, 0.912], [14, 0.930], [24, 0.950], [40, 0.962], [60, 0.966]],
  y10_add: [[0, 0.0], [3, 0.55], [8, 1.25], [14, 1.45], [22, 1.05], [34, 0.75], [48, 0.55], [60, 0.50]],
  sector_tilt: { tech: -0.05, comm: -0.025, discretionary: -0.035, industrials: -0.02, materials: -0.01, financials: -0.03, realestate: -0.02, utilities: 0.01, energy: 0.0, healthcare: 0.01, staples: 0.01 },
  commod_tilt: { gold: 0.08, silver: 0.03, copper: -0.04, wti: -0.02, natgas: -0.01 },
  hy_mult: 1.28, vix_mult: 1.22, unemp_add: 0.15, fed_add: 0.0,
  desc: 'The BoJ loses control of the curve: a disorderly JGB selloff sends 10-year JGB yields spiking and triggers a violent unwind of the yen-carry trade (an August-2024-style shock, but larger and sustained). Japanese capital floods home, dumping US Treasuries and adding well over 1pp to the US 10-year at the peak. Global risk assets — especially carry-funded tech — are hit hard, the VIX spikes, credit spreads widen, and gold catches a safe-haven bid even as real yields climb.',
};

// ---------- Dial 8: Fiscal ----------
const FISCAL: Record<string, Dial> = {};
FISCAL['austerity'] = {
  name: 'Fiscal austerity',
  short: 'Deficit cuts, spending restraint, debt-ceiling brinkmanship',
  cpi_add: -0.30,
  eq: [[0, 1.00], [8, 0.985], [20, 0.965], [36, 0.955], [60, 0.958]],
  y10_add: [[0, 0.0], [8, -0.08], [24, -0.15], [40, -0.12], [60, -0.10]],
  sector_tilt: { tech: -0.02, comm: -0.015, discretionary: -0.04, industrials: -0.03, materials: -0.02, financials: -0.01, realestate: -0.025, utilities: -0.01, energy: -0.01, healthcare: -0.015, staples: -0.01 },
  commod_tilt: { gold: 0.04, wti: -0.06, natgas: -0.04, copper: -0.05, uranium: -0.02, silver: -0.02, agriculture: -0.03 },
  hy_mult: 1.08, vix_mult: 1.05, unemp_add: 0.25, fed_add: -0.15,
  reit_tilt: { comm_reit: -0.06, res_reit: -0.03 },
  btc_mult: 0.92,
  desc: 'Government cuts deficits, caps spending and/or hits a debt-ceiling crisis. Fiscal drag shaves ~0.5pp off GDP, hurts discretionary and industrials (government contractors), and pushes the Fed to ease sooner. Deflationary at the margin — bonds benefit, cyclicals suffer. Analog: 2011-13 sequestration / debt-ceiling.',
};
FISCAL['neutral'] = {
  name: 'Fiscal neutral',
  short: 'Deficit holds near 5-6% GDP — no major shift',
  cpi_add: 0.0,
  eq: [[0, 1.00], [60, 1.00]],
  y10_add: [[0, 0.0], [60, 0.0]],
  sector_tilt: zeroTilt(SECTORS),
  commod_tilt: zeroTilt(COMK),
  hy_mult: 1.0, vix_mult: 1.0, unemp_add: 0.0, fed_add: 0.0,
  reit_tilt: { comm_reit: 0.0, res_reit: 0.0 },
  btc_mult: 1.0,
  desc: 'The status-quo baseline. The federal deficit holds near 5-6% of GDP with no major new stimulus or austerity. Existing programs continue; no new tax reform.',
};
FISCAL['stimulus'] = {
  name: 'Fiscal stimulus',
  short: 'Major spending package / tax cuts, deficit to 8%+ GDP',
  cpi_add: 0.65,
  eq: [[0, 1.00], [6, 1.02], [18, 1.045], [36, 1.06], [60, 1.055]],
  y10_add: [[0, 0.0], [8, 0.15], [24, 0.35], [40, 0.40], [60, 0.35]],
  sector_tilt: { tech: 0.02, comm: 0.015, discretionary: 0.04, industrials: 0.05, materials: 0.03, financials: 0.02, realestate: 0.03, utilities: 0.015, energy: 0.025, healthcare: 0.01, staples: 0.005 },
  commod_tilt: { gold: -0.02, wti: 0.08, natgas: 0.06, copper: 0.07, uranium: 0.03, silver: 0.04, agriculture: 0.03 },
  hy_mult: 0.88, vix_mult: 0.93, unemp_add: -0.30, fed_add: 0.25,
  reit_tilt: { comm_reit: 0.05, res_reit: 0.06 },
  btc_mult: 1.15,
  desc: 'A major fiscal package (infrastructure, tax cuts, or emergency stimulus) pushes the deficit above 8% of GDP. Boosts cyclicals, industrials and real estate; inflationary at the margin — pushes the Fed hawkish and lifts the long end. Analog: 2020-21 CARES/ARP, 2017 TCJA, or a 2026 emergency AI-transition package.',
};

// ---------- Dial 9: USD ----------
const USD: Record<string, Dial> = {};
USD['weak'] = {
  name: 'Weak dollar',
  short: 'DXY falls to ~88-92 — loose global liquidity',
  cpi_add: 0.25,
  eq: [[0, 1.00], [8, 1.015], [24, 1.035], [44, 1.045], [60, 1.04]],
  y10_add: [[0, 0.0], [60, 0.0]],
  sector_tilt: { tech: 0.02, comm: 0.01, discretionary: 0.015, industrials: 0.02, materials: 0.035, financials: 0.005, realestate: 0.015, utilities: 0.005, energy: 0.02, healthcare: 0.01, staples: 0.01 },
  commod_tilt: { gold: 0.12, wti: 0.08, natgas: 0.04, copper: 0.10, uranium: 0.05, silver: 0.14, agriculture: 0.08 },
  hy_mult: 0.94, vix_mult: 0.96, unemp_add: -0.10, fed_add: -0.05,
  reit_tilt: { comm_reit: 0.03, res_reit: 0.04 },
  btc_mult: 1.25,
  desc: 'The dollar weakens (DXY ~88-92) as global liquidity expands. Commodities rally (gold, copper, oil all priced in USD), EM capital flows improve, and US multinationals see FX tailwinds on overseas earnings. Bitcoin surges as a dollar-debasement trade. Analog: 2002-08, 2017-18, 2020-21.',
};
USD['neutral'] = {
  name: 'Dollar neutral',
  short: 'DXY holds near 100-106 — range-bound',
  cpi_add: 0.0,
  eq: [[0, 1.00], [60, 1.00]],
  y10_add: [[0, 0.0], [60, 0.0]],
  sector_tilt: zeroTilt(SECTORS),
  commod_tilt: zeroTilt(COMK),
  hy_mult: 1.0, vix_mult: 1.0, unemp_add: 0.0, fed_add: 0.0,
  reit_tilt: { comm_reit: 0.0, res_reit: 0.0 },
  btc_mult: 1.0,
  desc: 'The status-quo baseline. The dollar holds range-bound (DXY ~100-106), neither amplifying nor dampening the macro picture. No incremental FX-driven shock.',
};
USD['strong'] = {
  name: 'Strong dollar',
  short: 'DXY surges to 112-118 — EM stress, commodity headwinds',
  cpi_add: -0.35,
  eq: [[0, 1.00], [8, 0.988], [20, 0.968], [36, 0.958], [60, 0.962]],
  y10_add: [[0, 0.0], [8, 0.05], [24, 0.10], [40, 0.08], [60, 0.06]],
  sector_tilt: { tech: -0.03, comm: -0.02, discretionary: -0.02, industrials: -0.02, materials: -0.04, financials: -0.015, realestate: -0.02, utilities: 0.005, energy: -0.03, healthcare: -0.005, staples: -0.005 },
  // Increased gold suppression: DXY strength is a second headwind on gold alongside real yields
  commod_tilt: { gold: -0.18, wti: -0.12, natgas: -0.06, copper: -0.14, uranium: -0.06, silver: -0.12, agriculture: -0.08 },
  hy_mult: 1.15, vix_mult: 1.08, unemp_add: 0.20, fed_add: 0.10,
  reit_tilt: { comm_reit: -0.04, res_reit: -0.03 },
  // Increased BTC penalty: strong dollar tightens global liquidity and USD-denominated alt assets
  btc_mult: 0.65,
  desc: 'The dollar surges (DXY 112-118) — the "wrecking ball." Commodities crater (gold, copper, oil all fall in dollar terms), EM debt stress builds, US multinational earnings get crushed by FX translation, and Bitcoin sells off as global liquidity tightens. Analog: 2014-15, 2022, 1997 Asian crisis.',
};

// ---------- Dial 10: Robotics & Drone Investment ----------
const ROBO: Record<string, Dial> = {};
ROBO['low'] = {
  name: 'Low automation',
  short: 'Traditional labor markets — no step-change in robotics/drone deployment',
  cpi_add: 0.0,
  eq: [[0, 1.00], [60, 1.00]],
  sector_tilt: zeroTilt(SECTORS),
  commod_tilt: zeroTilt(COMK),
  unemp_add: 0.0,
  vix_mult: 1.0,
  desc: 'The status-quo baseline. Robotics and drone adoption continues at its existing historical pace. Traditional labor markets are intact and automation capex is not a market-moving factor over the five-year horizon.',
};
ROBO['moderate'] = {
  name: 'Steady automation',
  short: 'Logistics & manufacturing robotics — copper and industrials bid',
  cpi_add: -0.20,
  eq: [[0, 1.00], [12, 1.008], [30, 1.018], [60, 1.030]],
  sector_tilt: { industrials: 0.025, tech: 0.015, energy: 0.010, healthcare: 0.008, materials: 0.012, comm: -0.005, discretionary: -0.012, financials: 0.005, realestate: 0.0, utilities: 0.005, staples: 0.003 },
  commod_tilt: { copper: 0.08, silver: 0.04, uranium: 0.03, natgas: 0.02, gold: -0.01, wti: 0.01, agriculture: -0.02 },
  unemp_add: 0.15,
  vix_mult: 0.97,
  desc: 'Robotics adoption accelerates in logistics, warehousing and manufacturing. Copper demand rises on motor/sensor demand; automation shaves ~0.2pp off goods inflation. Industrials and tech benefit; discretionary faces mild labor-displacement headwinds as manufacturing jobs automate faster than new roles appear.',
};
ROBO['surge'] = {
  name: 'Robotics & drone boom',
  short: 'Mass deployment — manufacturing, delivery, defense, agriculture',
  cpi_add: -0.50,
  eq: [[0, 1.00], [8, 1.012], [20, 1.032], [36, 1.055], [60, 1.075]],
  sector_tilt: { industrials: 0.055, tech: 0.035, energy: 0.022, healthcare: 0.015, materials: 0.025, comm: -0.012, discretionary: -0.030, financials: 0.010, realestate: -0.005, utilities: 0.012, staples: 0.008 },
  commod_tilt: { copper: 0.18, silver: 0.10, uranium: 0.07, natgas: 0.04, gold: -0.02, wti: 0.02, agriculture: -0.05 },
  unemp_add: 0.40,
  vix_mult: 1.03,
  desc: 'A robotics and drone investment boom drives mass deployment across manufacturing, last-mile delivery, defense systems and precision agriculture. Copper surges on motor/sensor demand; automation deflates goods prices ~0.5pp. Industrials and tech win big; discretionary faces structural labor-displacement headwinds.',
};

// ---------- bond/cash total-return builders ----------
function deriveTr(y: number[], dur: number, spread: number[] | null = null, sdur: number | null = null, deflt = false): number[] {
  const idx = [100.0];
  for (let t = 1; t < 61; t++) {
    const carry = (y[t - 1] + (spread ? spread[t - 1] / 100 : 0.0)) / 1200.0;
    const price = -dur * (y[t] - y[t - 1]) / 100.0;
    const sret = spread && sdur !== null ? -(sdur * (spread[t] - spread[t - 1]) / 10000.0) : 0.0;
    const dd = deflt && spread ? (Math.max(0.0, spread[t - 1] - 450) / 10000.0 * 0.55 / 12.0) : 0.0;
    idx.push(idx[idx.length - 1] * (1.0 + carry + price + sret - dd));
  }
  return idx;
}

function mmfTr(fed: number[]): number[] {
  const idx = [100.0];
  for (let t = 1; t < 61; t++) idx.push(idx[idx.length - 1] * (1.0 + (fed[t] + 0.12) / 1200.0));
  return idx;
}

function sgovTr(fed: number[]): number[] {
  const idx = [100.0];
  for (let t = 1; t < 61; t++) idx.push(idx[idx.length - 1] * (1.0 + (fed[t] + 0.05) / 1200.0));
  return idx;
}

const range61 = Array.from({ length: 61 }, (_, m) => m);
const get = (obj: Record<string, number> | undefined, k: string): number => (obj && k in obj ? obj[k] : 0.0);

// CPython 3.12+ `sum()` uses Neumaier compensated summation for floats, which
// is more accurate than a naive left fold. Replicate it so the rounded series
// match the Python reference bit-for-bit.
function pySum(vals: number[]): number {
  let s = 0.0, c = 0.0;
  for (const v of vals) {
    const t = s + v;
    if (Math.abs(s) >= Math.abs(v)) c += (s - t) + v;
    else c += (v - t) + s;
    s = t;
  }
  return s + c;
}

export { build, COMK, SECTORS, pyRound };

function build(sevk: string, infk: string, fedk: string, gdpk: string, tark: string,
  geok: string, jgbk: string, fisk: string, usdk: string): Record<string, number[]> {
  const sv = SEV[sevk], inf = INF[infk], fd = FED[fedk], gd = GDP[gdpk],
    tr = TAR[tark], ge = GEO[geok], jg = JGB[jgbk], fi = FISCAL[fisk], us = USD[usdk];
  const melt: boolean = sv.is_melt === true;
  const s: Record<string, number[]> = {};
  const eqm_i = ser(inf.eq_mult), eqm_f = ser(fd.eq), eqm_g = ser(gd.eq), eqm_t = ser(tr.eq),
    eqm_geo = ser(ge.eq), eqm_jgb = ser(jg.eq), eqm_fi = ser(fi.eq), eqm_us = ser(us.eq);
  const eqm = range61.map((m) => eqm_i[m] * eqm_f[m] * eqm_g[m] * eqm_t[m] * eqm_geo[m] * eqm_jgb[m] * eqm_fi[m] * eqm_us[m]);
  const tilt_ramp = range61.map((m) => Math.min(1.0, m / 14.0));
  for (const k of EQ) {
    const b = ser(sv[k]);
    const tilt_factor = range61.map((m) =>
      (1.0 + get(tr.sector_tilt, k) * tilt_ramp[m]) *
      (1.0 + get(ge.sector_tilt, k) * tilt_ramp[m]) *
      (1.0 + get(jg.sector_tilt, k) * tilt_ramp[m]) *
      (1.0 + get(fi.sector_tilt, k) * tilt_ramp[m]) *
      (1.0 + get(us.sector_tilt, k) * tilt_ramp[m]));
    s[k] = range61.map((m) => b[m] * eqm[m] * tilt_factor[m]);
  }
  s.sp500 = range61.map((m) => 0.45 * s.ai_complex[m] + 0.55 * s.ex_ai[m]);
  s.sp500_level = range61.map((m) => SP0 * s.sp500[m] / 100.0);

  const cpi_b = ser(inf.cpi);
  const a_sev = rampscalar(sv.cpi_sev, 14);
  const a_fed = rampscalar(fd.cpi_add, 14);
  const a_gdp = rampscalar(gd.cpi_add, 16);
  const a_tar = rampscalar(tr.cpi_add, 12);
  const a_geo = rampscalar(ge.cpi_add, 14);
  const a_jgb = rampscalar(jg.cpi_add, 14);
  const a_fi = rampscalar(fi.cpi_add, 14);
  const a_us = rampscalar(us.cpi_add, 14);
  s.cpi = range61.map((m) => Math.max(0.2, cpi_b[m] + a_sev[m] + a_fed[m] + a_gdp[m] + a_tar[m] + a_geo[m] + a_jgb[m] + a_fi[m] + a_us[m]));

  const fed_base = ser(fd.path);
  const fed_tar = rampscalar(tr.fed_add, 14);
  const fed_geo = rampscalar(ge.fed_add, 16);
  const fed_jgb = rampscalar(jg.fed_add, 16);
  const fed_fi = rampscalar(fi.fed_add, 14);
  const fed_us = rampscalar(us.fed_add, 14);
  s.fed_funds = range61.map((m) => Math.max(0.25, fed_base[m] + fed_tar[m] + fed_geo[m] + fed_jgb[m] + fed_fi[m] + fed_us[m]));

  const uw = melt ? 0.30 : 1.0;
  const ub = ser(sv.unemployment), ui = ser(inf.unemp_add), ug = rampscalar(gd.unemp, 14);
  const ut = rampscalar(tr.unemp_add, 14);
  const ugg = rampscalar(ge.unemp_add, 14);
  const ujg = rampscalar(jg.unemp_add, 14);
  const ufi = rampscalar(fi.unemp_add, 14);
  const uus = rampscalar(us.unemp_add, 14);
  s.unemployment = range61.map((m) => Math.max(3.2, ub[m] + uw * ui[m] + uw * ug[m] + ut[m] + ugg[m] + ujg[m] + ufi[m] + uus[m]));

  const y10_jgb = ser(jg.y10_add);
  const y10_fi = ser(fi.y10_add);
  const y10_us = ser(us.y10_add);
  s.ust10_yield = range61.map((m) => Math.max(0.4, s.fed_funds[m] + 0.975
    + 0.45 * (s.cpi[m] - 3.0)
    - 0.18 * (s.unemployment[m] - 4.3)
    + y10_jgb[m] + y10_fi[m] + y10_us[m]));

  const sm = gd.spread_mult, tm = tr.hy_inf_mult, gm = ge.hy_mult, jm = jg.hy_mult, fm = fi.hy_mult, um = us.hy_mult;
  s.hy_spread = ser(sv.hy_spread).map((v) => 320 + (v - 320) * inf.hy_inf_mult * sm * tm * gm * jm * fm * um);
  s.ig_spread = ser(sv.ig_spread).map((v) => 95 + (v - 95) * inf.ig_inf_mult * sm * (1.0 + (tm - 1.0) * 0.5) * (1.0 + (gm - 1.0) * 0.5) * (1.0 + (jm - 1.0) * 0.5) * (1.0 + (fm - 1.0) * 0.5) * (1.0 + (um - 1.0) * 0.5));

  s.ust10_tr = deriveTr(s.ust10_yield, 8.2);
  s.ust_long_tr = deriveTr(s.ust10_yield, 17.5);
  s.ig_tr = deriveTr(s.ust10_yield, 7.6, s.ig_spread, 7.6);
  s.hy_tr = deriveTr(s.ust10_yield, 3.9, s.hy_spread, 3.9, true);
  s.mmf_tr = mmfTr(s.fed_funds);
  s.sgov_tr = sgovTr(s.fed_funds);
  s.ust2_yield = range61.map((m) => 0.55 * s.fed_funds[m] + 0.45 * s.ust10_yield[m]);
  s.ust2_tr = deriveTr(s.ust2_yield, 1.9);
  s.ust5_yield = range61.map((m) => 0.40 * s.fed_funds[m] + 0.60 * s.ust10_yield[m]);
  s.ust5_tr = deriveTr(s.ust5_yield, 4.5);
  s.ust30_yield = range61.map((m) => s.ust10_yield[m] + 0.45);
  s.ust30_tr = deriveTr(s.ust30_yield, 19.0);
  s.ust_edv_tr = deriveTr(s.ust10_yield, 24.0);
  s.agg_tr = deriveTr(s.ust10_yield, 6.0);
  const realy = range61.map((m) => s.ust10_yield[m] - s.cpi[m]);
  const tips = [100.0];
  for (let t = 1; t < 61; t++) {
    tips.push(tips[tips.length - 1] * (1.0 + realy[t - 1] / 1200.0 + s.cpi[t] / 1200.0 - 6.5 * (realy[t] - realy[t - 1]) / 100.0));
  }
  s.tips_tr = tips;

  s.mmf_assets = ser(sv.mmf_assets).map((v) => 7.0 + (v - 7.0) * inf.mmf_asset_mult * gd.mmf_mult);

  let cbase: Record<string, number[]>;
  let tilt: number[];
  if (melt) {
    cbase = Object.fromEntries(COMK.map((k) => [k, ser(sv.commod[k])]));
    tilt = rampscalar(({ down: -0.10, sticky: 0.0, high: 0.32 } as Record<string, number>)[infk], 14);
  } else {
    cbase = Object.fromEntries(COMK.map((k) => [k, ser(inf[k])]));
    tilt = new Array(61).fill(0.0);
  }
  const demr = rampscalar(sv.dem_shift, 12);
  const gdpc = rampscalar(gd.commod, 14);
  const halfg = gdpc.map((x) => 0.4 * x);
  const goldr = rampscalar(sv.gold_shift, 12);
  const fedg = rampscalar(fd.gold_mult, 14);
  const uranr = rampscalar(sv.uran_shift, 12);
  const silvr = rampscalar(sv.silver_shift, 12);
  const agr = rampscalar(sv.ag_shift, 12);
  const tt = Object.fromEntries(COMK.map((k) => [k, rampscalar(get(tr.commod_tilt, k), 12)]));
  const tgg = Object.fromEntries(COMK.map((k) => [k, rampscalar(get(ge.commod_tilt, k), 14)]));
  const tjg = Object.fromEntries(COMK.map((k) => [k, rampscalar(get(jg.commod_tilt, k), 14)]));
  const tfi = Object.fromEntries(COMK.map((k) => [k, rampscalar(get(fi.commod_tilt, k), 14)]));
  const tus = Object.fromEntries(COMK.map((k) => [k, rampscalar(get(us.commod_tilt, k), 14)]));
  const cc = (k: string, ...adds: number[][]): number[] =>
    range61.map((m) => cbase[k][m] * (1.0 + pySum(adds.map((a) => a[m]))));
  s.gold = cc('gold', goldr, fedg, tilt, tt.gold, tgg.gold, tjg.gold, tfi.gold, tus.gold);
  s.wti = cc('wti', demr, gdpc, tilt, tt.wti, tgg.wti, tjg.wti, tfi.wti, tus.wti);
  s.natgas = cc('natgas', demr, gdpc, tilt, tt.natgas, tgg.natgas, tjg.natgas, tfi.natgas, tus.natgas);
  s.copper = cc('copper', demr, gdpc, tilt, tt.copper, tgg.copper, tjg.copper, tfi.copper, tus.copper);
  s.uranium = cc('uranium', uranr, gdpc, tilt, tt.uranium, tgg.uranium, tjg.uranium, tfi.uranium, tus.uranium);
  s.silver = cc('silver', silvr, halfg, tilt, tt.silver, tgg.silver, tjg.silver, tfi.silver, tus.silver);
  s.agriculture = cc('agriculture', agr, tilt, tt.agriculture, tgg.agriculture, tjg.agriculture, tfi.agriculture, tus.agriculture);

  s.vix = ser(sv.vix).map((v) => Math.min(95, Math.max(9, v * inf.vix_mult * gd.vix_mult * tr.vix_mult * ge.vix_mult * jg.vix_mult * fi.vix_mult * us.vix_mult)));

  // --- REITs (Commercial & Residential) ---
  const reit_base_eq = eqm;
  // Reduced from 8.5/5.5 — REITs reprice to higher cap rates within 1-2yrs and then
  // recover income. The original values caused 5yr drawdowns of -60% in rate hike
  // scenarios, vs the historical 2022 peak REIT drawdown of ~25-30%.
  const comm_reit_rate_sens = 5.5;
  const res_reit_rate_sens = 3.5;
  const y10_chg = range61.map((m) => s.ust10_yield[m] - s.ust10_yield[0]);
  const comm_reit_rate = range61.map((m) => -comm_reit_rate_sens * y10_chg[m] / 100.0);
  const res_reit_rate = range61.map((m) => -res_reit_rate_sens * y10_chg[m] / 100.0);
  const comm_reit_tilt = range61.map((m) => (1.0 + fi.reit_tilt.comm_reit * tilt_ramp[m]) * (1.0 + us.reit_tilt.comm_reit * tilt_ramp[m]));
  const res_reit_tilt = range61.map((m) => (1.0 + fi.reit_tilt.res_reit * tilt_ramp[m]) * (1.0 + us.reit_tilt.res_reit * tilt_ramp[m]));
  s.comm_reit = range61.map((m) => 100.0 * (1.0 + comm_reit_rate[m]) * reit_base_eq[m] * comm_reit_tilt[m]);
  s.res_reit = range61.map((m) => 100.0 * (1.0 + res_reit_rate[m]) * reit_base_eq[m] * res_reit_tilt[m]);

  // --- Bitcoin ---
  // Reduced from 2.2 to 1.8 — 2022 data showed BTC fell ~65-75% while S&P fell ~20%,
  // implying a beta of ~3-3.5 on the drawdown but ~1.8 on a 5yr total-return basis.
  const btc_eq_beta = 1.8;
  const btc_base = range61.map((m) => 100.0 * (1.0 + btc_eq_beta * (eqm[m] - 1.0)));
  const btc_fi = fi.btc_mult;
  const btc_us = us.btc_mult;
  const btc_ramp_fi = range61.map((m) => 1.0 + (btc_fi - 1.0) * tilt_ramp[m]);
  const btc_ramp_us = range61.map((m) => 1.0 + (btc_us - 1.0) * tilt_ramp[m]);
  s.bitcoin = range61.map((m) => btc_base[m] * btc_ramp_fi[m] * btc_ramp_us[m]);

  const cum = [1.0];
  for (let t = 1; t < 61; t++) cum.push(cum[cum.length - 1] * (1.0 + s.cpi[t] / 1200.0));
  s.cpi_index = cum.map((c) => pyRound(c * 100, 2));
  s.sp500_real = range61.map((m) => s.sp500[m] / cum[m]);
  s.mmf_real = range61.map((m) => s.mmf_tr[m] / cum[m]);
  s.ust10_real = range61.map((m) => s.ust10_tr[m] / cum[m]);
  s.port_6040 = range61.map((m) => 0.6 * s.sp500[m] + 0.4 * s.ust10_tr[m]);

  for (const k of Object.keys(s)) {
    if (k !== 'cpi_index') s[k] = s[k].map((v) => pyRound(v, 2));
  }
  return s;
}

function dd(arr: number[]): [number, number, number] {
  let peak = arr[0], pi = 0, worst = 0.0, wp = 0, wt = 0;
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (v > peak) { peak = v; pi = i; }
    const x = (v - peak) / peak * 100;
    if (x < worst) { worst = x; wp = pi; wt = i; }
  }
  return [pyRound(worst, 1), wp, wt];
}

const PHASES: Record<string, any> = {
  melt: [
    { name: 'Acceleration', m0: 0, m1: 10, desc: 'AI capex and earnings keep beating; the melt-up gathers pace and breadth narrows.' },
    { name: 'First wobble', m0: 10, m1: 16, desc: 'A sharp ~15% correction scares everyone, then it resumes.' },
    { name: 'Mania', m0: 16, m1: 34, desc: 'Valuations detach; retail piles in; index concentration hits historic extremes.' },
    { name: 'Late-cycle shakeout', m0: 34, m1: 46, desc: 'Another correction; bulls keep winning; the last bears capitulate.' },
    { name: 'Peak euphoria', m0: 46, m1: 60, desc: 'The bubble at maximum inflation and maximum fragility.' },
  ],
  mild: [
    { name: 'Froth peaks', m0: 0, m1: 3, desc: 'AI names make a final high on momentum; breadth already narrowing.' },
    { name: 'AI repricing', m0: 3, m1: 14, desc: 'Earnings disappoint vs. capex; the AI multiple compresses 30-40%.' },
    { name: 'The rotation', m0: 14, m1: 30, desc: 'Money leaves AI for value, staples and cash. Index barely dented.' },
    { name: 'Broadening recovery', m0: 30, m1: 60, desc: 'Profitable AI survivors re-rate; bull market resumes on wider breadth.' },
  ],
  base: [
    { name: 'Blow-off top', m0: 0, m1: 4, desc: 'Euphoria peak. AI runs another ~18%; "this time is different."' },
    { name: 'The crack', m0: 4, m1: 11, desc: 'A flagship AI monetization miss breaks the narrative. First -25% leg, then a bear-rally head-fake.' },
    { name: 'Contagion & capitulation', m0: 11, m1: 34, desc: 'Capex cancellations, AI-debt downgrades, recession. A 2.5-year grind to the lows.' },
    { name: 'The bottom', m0: 34, m1: 36, desc: 'Peak unemployment, peak fear. S&P near its trough.' },
    { name: 'New leadership', m0: 36, m1: 60, desc: 'Recovery led by value, defensives and the few real AI survivors.' },
  ],
  severe: [
    { name: 'Final melt-up', m0: 0, m1: 2, desc: 'A blow-off spike on leverage and circular AI vendor-financing.' },
    { name: 'The crash', m0: 2, m1: 9, desc: 'Narrative snaps. AI complex halves in months as forced selling cascades.' },
    { name: 'Credit crisis', m0: 9, m1: 14, desc: '~$1.4T of AI-linked debt detonates: data-center SPV defaults, a major neocloud bankruptcy.' },
    { name: 'The bottom', m0: 14, m1: 20, desc: 'VIX >70, unemployment surges.' },
    { name: 'Liquidity recovery', m0: 20, m1: 60, desc: 'A sharp bounce, then a slow grind.' },
  ],
};

const PRESETS = [
  { id: 'dotcom', name: 'Dot-com 2000-02', tag: 'The textbook bust', color: '#58a6ff',
    dials: { sev: 'base', inf: 'down', fed: 'cut', gdp: 'recession', tar: 'deescalate', geo: 'stable', jgb: 'anchored', fis: 'neutral', usd: 'neutral', rob: 'low' },
    desc: 'A dot-com-scale AI bust into disinflation, with the Fed free to cut to ~1%. Every textbook hedge works: bonds rally, cash holds real value, gold rises modestly. The benign historical analog and the playbook everyone still has in mind.' },
  { id: 'stagflation70s', name: '1970s Stagflation', tag: 'Inflation eats everything', color: '#f0883e',
    dials: { sev: 'mild', inf: 'high', fed: 'hold', gdp: 'hard', tar: 'escalate', geo: 'tension', jgb: 'anchored', fis: 'stimulus', usd: 'weak', rob: 'low' },
    desc: 'CPI runs hot for years, the Fed is paralyzed, growth stalls and tariffs add a goods-price tax. Geopolitical tension (an OPEC-style shock) is the catalyst for the energy spike. Paper assets bleed in real terms; real assets and energy lead.' },
  { id: 'gfc2008', name: '2008 GFC', tag: 'Credit crisis + Fed rescue', color: '#f85149',
    dials: { sev: 'severe', inf: 'sticky', fed: 'cut', gdp: 'hard', tar: 'deescalate', geo: 'stable', jgb: 'anchored', fis: 'stimulus', usd: 'strong', rob: 'low' },
    desc: 'The ~$1.4T of AI-linked debt detonates the way subprime did in 2008. Severe credit shock, spreads explode, but the Fed rushes in and crushes rates. Long Treasuries win violently, and equities still take years to recover.' },
  { id: 'volcker', name: 'Volcker 1979-82', tag: 'Hike-into-the-spike', color: '#bc8cff',
    dials: { sev: 'base', inf: 'high', fed: 'hike', gdp: 'recession', tar: 'deescalate', geo: 'tension', jgb: 'anchored', fis: 'austerity', usd: 'strong', rob: 'low' },
    desc: 'High inflation meets a Volcker-style hiking response. Cold War tensions kept an energy risk premium in oil and gold throughout. Painful for equities and long bonds in the short run, but inflation breaks and savers ultimately keep their real return.' },
  { id: 'meltup', name: 'AI Melt-up continues', tag: 'The bust never comes', color: '#3fb950',
    dials: { sev: 'melt', inf: 'sticky', fed: 'hold', gdp: 'soft', tar: 'truce', geo: 'stable', jgb: 'anchored', fis: 'stimulus', usd: 'weak', rob: 'moderate' },
    desc: 'AI keeps delivering, a US-China trade deal lifts goods inflation pressure, and the Fed sits on its hands. The index melts up another 100%+, but concentration and fragility go to historic extremes.' },
  { id: 'tradewar', name: 'Trade-war Stagflation', tag: 'Tariffs amplify the bust', color: '#e3a72c',
    dials: { sev: 'severe', inf: 'high', fed: 'hold', gdp: 'hard', tar: 'escalate', geo: 'tension', jgb: 'anchored', fis: 'austerity', usd: 'strong', rob: 'low' },
    desc: 'A 60%+ tariff regime hits at the same time the AI bubble breaks. Geopolitical tension adds an energy risk premium on top. Goods inflation surges into a deep recession; the Fed is trapped. Worst-of-both-worlds for a 60/40 portfolio.' },
  { id: 'softlanding', name: 'Soft landing', tag: 'Goldilocks', color: '#2dd4bf',
    dials: { sev: 'mild', inf: 'down', fed: 'cut', gdp: 'soft', tar: 'truce', geo: 'stable', jgb: 'anchored', fis: 'neutral', usd: 'weak', rob: 'low' },
    desc: 'AI repricing without contagion, inflation falls, the Fed eases, a trade deal lands, unemployment barely budges. The benign corner of all scenarios, the outcome every soft-landing bull is pricing.' },
  { id: 'policyerror', name: 'Policy error', tag: 'Easing into a tariff inflation', color: '#f85149',
    dials: { sev: 'base', inf: 'high', fed: 'cut', gdp: 'recession', tar: 'escalate', geo: 'tension', jgb: 'anchored', fis: 'stimulus', usd: 'weak', rob: 'low' },
    desc: 'The Fed cuts to support a falling stock market right as tariff escalation and geopolitical tension push goods and energy inflation higher. Inflation entrenches, the long end revolts, and the dollar weakens. A real-terms wipeout for cash and bonds alike.' },
  { id: 'warshock', name: 'Global Conflict Shock', tag: 'War + bust + stagflation', color: '#f85149',
    dials: { sev: 'severe', inf: 'high', fed: 'hold', gdp: 'hard', tar: 'escalate', geo: 'conflict', jgb: 'anchored', fis: 'stimulus', usd: 'strong', rob: 'low' },
    desc: 'A major geopolitical conflict detonates simultaneously with the AI bust. Energy and food prices surge; supply chains fracture. The Fed is trapped between collapsing growth and surging prices. Equities, bonds and cash all lose real value. Only gold, natgas and agriculture protect purchasing power.' },
  { id: 'carryunwind', name: 'Yen Carry Unwind', tag: 'JGB crisis hits the bust', color: '#f0883e',
    dials: { sev: 'base', inf: 'sticky', fed: 'cut', gdp: 'recession', tar: 'deescalate', geo: 'stable', jgb: 'crisis', fis: 'neutral', usd: 'strong', rob: 'low' },
    desc: 'The Bank of Japan loses control of its bond market right as the AI bubble cracks. A disorderly JGB selloff triggers a violent unwind of the yen-carry trade; Japanese capital floods home, dumping US Treasuries. The US 10-year spikes more than 1pp ON TOP of the Fed path — so even with the Fed cutting, the long bond does NOT rescue the portfolio. Carry-funded tech is hit hardest and the VIX spikes.' },
  { id: 'rateshock2022', name: '2022 Rate Shock', tag: 'Fed hikes + strong dollar', color: '#f85149',
    dials: { sev: 'mild', inf: 'high', fed: 'hike', gdp: 'soft', tar: 'escalate', geo: 'tension', jgb: 'normalization', fis: 'austerity', usd: 'strong', rob: 'low' },
    desc: 'The 2022 analog: the Fed hikes aggressively into sticky inflation while the dollar surges. TLT lost -31% in 2022, REITs -25%, Bitcoin -65%. Commodities held (inflation hedge), but duration assets were crushed. Validates the model against the worst bond year in history.' },
  { id: 'autoShock', name: 'Automation Shock', tag: 'Robots, deflation & job displacement', color: '#2dd4bf',
    dials: { sev: 'mild', inf: 'down', fed: 'cut', gdp: 'soft', tar: 'truce', geo: 'stable', jgb: 'anchored', fis: 'stimulus', usd: 'neutral', rob: 'surge' },
    desc: 'A robotics and drone investment boom deflates goods prices, boosts productivity and triggers labor displacement across manufacturing and logistics. The Fed cuts into falling CPI; a trade truce and fiscal stimulus cushion the employment shock. Industrials, tech and copper win big; discretionary faces structural headwinds.' },
];

// ---------- formatting helpers for the diagnostic report ----------
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
function fnum(v: number, decimals: number | null, width: number, sign = false): string {
  let str = decimals === null ? String(v) : v.toFixed(decimals);
  if (sign && v >= 0) str = '+' + str;
  return str.padStart(width, ' ');
}
const padr = (s: string, n: number) => s.padEnd(n, ' ');

function main(): void {
  const out: any = { dates: DATES, sp0: SP0, scenarios: {}, summary: {} };
  for (const sevk of Object.keys(SEV)) {
    out.scenarios[sevk] = {}; out.summary[sevk] = {};
    for (const infk of Object.keys(INF)) {
      out.scenarios[sevk][infk] = {}; out.summary[sevk][infk] = {};
      for (const fedk of Object.keys(FED)) {
        out.scenarios[sevk][infk][fedk] = {}; out.summary[sevk][infk][fedk] = {};
        for (const gdpk of Object.keys(GDP)) {
          out.scenarios[sevk][infk][fedk][gdpk] = {}; out.summary[sevk][infk][fedk][gdpk] = {};
          for (const tark of Object.keys(TAR)) {
            out.scenarios[sevk][infk][fedk][gdpk][tark] = {}; out.summary[sevk][infk][fedk][gdpk][tark] = {};
            for (const geok of Object.keys(GEO)) {
              out.scenarios[sevk][infk][fedk][gdpk][tark][geok] = {}; out.summary[sevk][infk][fedk][gdpk][tark][geok] = {};
              for (const jgbk of Object.keys(JGB)) {
                out.scenarios[sevk][infk][fedk][gdpk][tark][geok][jgbk] = {}; out.summary[sevk][infk][fedk][gdpk][tark][geok][jgbk] = {};
                for (const fisk of Object.keys(FISCAL)) {
                  out.scenarios[sevk][infk][fedk][gdpk][tark][geok][jgbk][fisk] = {};
                  out.summary[sevk][infk][fedk][gdpk][tark][geok][jgbk][fisk] = {};
                  for (const usdk of Object.keys(USD)) {
                    const s = build(sevk, infk, fedk, gdpk, tark, geok, jgbk, fisk, usdk);
                    out.scenarios[sevk][infk][fedk][gdpk][tark][geok][jgbk][fisk][usdk] = s;
                    const [spd, sppk, sptr] = dd(s.sp500);
                    const [aid] = dd(s.ai_complex);
                    const [exd] = dd(s.ex_ai);
                    const [hyd] = dd(s.hy_tr);
                    const [ltd] = dd(s.ust_long_tr);
                    const [p64d] = dd(s.port_6040);
                    const secdd: Record<string, number> = {};
                    for (const x of SECTORS) secdd[x] = dd(s[x])[0];
                    const cpi60 = s.cpi_index[60] / 100.0;
                    out.summary[sevk][infk][fedk][gdpk][tark][geok][jgbk][fisk][usdk] = {
                      sp_drawdown: spd, sp_peak_m: sppk, sp_trough_m: sptr,
                      sp_peak_level: pyRound(s.sp500_level[sppk]),
                      sp_trough_level: pyRound(s.sp500_level[sptr]),
                      sp_peak_date: DATES[sppk], sp_trough_date: DATES[sptr],
                      sp_end_level: pyRound(s.sp500_level[60]),
                      sp_5yr: pyRound(s.sp500[60] - 100, 1),
                      sp_real_5yr: pyRound(s.sp500_real[60] - 100, 1),
                      ai_drawdown: aid, exai_drawdown: exd, hy_drawdown: hyd,
                      long_tr_drawdown: ltd,
                      port_6040_drawdown: p64d, port_6040_5yr: pyRound(s.port_6040[60] - 100, 1),
                      mmf_5yr: pyRound(s.mmf_tr[60] - 100, 1),
                      mmf_real_5yr: pyRound(s.mmf_real[60] - 100, 1),
                      mmf_peak_assets: pyRound(Math.max(...s.mmf_assets), 2),
                      ust10_5yr: pyRound(s.ust10_tr[60] - 100, 1),
                      ust10_real_5yr: pyRound(s.ust10_real[60] - 100, 1),
                      ust10_peak: pyRound(Math.max(...s.ust10_tr) - 100, 1),
                      long_5yr: pyRound(s.ust_long_tr[60] - 100, 1),
                      long_peak: pyRound(Math.max(...s.ust_long_tr) - 100, 1),
                      gold_5yr: pyRound((s.gold[60] - s.gold[0]) / s.gold[0] * 100, 1),
                      cpi_peak: pyRound(Math.max(...s.cpi), 1),
                      cpi_5yr_cum: pyRound(s.cpi_index[60] - 100, 1),
                      fed_low: pyRound(Math.min(...s.fed_funds), 2),
                      fed_high: pyRound(Math.max(...s.fed_funds), 2),
                      fed_end: pyRound(s.fed_funds[60], 2),
                      y10_low: pyRound(Math.min(...s.ust10_yield), 2),
                      y10_high: pyRound(Math.max(...s.ust10_yield), 2),
                      unemp_peak: pyRound(Math.max(...s.unemployment), 1),
                      vix_peak: pyRound(Math.max(...s.vix)),
                      wti_low: pyRound(Math.min(...s.wti), 1), wti_high: pyRound(Math.max(...s.wti), 1),
                      hy_spread_peak: pyRound(Math.max(...s.hy_spread)),
                      sec_dd: Object.fromEntries(Object.entries(secdd).map(([k, v]) => [k, pyRound(v, 1)])),
                      best_sector: Object.keys(secdd).reduce((a, b) => (secdd[b] > secdd[a] ? b : a)),
                      worst_sector: Object.keys(secdd).reduce((a, b) => (secdd[b] < secdd[a] ? b : a)),
                      commod: Object.fromEntries(COMK.map((c) => [c, {
                        dd: dd(s[c])[0],
                        r5: pyRound((s[c][60] - s[c][0]) / s[c][0] * 100, 1),
                        lo: pyRound(Math.min(...s[c]), 2), hi: pyRound(Math.max(...s[c]), 2),
                      }])),
                      bondetf: Object.fromEntries(['mmf_tr', 'sgov_tr', 'ust2_tr', 'ust5_tr', 'ust10_tr',
                        'ust30_tr', 'ust_long_tr', 'ust_edv_tr', 'agg_tr', 'ig_tr', 'hy_tr', 'tips_tr'].map((e) => [e, {
                          dd: dd(s[e])[0], r5: pyRound(s[e][60] - 100, 1),
                          r5real: pyRound((s[e][60] / s[e][0]) / cpi60 * 100 - 100, 1),
                          peak: pyRound(Math.max(...s[e]) - 100, 1),
                        }])),
                      reit: Object.fromEntries(['comm_reit', 'res_reit'].map((r) => [r, {
                        dd: dd(s[r])[0],
                        r5: pyRound((s[r][60] - s[r][0]) / s[r][0] * 100, 1),
                        r5real: pyRound((s[r][60] / s[r][0]) / cpi60 * 100 - 100, 1),
                      }])),
                      btc: {
                        dd: dd(s.bitcoin)[0],
                        r5: pyRound((s.bitcoin[60] - s.bitcoin[0]) / s.bitcoin[0] * 100, 1),
                        r5real: pyRound((s.bitcoin[60] / s.bitcoin[0]) / cpi60 * 100 - 100, 1),
                      },
                    };
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  out.phases = PHASES;
  out.meta = {
    sev: Object.fromEntries(Object.keys(SEV).map((k) => [k, k === 'melt' ? 'Bubble keeps growing' : cap(k)])),
    inf: Object.fromEntries(Object.keys(INF).map((k) => [k, INF[k].name])),
    fed: Object.fromEntries(Object.keys(FED).map((k) => [k, FED[k].name])),
    gdp: Object.fromEntries(Object.keys(GDP).map((k) => [k, GDP[k].name])),
    tar: Object.fromEntries(Object.keys(TAR).map((k) => [k, TAR[k].name])),
    geo: Object.fromEntries(Object.keys(GEO).map((k) => [k, GEO[k].name])),
    jgb: Object.fromEntries(Object.keys(JGB).map((k) => [k, JGB[k].name])),
    fis: Object.fromEntries(Object.keys(FISCAL).map((k) => [k, FISCAL[k].name])),
    usd: Object.fromEntries(Object.keys(USD).map((k) => [k, USD[k].name])),
    rob: Object.fromEntries(Object.keys(ROBO).map((k) => [k, ROBO[k].name])),
  };
  out.presets = PRESETS;

  out.P = {
    SEV: { ...SEV }, INF: { ...INF }, FED: { ...FED }, GDP: { ...GDP }, TAR: { ...TAR },
    GEO: { ...GEO }, JGB: { ...JGB }, FISCAL: { ...FISCAL }, USD: { ...USD }, ROBO: { ...ROBO },
  };
  // Strip per-month series — client JS recomputes on demand; only summary stays
  delete out.scenarios;

  const argPath = process.argv[2];
  const outpath = argPath ? (isAbsolute(argPath) ? argPath : join(process.cwd(), argPath)) : join(HERE, '..', 'sim_data.json');
  writeFileSync(outpath, JSON.stringify(out));

  const bar = '='.repeat(96);
  console.log(bar);
  console.log('AI BUBBLE-BUST SIMULATION v7 - 26244 scenarios (4 sev x 3 inf x 3 Fed x 3 GDP x 3 Tar x 3 Geo x 3 JGB x 3 Fis x 3 USD)');
  console.log(bar);
  console.log('\nHEADLINE GRID  (Fed=cut, GDP=recession, Tariffs=deescalate, Geo=stable, JGB=anchored, Fiscal=neutral, USD=neutral):');
  for (const sevk of ['melt', 'mild', 'base', 'severe']) {
    for (const infk of ['down', 'sticky', 'high']) {
      const m = out.summary[sevk][infk].cut.recession.deescalate.stable.anchored.neutral.neutral;
      console.log(`  ${padr(sevk, 6)}/${padr(infk, 6)}: S&P DD ${fnum(m.sp_drawdown, null, 6)}%  5yr ${fnum(m.sp_5yr, null, 6)}% (real ${fnum(m.sp_real_5yr, null, 6)}%)`
        + `  | Fed ${m.fed_low}-${m.fed_high}%  10Y ${m.y10_low}-${m.y10_high}%  unemp ${m.unemp_peak}%`);
    }
  }
  console.log('\nDIAL 6 - GEOPOLITICS SENSITIVITY  (base / sticky / hold / recession / deescalate / */anchored/neutral/neutral):');
  for (const geok of ['stable', 'tension', 'conflict']) {
    const m = out.summary.base.sticky.hold.recession.deescalate[geok].anchored.neutral.neutral;
    console.log(`  Geo=${padr(geok, 9)}: S&P 5yr ${fnum(m.sp_5yr, null, 6)}% (real ${fnum(m.sp_real_5yr, null, 6)}%)`
      + `  | CPI peak ${fnum(m.cpi_peak, null, 4)}%  | gold ${fnum(m.gold_5yr, 1, 6, true)}%`
      + `  WTI hi $${m.wti_high.toFixed(0)}  unemp ${m.unemp_peak}%`);
  }
  console.log('\nDIAL 7 - JAPANESE BOND (JGB) SENSITIVITY  (base / sticky / Fed cut / recession / deescalate / stable / */neutral/neutral):');
  for (const jgbk of ['anchored', 'normalization', 'crisis']) {
    const m = out.summary.base.sticky.cut.recession.deescalate.stable[jgbk].neutral.neutral;
    console.log(`  JGB=${padr(jgbk, 14)}: S&P 5yr ${fnum(m.sp_5yr, null, 6)}% (real ${fnum(m.sp_real_5yr, null, 6)}%)`
      + `  | 10Y hi ${fnum(m.y10_high, null, 4)}%  | TLT 5yr ${fnum(m.bondetf.ust_long_tr.r5, 1, 6, true)}%`
      + `  60/40 5yr ${fnum(m.port_6040_5yr, 1, 6, true)}%  VIX pk ${m.vix_peak}`);
  }
  console.log('\nDIAL 8 - FISCAL POLICY SENSITIVITY  (base / sticky / Fed cut / recession / deescalate / stable / anchored / */neutral):');
  for (const fisk of ['austerity', 'neutral', 'stimulus']) {
    const m = out.summary.base.sticky.cut.recession.deescalate.stable.anchored[fisk].neutral;
    console.log(`  Fiscal=${padr(fisk, 10)}: S&P 5yr ${fnum(m.sp_5yr, null, 6)}% (real ${fnum(m.sp_real_5yr, null, 6)}%)`
      + `  | CPI peak ${fnum(m.cpi_peak, null, 4)}%  | Comm REIT 5yr ${fnum(m.reit.comm_reit.r5, 1, 6, true)}%`
      + `  BTC 5yr ${fnum(m.btc.r5, 1, 6, true)}%`);
  }
  console.log('\nDIAL 9 - USD REGIME SENSITIVITY  (base / sticky / Fed cut / recession / deescalate / stable / anchored / neutral / *):');
  for (const usdk of ['weak', 'neutral', 'strong']) {
    const m = out.summary.base.sticky.cut.recession.deescalate.stable.anchored.neutral[usdk];
    console.log(`  USD=${padr(usdk, 8)}: S&P 5yr ${fnum(m.sp_5yr, null, 6)}% (real ${fnum(m.sp_real_5yr, null, 6)}%)`
      + `  | Gold 5yr ${fnum(m.gold_5yr, 1, 6, true)}%  | BTC 5yr ${fnum(m.btc.r5, 1, 6, true)}%`
      + `  Copper 5yr ${fnum(m.commod.copper.r5, 1, 6, true)}%`);
  }
  console.log('\nNEW ASSET CLASSES CHECK  (base / sticky / Fed cut / recession / deescalate / stable / anchored / neutral / neutral):');
  let mref = out.summary.base.sticky.cut.recession.deescalate.stable.anchored.neutral.neutral;
  for (const [tag, key] of [['Commercial REIT', 'comm_reit'], ['Residential REIT', 'res_reit']] as Array<[string, string]>) {
    const r = mref.reit[key];
    console.log(`  ${padr(tag, 18)}: 5yr ${fnum(r.r5, 1, 7, true)}%  DD ${fnum(r.dd, 1, 7, true)}%  real 5yr ${fnum(r.r5real, 1, 7, true)}%`);
  }
  const btc = mref.btc;
  console.log(`  ${padr('Bitcoin', 18)}: 5yr ${fnum(btc.r5, 1, 7, true)}%  DD ${fnum(btc.dd, 1, 7, true)}%  real 5yr ${fnum(btc.r5real, 1, 7, true)}%`);
  console.log('\nBOND CURVE CHECK  (base / sticky / Fed cut / recession / deescalate / stable / anchored / neutral / neutral):');
  mref = out.summary.base.sticky.cut.recession.deescalate.stable.anchored.neutral.neutral;
  for (const [tag, key] of [['SGOV (T-bills)', 'sgov_tr'], ['SHY (2Y)', 'ust2_tr'], ['IEI (5Y)', 'ust5_tr'],
    ['IEF (10Y)', 'ust10_tr'], ['TLT (20+)', 'ust_long_tr'], ['30Y T-bond', 'ust30_tr'], ['EDV (STRIPS)', 'ust_edv_tr']] as Array<[string, string]>) {
    const b = mref.bondetf[key];
    console.log(`  ${padr(tag, 18)}: 5yr ${fnum(b.r5, 1, 7, true)}%  DD ${fnum(b.dd, 1, 7, true)}%  peak ${fnum(b.peak, 1, 7, true)}%`);
  }
  console.log(`\nPRESETS: ${PRESETS.length} historical analogs registered`);
  for (const p of PRESETS) {
    const d = p.dials;
    const m = out.summary[d.sev][d.inf][d.fed][d.gdp][d.tar][d.geo][d.jgb ?? 'anchored'][d.fis ?? 'neutral'][d.usd ?? 'neutral'];
    console.log(`  ${padr(p.name, 28)}: S&P DD ${fnum(m.sp_drawdown, null, 6)}%  5yr real ${fnum(m.sp_real_5yr, 1, 6, true)}%`
      + `  CPI peak ${fnum(m.cpi_peak, null, 4)}%  gold ${fnum(m.gold_5yr, 0, 5, true)}%`);
  }
  console.log('\n' + bar);
  console.log(`JSON written: ${outpath}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
