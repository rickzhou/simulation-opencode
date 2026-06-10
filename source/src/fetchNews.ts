#!/usr/bin/env tsx
/**
 * Fetch financial news from RSS feeds, understand each headline, and map the
 * current situation to simulation dials.
 *
 * Two models run locally via @xenova/transformers:
 *   - FinBERT (Xenova/finbert) for overall bullish/bearish sentiment, and
 *   - an NLI zero-shot classifier (Xenova/nli-deberta-v3-small) that reads the
 *     MEANING of each headline.
 *
 * The keyword lists are used only as a high-precision relevance GATE (which
 * dimension is a headline about?); the zero-shot model then decides the
 * DIRECTION within that dimension, with an explicit "not about this" escape so
 * off-topic headlines contribute nothing. This fixes the failure mode of pure
 * keyword counting, which can't read negation or paraphrase ("recession fears
 * fade" → counted as recession; "Fed cuts off the table" → counted as a cut).
 * If the NLI model can't be loaded (e.g. offline) the pipeline falls back to the
 * legacy keyword-count scoring.
 *
 * Usage:
 *   tsx fetchNews.ts            # write current_situation.json (and print JSON)
 *   tsx fetchNews.ts --stdout   # print JSON to stdout (logs go to stderr)
 *   tsx fetchNews.ts --no-nli   # force the keyword-only fallback
 */
// Mirror the Python pipeline, which used an SSL context with verification
// disabled (CERT_NONE) so flaky feed certificates never block a fetch.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import { writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import Parser from 'rss-parser';

const HERE = dirname(fileURLToPath(import.meta.url));

// Cap how many (most-recent, unique) articles get the heavier NLI treatment.
const MAX_ANALYZE = 160;
// Minimum NLI confidence for a directional verdict to count. Set above the band
// where the model produces marginal/spurious verdicts on vague headlines (~0.6),
// so only clearly-entailed readings move the dials.
const NLI_THRESHOLD = 0.7;

type Article = { title: string; summary: string; source: string; published: string };

const RSS_FEEDS: Array<[string, string]> = [
  ['CNBC Top News', 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100003114'],
  ['CNBC Economy', 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=20910258'],
  ['CNBC Finance', 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=10000664'],
  ['CNBC World', 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100727362'],
  ['Yahoo Finance', 'https://finance.yahoo.com/news/rssindex'],
  ['MarketWatch Top', 'https://feeds.content.dowjones.io/public/rss/mw_topstories'],
  ['FT Markets', 'https://www.ft.com/markets?format=rss'],
  ['FT Economy', 'https://www.ft.com/global-economy?format=rss'],
  ['Seeking Alpha', 'https://seekingalpha.com/market_currents.xml'],
  ['Investing.com', 'https://www.investing.com/rss/news.rss'],
  ['WSJ Markets', 'https://feeds.a.dj.com/rss/RSSMarketsMain.xml'],
  ['WSJ Economy', 'https://feeds.a.dj.com/rss/RSSWorldNews.xml'],
  ['Bloomberg Markets', 'https://feeds.bloomberg.com/markets/news.rss'],
  ['TheStreet', 'https://www.thestreet.com/.rss/full/'],
  ['Economist Finance', 'https://www.economist.com/finance-and-economics/rss.xml'],
  ['Motley Fool', 'https://www.fool.com/feeds/index.aspx?id=top-articles&format=rss'],
  ['ZeroHedge', 'https://feeds.feedburner.com/zerohedge/feed'],
  ['Real Clear Markets', 'https://www.realclearmarkets.com/index.xml'],
  ['ETF Trends', 'https://www.etftrends.com/feed/'],
  ['FX Street', 'https://www.fxstreet.com/rss/news'],
  ['Oil Price', 'https://oilprice.com/rss/main'],
  ['Nasdaq News', 'https://www.nasdaq.com/feed/nasdaq-original/rss.xml'],
  ['Benzinga', 'https://www.benzinga.com/feed'],
];

// Keyword lists. Primary role is the relevance GATE for the NLI classifier
// (which dimension is this headline about?); also the offline fallback scorer.
const KW: Record<string, string[]> = {
  sev_melt: ['melt-up', 'melt up', 'all-time high', 'record high', 'new high', 'rally extends',
    'bull run', 'euphoria', 'fomo', 'blow-off', 'blowoff', 'parabolic', 'surge past',
    'ai boom', 'ai rally', 'tech rally', 'nvidia beats', 'earnings beat', 'ai spending',
    'capex surge', 'hyperscaler', 'ai capex', 'ai revenue', 'ai demand', 'ai growth',
    'stocks soar', 'market soars', 'breakout', 'momentum', 'all time high'],
  sev_mild: ['correction', 'pullback', 'dip', 'growth scare', 'valuation concern', 'overvalued',
    'earnings disappoint', 'multiple compression', 'profit warning', 'revenue miss',
    'ai disappoint', 'ai monetization', 'cooling', 'slowdown', 'modest decline',
    'rotation', 'sector rotation', 'narrowing breadth', 'tech selloff', 'tech sells off'],
  sev_base: ['bubble burst', 'bubble pops', 'bust', 'crash', 'bear market', 'sell-off', 'selloff',
    'contagion', 'capitulation', 'debt crisis', 'ai debt', 'credit event', 'downgrade',
    'default wave', 'layoffs', 'recession fears', 'market tumble', 'steep decline',
    'plunge', 'sharp decline', 'widespread losses', 'panic selling', 'tumble', 'tumbles', 'sinks', 'slump'],
  sev_severe: ['financial crisis', 'systemic', 'credit crunch', 'liquidity crisis', 'bank failure',
    'cascade', 'forced selling', 'margin call', 'circuit breaker', 'flash crash',
    'black swan', 'catastrophic', 'depression', 'collapse', ' Lehman', 'contagion spreads',
    'frozen markets', 'credit freeze', 'bank run', 'insolvency', 'bailout'],
  inf_down: ['disinflation', 'inflation falls', 'inflation cools', 'cpi drops', 'cpi falls',
    'prices decline', 'deflation', 'falling prices', 'inflation eases', 'cooling inflation',
    'lower inflation', 'price drops', 'inflation slowing', 'cpi lower', 'ppi drops', 'inflation'],
  inf_sticky: ['sticky inflation', 'inflation persists', 'inflation stubborn', 'cpi holds',
    'above target', 'inflation stuck', 'persistent inflation', 'services inflation',
    'wage growth', 'shelter inflation', 'core cpi', 'supercore', 'inflation plateau'],
  inf_high: ['inflation spikes', 'inflation surges', 'cpi jumps', 'cpi surges', 'price surge',
    'stagflation', 'energy shock', 'oil shock', 'supply shock', 'soaring prices',
    'inflation accelerating', 'hot inflation', 'inflation above', 'wage-price',
    'price pressures', 'inflation fears', 'runaway inflation', 'cpi', 'ppi'],
  fed_cut: ['rate cut', 'fed cuts', 'easing', 'dovish', 'fed pivot', 'rate reduction',
    'fed lowers', 'monetary easing', 'cut rates', 'dovish pivot', 'emergency cut',
    'fed ease', 'powell', 'rate cuts', 'cutting cycle', 'fed', 'federal reserve', 'interest rate'],
  fed_hold: ['fed holds', 'rates unchanged', 'on hold', 'wait and see', 'patient', 'data dependent',
    'fed pause', 'no change', 'steady rates', 'fed steady', 'hawkish hold',
    'higher for longer', 'rates higher', 'cuts off the table', 'cuts out of reach',
    'cuts further out', 'cuts pushed out', 'no rate cuts', 'delaying cuts',
    'rate cuts unlikely', 'cuts not expected', 'fewer cuts'],
  fed_hike: ['rate hike', 'fed hikes', 'rate increase', 'hawkish', 'tightening', 'fed raises',
    'hawkish surprise', 'aggressive hike', 'jumbo hike', 'rate rises', 'volcker',
    'inflation fight', 'tightening cycle'],
  gdp_soft: ['soft landing', 'resilient', 'gdp beats', 'strong jobs', 'labor market strong',
    'growth holds', 'economy holds', 'consumer spending strong', 'gdp growth',
    'solid growth', 'economy expands', 'beats expectations', 'gdp', 'economy'],
  gdp_recession: ['recession', 'gdp contracts', 'economic slowdown', 'job losses', 'rising unemployment',
    'consumer weakness', 'manufacturing decline', 'pmi below', 'yield curve inversion',
    'economic contraction', 'gdp decline', 'growth stalls'],
  gdp_hard: ['deep recession', 'hard landing', 'severe contraction', 'depression', 'mass layoffs',
    'spiking unemployment', 'economic collapse', 'gdp plunge', 'demand collapse',
    'sharp contraction', 'worst since', 'unemployment surges'],
  tar_escalate: ['tariff escalation', 'new tariffs', 'tariff war', 'trade war', 'china tariffs',
    'retaliatory tariffs', 'trade decoupling', 'tariffs increase', 'broad tariffs',
    '60% tariff', '100% tariff', 'tariff hike', 'trade barriers', 'import tax',
    'trade sanctions', 'chip war', 'chip ban', 'rare earth', 'export controls', 'tariff', 'tariffs'],
  tar_truce: ['tariff truce', 'trade deal', 'tariff reduction', 'trade agreement', 'china deal',
    'tariff cuts', 'trade thaw', 'tariff pause', 'trade negotiation', 'lower tariffs',
    'trade breakthrough', 'tariff rollback'],
  geo_conflict: ['military conflict', 'invasion', 'declares war', 'at war', 'war breaks out',
    'world war', 'civil war', 'regional war', 'war escalates', 'missile', 'airstrike',
    'air strike', 'military strike', 'drone strike', 'attack', 'bombing', 'shelling',
    'nuclear threat', 'armed conflict', 'retaliation', 'military operation', 'troops deployed'],
  geo_tension: ['geopolitical tension', 'geopolitical risk', 'geopolitical crisis', 'sanctions',
    'proxy war', 'taiwan strait', 'south china sea', 'nato', 'middle east', 'iran',
    'russia ukraine', 'north korea', 'escalation', 'standoff', 'military buildup',
    'naval blockade', 'brinkmanship', 'territorial dispute', 'cold war'],
  geo_stable: ['peace', 'diplomacy', 'de-escalation', 'ceasefire', 'agreement', 'cooperation',
    'alliance', 'stability', 'treaty', 'negotiations succeed'],
  jgb_crisis: ['jgb crisis', 'yen carry unwind', 'boj loses control', 'jgb selloff', 'jgb sell-off',
    'japanese bond crisis', 'yen surge', 'carry trade unwind', 'japanese repatriation',
    'boj shock', 'jgb yield spike', 'japan bond selloff'],
  jgb_normal: ['boj normalization', 'boj hike', 'boj raises', 'jgb yield rises', 'boj tightening',
    'boj exit', 'yield curve control exit', 'boj policy shift', 'japan rate hike',
    'boj taper', 'boj', 'jgb', 'bank of japan'],
  fis_stimulus: ['fiscal stimulus', 'spending package', 'tax cuts', 'infrastructure spending',
    'stimulus bill', 'deficit spending', 'government spending', 'fiscal package',
    'economic stimulus', 'relief package', 'fiscal expansion', 'congress passes'],
  fis_austerity: ['austerity', 'spending cuts', 'deficit reduction', 'debt ceiling', 'fiscal cliff',
    'government shutdown', 'sequestration', 'budget cuts', 'fiscal restraint',
    'debt limit', 'spending freeze', 'fiscal consolidation'],
  usd_weak: ['dollar weakens', 'dollar falls', 'dxy drops', 'dollar decline', 'weak dollar',
    'dollar slides', 'dollar dips', 'dollar depreciation', 'dxy falls', 'dollar', 'dxy', 'greenback'],
  usd_strong: ['dollar strengthens', 'dollar surges', 'dxy rises', 'strong dollar', 'dollar rally',
    'dollar gains', 'dxy surges', 'dollar spikes', 'safe haven dollar'],
  rob_surge: ['robotics boom', 'robot investment', 'drone investment', 'automation surge',
    'warehouse robots', 'autonomous systems', 'defense drones', 'drone warfare',
    'manufacturing robots', 'autonomous vehicles', 'robot deployment', 'drone delivery',
    'humanoid robot', 'robot fleet', 'automation capex', 'industrial automation',
    'boston dynamics', 'figure ai', 'physical ai', 'robotics', 'automation', 'robot', 'drone'],
  rob_moderate: ['robotics adoption', 'automation growth', 'robot sales', 'drone adoption',
    'logistics automation', 'warehouse automation', 'robotic systems', 'drone market',
    'unmanned systems', 'automation expansion', 'cobots', 'collaborative robots'],
  rob_low: ['labor shortage', 'worker shortage', 'hiring surge', 'manual labor',
    'human workers', 'labor intensive', 'workforce expansion'],
  // ---- factor signals (no dedicated dial; feed the dials they move) ----
  credit_stress: ['credit spread', 'spreads widen', 'spread widening', 'junk bond',
    'high-yield', 'defaults rise', 'default wave', 'downgrade', 'credit crunch',
    'credit stress', 'distressed debt', 'bankruptcy', 'chapter 11', 'missed payment',
    'debt restructuring', 'credit event', 'lending standards', 'loan losses',
    'delinquencies', 'private credit'],
  ai_capex_up: ['ai capex', 'capex surge', 'record capex', 'data center buildout',
    'datacenter buildout', 'data center expansion', 'hyperscaler spending', 'gpu demand',
    'chip demand', 'ai infrastructure', 'ai spending', 'compute demand',
    'new data center', 'capacity expansion', 'data center', 'data-center'],
  ai_capex_down: ['capex cut', 'data center pause', 'datacenter pause', 'ai pullback',
    'gpu glut', 'capacity glut', 'order cancellation', 'orders cancelled', 'ai winter',
    'compute oversupply', 'lease cancellation', 'ai spending slowdown', 'capex guidance cut'],
  labor_strong: ['payrolls beat', 'jobs beat', 'strong jobs report', 'jobless claims fall',
    'unemployment falls', 'labor market strong', 'wage gains', 'job growth', 'hiring picks up',
    'payrolls', 'jobs report', 'hiring'],
  labor_weak: ['jobless claims rise', 'layoffs', 'job cuts', 'unemployment rises',
    'hiring freeze', 'payrolls miss', 'jobs miss', 'labor market cools', 'job openings fall',
    'workforce reduction'],
  energy_shock: ['oil spikes', 'oil surges', 'oil jumps', 'crude surges', 'strait of hormuz',
    'hormuz', 'oil embargo', 'supply disruption', 'energy crisis', 'gas prices spike',
    'opec cut', 'energy prices surge', 'power shortage', 'electricity prices spike',
    'oil', 'crude', 'opec', 'natural gas'],
};

const POS_WORDS = ['rally', 'surge', 'gain', 'rise', 'beat', 'strong', 'growth', 'recovery', 'bull', 'boom',
  'up', 'higher', 'soar', 'jump', 'climb', 'advance', 'improve', 'optimism', 'upgrade',
  'outperform', 'breakout', 'record', 'positive', 'confidence', 'expand'];
const NEG_WORDS = ['crash', 'plunge', 'fall', 'drop', 'miss', 'weak', 'decline', 'bear', 'bust', 'recession',
  'down', 'lower', 'slump', 'tumble', 'loss', 'fear', 'worry', 'concern', 'risk', 'cut',
  'downgrade', 'sell', 'negative', 'panic', 'collapse', 'crisis', 'warning', 'danger'];

// Categories amplified by bullish / bearish articles (legacy keyword fallback only).
const BULLISH_CATS = new Set(['sev_melt', 'inf_down', 'fed_cut', 'gdp_soft',
  'tar_truce', 'geo_stable', 'jgb_normal', 'fis_stimulus', 'usd_weak', 'ai_capex_up', 'labor_strong']);
const BEARISH_CATS = new Set(['sev_base', 'sev_severe', 'sev_mild', 'inf_high', 'inf_sticky',
  'fed_hike', 'gdp_recession', 'gdp_hard', 'tar_escalate', 'geo_conflict', 'geo_tension',
  'jgb_crisis', 'fis_austerity', 'usd_strong', 'credit_stress', 'ai_capex_down', 'labor_weak', 'energy_shock']);

function kwWeight(compound: number, cat: string): number {
  if (BULLISH_CATS.has(cat)) return Math.max(0.2, 0.6 + 0.4 * compound);
  if (BEARISH_CATS.has(cat)) return Math.max(0.2, 0.6 - 0.4 * compound);
  return 0.6;
}

const rparser = new Parser();

async function fetchFeed(name: string, url: string, timeout = 12000): Promise<Article[]> {
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MarketSim/1.0)' },
      signal: AbortSignal.timeout(timeout),
    });
    const raw = await resp.text();
    const feed = await rparser.parseString(raw);
    const entries: Article[] = [];
    for (const e of (feed.items || []).slice(0, 25)) {
      const title = e.title || '';
      const summary = (e as any).summary || e.content || e.contentSnippet || '';
      entries.push({
        title,
        summary: summary ? String(summary).slice(0, 500) : '',
        source: name,
        published: (e as any).pubDate || (e as any).isoDate || '',
      });
    }
    return entries;
  } catch (ex) {
    console.error(`  [warn] ${name}: ${(ex as Error).message}`);
    return [];
  }
}

// ---------- FinBERT sentiment ----------
let _finbertPipe: any = null;
let _finbertFailed = false;

async function getFinbert(): Promise<any> {
  if (_finbertPipe === null && !_finbertFailed) {
    console.error('  Loading FinBERT model...');
    const { pipeline, env } = await import('@xenova/transformers');
    env.allowLocalModels = false;
    _finbertPipe = await pipeline('text-classification', 'Xenova/finbert');
  }
  return _finbertPipe;
}

async function finbertBatch(texts: string[]): Promise<number[]> {
  if (texts.length === 0) return [];
  try {
    const pipe = await getFinbert();
    if (!pipe) return texts.map(() => 0.0);
    const scores: number[] = [];
    const BATCH = 32;
    for (let i = 0; i < texts.length; i += BATCH) {
      const chunk = texts.slice(i, i + BATCH).map((t) => t.slice(0, 512));
      const results: any = await pipe(chunk, { top_k: null });
      const perInput: any[] = Array.isArray(results[0]) ? results : results.map((r: any) => [r]);
      for (const r of perInput) {
        const m: Record<string, number> = {};
        for (const item of r) m[String(item.label).toLowerCase()] = item.score;
        scores.push(roundN((m['positive'] || 0) - (m['negative'] || 0), 4));
      }
    }
    return scores;
  } catch (ex) {
    _finbertFailed = true;
    console.error(`  [warn] FinBERT failed: ${(ex as Error).message}`);
    return texts.map(() => 0.0);
  }
}

function roundN(x: number, nd: number): number {
  const m = Math.pow(10, nd);
  return Math.round((x + Number.EPSILON) * m) / m;
}

// ---------- Zero-shot NLI direction classifier ----------
// Each dimension: the keyword keys that gate it (topic relevance), plus the
// natural-language hypotheses for each state and a "__none__" escape hatch.
const NONE = '__none__';
type DimSpec = { dim: string; states: string[]; hyp: Record<string, string> };
const DIMENSIONS: DimSpec[] = [
  { dim: 'sev', states: ['sev_melt', 'sev_mild', 'sev_base', 'sev_severe'], hyp: {
    sev_melt: 'the stock market is surging to euphoric record highs',
    sev_mild: 'the stock market is having a modest pullback or correction',
    sev_base: 'the stock market is in a major selloff, crash or bear market',
    sev_severe: 'there is a systemic financial crisis or market crash',
    [NONE]: 'this is not about the overall stock market direction' } },
  { dim: 'inf', states: ['inf_down', 'inf_sticky', 'inf_high'], hyp: {
    inf_down: 'inflation is falling or cooling',
    inf_sticky: 'inflation is staying stubbornly elevated',
    inf_high: 'inflation is high or surging',
    [NONE]: 'this is not about inflation' } },
  { dim: 'fed', states: ['fed_cut', 'fed_hold', 'fed_hike'], hyp: {
    fed_cut: 'the Federal Reserve is cutting interest rates or easing',
    fed_hold: 'the Federal Reserve is keeping rates on hold or delaying cuts',
    fed_hike: 'the Federal Reserve is raising interest rates or tightening',
    [NONE]: 'this is not about Federal Reserve interest-rate policy' } },
  { dim: 'gdp', states: ['gdp_soft', 'gdp_recession', 'gdp_hard'], hyp: {
    gdp_soft: 'the economy is resilient or growing',
    gdp_recession: 'the economy is sliding into a recession',
    gdp_hard: 'the economy is in a severe downturn or hard landing',
    [NONE]: 'this is not about the economic growth outlook' } },
  { dim: 'tar', states: ['tar_truce', 'tar_escalate'], hyp: {
    tar_truce: 'trade tensions are easing or a trade deal is reached',
    tar_escalate: 'trade tensions are rising with new tariffs or a trade war',
    [NONE]: 'this is not about trade or tariffs' } },
  { dim: 'geo', states: ['geo_stable', 'geo_tension', 'geo_conflict'], hyp: {
    geo_stable: 'geopolitical conditions are calm or improving',
    geo_tension: 'geopolitical tensions or sanctions are escalating',
    geo_conflict: 'there is an active military conflict or war',
    [NONE]: 'this is not about geopolitics' } },
  { dim: 'jgb', states: ['jgb_crisis', 'jgb_normal'], hyp: {
    jgb_crisis: "Japan's bond market is in crisis or the yen carry trade is unwinding",
    jgb_normal: 'the Bank of Japan is tightening or normalizing policy',
    [NONE]: 'this is not about Japanese monetary policy or bonds' } },
  { dim: 'fis', states: ['fis_stimulus', 'fis_austerity'], hyp: {
    fis_stimulus: 'the government is boosting spending or fiscal stimulus',
    fis_austerity: 'the government is cutting spending or tightening fiscal policy',
    [NONE]: 'this is not about government fiscal policy' } },
  { dim: 'usd', states: ['usd_weak', 'usd_strong'], hyp: {
    usd_weak: 'the US dollar is weakening',
    usd_strong: 'the US dollar is strengthening',
    [NONE]: 'this is not about the US dollar' } },
  { dim: 'rob', states: ['rob_surge', 'rob_moderate'], hyp: {
    rob_surge: 'there is a boom in robotics, drones or automation investment',
    rob_moderate: 'robotics or automation adoption is growing steadily',
    [NONE]: 'this is not about robotics or automation' } },
  // factor signals (binary present / not)
  { dim: 'credit', states: ['credit_stress'], hyp: {
    credit_stress: 'credit spreads are widening or defaults and bankruptcies are rising',
    [NONE]: 'this is not about credit stress or defaults' } },
  { dim: 'aicapex', states: ['ai_capex_up', 'ai_capex_down'], hyp: {
    ai_capex_up: 'AI or data-center capital spending is increasing',
    ai_capex_down: 'AI or data-center spending is being cut or there is a chip glut',
    [NONE]: 'this is not about AI or data-center capital spending' } },
  { dim: 'labor', states: ['labor_strong', 'labor_weak'], hyp: {
    labor_strong: 'the jobs market is strengthening',
    labor_weak: 'the jobs market is weakening with layoffs or rising unemployment',
    [NONE]: 'this is not about the jobs market' } },
  { dim: 'energy', states: ['energy_shock'], hyp: {
    energy_shock: 'oil or energy prices are spiking',
    [NONE]: 'this is not about energy or oil prices' } },
];
const HYPOTHESIS_TEMPLATE = 'This financial news implies that {}.';

let _zslPipe: any = null;
let _zslFailed = false;
async function getZeroShot(): Promise<any> {
  if (_zslPipe === null && !_zslFailed) {
    console.error('  Loading NLI zero-shot model...');
    try {
      const { pipeline, env } = await import('@xenova/transformers');
      env.allowLocalModels = false;
      _zslPipe = await pipeline('zero-shot-classification', 'Xenova/nli-deberta-v3-small');
    } catch (ex) {
      _zslFailed = true;
      console.error(`  [warn] NLI model unavailable, falling back to keywords: ${(ex as Error).message}`);
    }
  }
  return _zslPipe;
}

// For a single headline, return { stateKey: confidence } for each gated dimension
// whose NLI verdict is a real state (not the "none" escape) above threshold.
async function classifyHeadline(clf: any, text: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const d of DIMENSIONS) {
    const gated = d.states.some((s) => countKeywords(text, KW[s] || []) > 0);
    if (!gated) continue;
    const keys = Object.keys(d.hyp);
    const labels = keys.map((k) => d.hyp[k]);
    const res: any = await clf(text, labels, { multi_label: false, hypothesis_template: HYPOTHESIS_TEMPLATE });
    const winnerLabel = res.labels[0];
    const winnerKey = keys[labels.indexOf(winnerLabel)];
    if (winnerKey !== NONE && res.scores[0] >= NLI_THRESHOLD) out[winnerKey] = res.scores[0];
  }
  return out;
}

// Keywords must match as whole words/phrases (optional plural "s"). Plain substring
// matching produced large false-positive counts — 'war' matched "warns"/"software".
const _kwRegexCache = new Map<string, RegExp>();
function kwRegex(kw: string): RegExp {
  let re = _kwRegexCache.get(kw);
  if (!re) {
    const escaped = kw.trim().toLowerCase()
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\s+/g, '[\\s-]+');
    re = new RegExp(`(?<![a-z0-9])${escaped}(?:s)?(?![a-z0-9])`, 'i');
    _kwRegexCache.set(kw, re);
  }
  return re;
}

function countKeywords(text: string, keywords: string[]): number {
  let n = 0;
  for (const kw of keywords) if (kwRegex(kw).test(text)) n += 1;
  return n;
}

// The same story syndicated across feeds was scored once per feed, over-weighting
// whatever happened to be widely syndicated. Score each unique headline once.
function dedupeArticles(articles: Article[]): Article[] {
  const seen = new Set<string>();
  const out: Article[] = [];
  for (const a of articles) {
    const key = a.title.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    out.push(a);
  }
  return out;
}

// RSS feeds carry multi-day-old items; a 3-day-old headline shouldn't move the
// dials as much as one from this morning. Unknown dates get a middling weight.
function recencyWeight(published: string): number {
  if (!published) return 0.7;
  const t = Date.parse(published);
  if (Number.isNaN(t)) return 0.7;
  const ageH = (Date.now() - t) / 3_600_000;
  if (ageH <= 6) return 1.0;
  if (ageH <= 24) return 0.85;
  if (ageH <= 48) return 0.6;
  return 0.35;
}

type Analyzed = {
  title: string; source: string; finbert: number; cats: Record<string, number>;
  zsl: Record<string, number> | null; pos: number; neg: number; recency: number;
};

async function analyzeArticles(articles: Article[], useNli: boolean): Promise<{ analyzed: Analyzed[]; nliUsed: boolean }> {
  const texts = articles.map((a) => `${a.title} ${a.summary}`);
  console.error(`  Running FinBERT on ${texts.length} articles...`);
  const fbScores = await finbertBatch(texts);

  let clf: any = null;
  if (useNli) clf = await getZeroShot();
  const nliUsed = !!clf;
  if (nliUsed) console.error(`  Classifying ${articles.length} headlines with NLI (keyword-gated)...`);

  const results: Analyzed[] = [];
  for (let i = 0; i < articles.length; i++) {
    const a = articles[i];
    const text = texts[i];
    const cats: Record<string, number> = {};
    for (const cat of Object.keys(KW)) {
      const c = countKeywords(text, KW[cat]);
      if (c > 0) cats[cat] = c;
    }
    const zsl = nliUsed ? await classifyHeadline(clf, a.title) : null;
    const pos = POS_WORDS.reduce((acc, w) => acc + (kwRegex(w).test(text) ? 1 : 0), 0);
    const neg = NEG_WORDS.reduce((acc, w) => acc + (kwRegex(w).test(text) ? 1 : 0), 0);
    results.push({ title: a.title, source: a.source, finbert: fbScores[i], cats, zsl, pos, neg, recency: recencyWeight(a.published) });
  }
  return { analyzed: results, nliUsed };
}

// Accumulate per-state scores from the NLI verdicts (primary) or, as a fallback,
// from keyword counts weighted by article sentiment. Also collects the single
// strongest headline behind each state as human-readable evidence.
function accumulateScores(analyzed: Analyzed[], nliUsed: boolean): { scores: Record<string, number>; evidence: Record<string, { title: string; score: number }> } {
  const scores: Record<string, number> = {};
  for (const cat of Object.keys(KW)) scores[cat] = 0.0;
  const evidence: Record<string, { title: string; score: number }> = {};

  for (const a of analyzed) {
    if (nliUsed && a.zsl) {
      for (const [cat, conf] of Object.entries(a.zsl)) {
        scores[cat] = (scores[cat] || 0) + conf * a.recency;
        if (!evidence[cat] || conf > evidence[cat].score) evidence[cat] = { title: a.title, score: roundN(conf, 2) };
      }
    } else {
      const fb = a.finbert ?? 0.0;
      for (const [cat, cnt] of Object.entries(a.cats)) {
        scores[cat] = (scores[cat] || 0) + cnt * kwWeight(fb, cat) * a.recency;
      }
    }
  }
  return { scores, evidence };
}

function inferDials(scores: Record<string, number>): Record<string, any> {
  // ---- factor signals → dial scores ----
  const F: Record<string, number> = {
    credit_stress: scores['credit_stress'], ai_capex_up: scores['ai_capex_up'],
    ai_capex_down: scores['ai_capex_down'], labor_strong: scores['labor_strong'],
    labor_weak: scores['labor_weak'], energy_shock: scores['energy_shock'],
  };
  scores['sev_severe'] += 0.5 * F.credit_stress;
  scores['sev_base'] += 0.3 * F.credit_stress + 0.3 * F.ai_capex_down;
  scores['sev_mild'] += 0.4 * F.ai_capex_down;
  scores['sev_melt'] += 0.6 * F.ai_capex_up;
  scores['gdp_soft'] += 0.5 * F.labor_strong;
  scores['gdp_recession'] += 0.4 * F.labor_weak;
  scores['inf_high'] += 0.5 * F.energy_shock;

  const sevScores: Record<string, number> = {
    melt: scores['sev_melt'], mild: scores['sev_mild'], base: scores['sev_base'], severe: scores['sev_severe'],
  };
  const sevTotal = Math.max(sevScores.melt + sevScores.mild + sevScores.base + sevScores.severe, 1);
  const sevRatios: Record<string, number> = {};
  for (const k of Object.keys(sevScores)) sevRatios[k] = sevScores[k] / sevTotal;

  let sev: string;
  if ((sevRatios['severe'] || 0) > 0.35 || sevScores.severe >= 3) sev = 'severe';
  else if (((sevRatios['melt'] || 0) > 0.40 || sevScores.melt >= 4) && sevScores.melt >= sevScores.base) sev = 'melt';
  else if ((sevRatios['base'] || 0) > 0.35 || sevScores.base >= 2.5) sev = 'base';
  else if (sevScores.mild >= 1.2) sev = 'mild';
  else sev = maxOf(sevScores) > 0 ? argmax(sevScores) : 'base';

  const inf_d = scores['inf_down'], inf_s = scores['inf_sticky'], inf_h = scores['inf_high'];
  const inf_total = Math.max(inf_d + inf_s + inf_h, 1);
  let inf: string;
  if (inf_h / inf_total > 0.40 || inf_h >= 2.5) inf = 'high';
  else if (inf_d / inf_total > 0.40 || inf_d >= 2.5) inf = 'down';
  else inf = 'sticky';

  const fed_c = scores['fed_cut'], fed_h = scores['fed_hold'], fed_k = scores['fed_hike'];
  let fed: string;
  if (fed_k > fed_c && fed_k >= 1.2) fed = 'hike';
  else if (fed_c > fed_k && fed_c >= 1.2) fed = 'cut';
  else fed = 'hold';

  const gdp_s = scores['gdp_soft'], gdp_r = scores['gdp_recession'], gdp_h = scores['gdp_hard'];
  const gdp_total = Math.max(gdp_s + gdp_r + gdp_h, 1);
  let gdp: string;
  if (gdp_h / gdp_total > 0.35 || gdp_h >= 2) gdp = 'hard';
  else if (gdp_s / gdp_total > 0.40 || gdp_s >= 2.5) gdp = 'soft';
  else if (gdp_r >= 1.2) gdp = 'recession';
  else gdp = gdp_s > gdp_r ? 'soft' : 'recession';

  const tar_e = scores['tar_escalate'], tar_t = scores['tar_truce'];
  let tar: string;
  if (tar_e > tar_t && tar_e >= 2) tar = 'escalate';
  else if (tar_t > tar_e && tar_t >= 1.2) tar = 'truce';
  else tar = 'deescalate';

  const geo_c = scores['geo_conflict'], geo_t = scores['geo_tension'] + 0.3 * F.energy_shock, geo_s = scores['geo_stable'];
  let geo: string;
  if (geo_c >= 3 && geo_c > geo_s) geo = 'conflict';
  else if (geo_t + geo_c >= 1.5 && geo_t + geo_c > geo_s) geo = 'tension';
  else geo = 'stable';

  const jgb_c = scores['jgb_crisis'], jgb_n = scores['jgb_normal'];
  let jgb: string;
  if (jgb_c >= 1.2) jgb = 'crisis';
  else if (jgb_n >= 1.2) jgb = 'normalization';
  else jgb = 'anchored';

  const fis_s = scores['fis_stimulus'], fis_a = scores['fis_austerity'];
  let fis: string;
  if (fis_s > fis_a && fis_s >= 1.2) fis = 'stimulus';
  else if (fis_a > fis_s && fis_a >= 1.2) fis = 'austerity';
  else fis = 'neutral';

  const usd_w = scores['usd_weak'], usd_s = scores['usd_strong'];
  let usd: string;
  if (usd_w > usd_s && usd_w >= 1.2) usd = 'weak';
  else if (usd_s > usd_w && usd_s >= 1.2) usd = 'strong';
  else usd = 'neutral';

  const rob_surge = scores['rob_surge'], rob_mod = scores['rob_moderate'];
  let rob: string;
  if (rob_surge >= 1.5) rob = 'surge';
  else if (rob_mod >= 1.2 || rob_surge >= 0.6) rob = 'moderate';
  else rob = 'low';

  const aiCapexNet = F.ai_capex_up - F.ai_capex_down;
  const laborNet = F.labor_strong - F.labor_weak;
  const factors = [
    { id: 'credit_stress', label: 'Credit stress', score: roundN(F.credit_stress, 2),
      direction: F.credit_stress >= 1.5 ? 'bearish' : 'neutral', affects: 'Severity',
      note: 'HY spreads, downgrades, defaults, bankruptcies — the bust-severity amplifier' },
    { id: 'ai_capex', label: 'AI capex cycle', score: roundN(aiCapexNet, 2),
      direction: aiCapexNet > 0.5 ? 'bullish' : aiCapexNet < -0.5 ? 'bearish' : 'neutral', affects: 'Severity',
      note: 'Hyperscaler / data-center spending momentum — melt-up vs bust driver' },
    { id: 'labor', label: 'Labor market', score: roundN(laborNet, 2),
      direction: laborNet > 0.5 ? 'bullish' : laborNet < -0.5 ? 'bearish' : 'neutral', affects: 'GDP',
      note: 'Payrolls, jobless claims, layoffs — decides soft vs hard landing' },
    { id: 'energy_shock', label: 'Energy shock', score: roundN(F.energy_shock, 2),
      direction: F.energy_shock >= 1.5 ? 'bearish' : 'neutral', affects: 'Inflation + Geopolitics',
      note: 'Oil/gas price spikes, supply disruptions — inflation impulse and tension symptom' },
  ];

  return {
    sev, inf, fed, gdp, tar, geo, jgb, fis, usd, rob,
    confidence: {
      sev: { ...sevScores },
      inf: { down: inf_d, sticky: inf_s, high: inf_h },
      fed: { cut: fed_c, hold: fed_h, hike: fed_k },
      gdp: { soft: gdp_s, recession: gdp_r, hard: gdp_h },
      tar: { truce: tar_t, deescalate: 0, escalate: tar_e },
      geo: { stable: geo_s, tension: roundN(geo_t, 2), conflict: geo_c },
      jgb: { anchored: 0, normalization: jgb_n, crisis: jgb_c },
      fis: { austerity: fis_a, neutral: 0, stimulus: fis_s },
      usd: { weak: usd_w, neutral: 0, strong: usd_s },
    },
    factors,
    selected: { sev: `sev_${sev}`, inf: `inf_${inf}`, fed: `fed_${fed}`, gdp: `gdp_${gdp}`,
      tar: tar === 'deescalate' ? null : `tar_${tar}`, geo: `geo_${geo}`,
      jgb: jgb === 'anchored' ? null : (jgb === 'normalization' ? 'jgb_normal' : 'jgb_crisis'),
      fis: fis === 'neutral' ? null : `fis_${fis}`, usd: usd === 'neutral' ? null : `usd_${usd}`,
      rob: rob === 'low' ? null : `rob_${rob}` },
  };
}

function maxOf(obj: Record<string, number>): number { return Math.max(...Object.values(obj)); }
function argmax(obj: Record<string, number>): string { return Object.keys(obj).reduce((a, b) => (obj[b] > obj[a] ? b : a)); }

// Pull human-readable numeric facts out of the freshest headlines.
function extractKeyMetrics(articles: Article[]): string[] {
  const pat = /(?:\$[\d,]+(?:\.\d+)?(?:\s?(?:billion|trillion|million|bn|tn))?|\d+(?:\.\d+)?\s?(?:%|percent|basis points|bps|bp)|\d{2,4}\s?(?:points|pts))/i;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const a of articles) {
    const m = a.title.match(pat);
    if (m) {
      const key = a.title.toLowerCase();
      if (!seen.has(key)) { seen.add(key); out.push(a.title); }
    }
    if (out.length >= 8) break;
  }
  return out;
}

function topHeadlines(articles: Article[], n = 15): Array<{ title: string; source: string }> {
  const seen = new Set<string>();
  const unique: Article[] = [];
  for (const a of articles) {
    const t = a.title.trim();
    if (t && !seen.has(t)) { seen.add(t); unique.push(a); }
  }
  return unique.slice(0, n).map((a) => ({ title: a.title, source: a.source }));
}

async function main(): Promise<Record<string, any>> {
  const useNli = !process.argv.includes('--no-nli');
  console.error('Fetching financial news from RSS feeds (in parallel)...');
  const feedResults = await Promise.all(
    RSS_FEEDS.map(async ([name, url]) => ({ name, entries: await fetchFeed(name, url) })));
  const allArticles: Article[] = [];
  const sourcesOk: string[] = [];
  const sourcesFail: string[] = [];
  for (const { name, entries } of feedResults) {
    if (entries.length > 0) {
      console.error(`  [ok]   ${name}: ${entries.length} articles`);
      allArticles.push(...entries);
      sourcesOk.push(name);
    } else {
      console.error(`  [fail] ${name}`);
      sourcesFail.push(name);
    }
  }

  const uniqueArticles = dedupeArticles(allArticles);
  // Analyze the most-recent slice (NLI is the cost driver); headlines/counts use all unique.
  const byRecency = [...uniqueArticles].sort((a, b) => (Date.parse(b.published) || 0) - (Date.parse(a.published) || 0));
  const analyzeSet = byRecency.slice(0, MAX_ANALYZE);
  console.error(`\nTotal: ${allArticles.length} articles from ${sourcesOk.length} sources (${uniqueArticles.length} unique, analyzing ${analyzeSet.length})`);
  if (uniqueArticles.length === 0) {
    console.error('ERROR: No articles fetched.');
    process.exit(1);
  }

  console.error('Analyzing sentiment and meaning...');
  const { analyzed, nliUsed } = await analyzeArticles(analyzeSet, useNli);

  console.error('Mapping to simulation dials...');
  const { scores, evidence } = accumulateScores(analyzed, nliUsed);
  const result = inferDials(scores);

  // Attach the strongest headline behind each chosen dial state.
  const dialEvidence: Record<string, { title: string; score: number }> = {};
  for (const [dim, key] of Object.entries(result.selected as Record<string, string | null>)) {
    if (key && evidence[key]) dialEvidence[dim] = evidence[key];
  }

  const avgFinbert = analyzed.reduce((acc, a) => acc + a.finbert, 0) / Math.max(analyzed.length, 1);
  const output = {
    timestamp: new Date().toISOString(),
    method: nliUsed ? 'nli-zero-shot+finbert' : 'keyword+finbert',
    dials: {
      sev: result.sev, inf: result.inf, fed: result.fed, gdp: result.gdp,
      tar: result.tar, geo: result.geo, jgb: result.jgb, fis: result.fis,
      usd: result.usd, rob: result.rob,
    },
    confidence: result.confidence,
    factors: result.factors,
    evidence: dialEvidence,
    sentiment: {
      avg_finbert: roundN(avgFinbert, 3),
      positive_keywords: analyzed.reduce((acc, a) => acc + a.pos, 0),
      negative_keywords: analyzed.reduce((acc, a) => acc + a.neg, 0),
      overall: avgFinbert < -0.15 ? 'bearish' : (avgFinbert > 0.15 ? 'bullish' : 'mixed'),
    },
    key_metrics: extractKeyMetrics(byRecency),
    headlines: topHeadlines(uniqueArticles, 20),
    sources: { ok: sourcesOk, failed: sourcesFail, total_articles: uniqueArticles.length },
  };

  const outPath = join(HERE, '..', 'current_situation.json');
  writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.error(`\nWritten: ${outPath}`);

  if (process.argv.includes('--stdout') || process.argv.length < 3) {
    console.log(JSON.stringify(output, null, 2));
  }
  return output;
}

export { main as fetchNewsMain };

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
