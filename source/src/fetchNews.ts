#!/usr/bin/env tsx
/**
 * Fetch financial news from RSS feeds, analyze sentiment, and map to simulation dials.
 *
 * Uses FinBERT (financial BERT, via @xenova/transformers running the ONNX
 * `Xenova/finbert` model) for sentiment scoring and keyword analysis to
 * determine current market conditions, then outputs recommended dial settings.
 *
 * Faithful TypeScript port of fetch_news.py.
 *
 * Usage:
 *   tsx fetchNews.ts            # write current_situation.json (and print JSON)
 *   tsx fetchNews.ts --stdout   # print JSON to stdout (logs go to stderr)
 */
// Mirror the Python pipeline, which used an SSL context with verification
// disabled (CERT_NONE) so flaky feed certificates never block a fetch.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import { writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import Parser from 'rss-parser';

const HERE = dirname(fileURLToPath(import.meta.url));

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
    'plunge', 'sharp decline', 'widespread losses', 'panic selling'],
  sev_severe: ['financial crisis', 'systemic', 'credit crunch', 'liquidity crisis', 'bank failure',
    'cascade', 'forced selling', 'margin call', 'circuit breaker', 'flash crash',
    'black swan', 'catastrophic', 'depression', 'collapse', ' Lehman', 'contagion spreads',
    'frozen markets', 'credit freeze', 'bank run', 'insolvency', 'bailout'],
  inf_down: ['disinflation', 'inflation falls', 'inflation cools', 'cpi drops', 'cpi falls',
    'prices decline', 'deflation', 'falling prices', 'inflation eases', 'cooling inflation',
    'lower inflation', 'price drops', 'inflation slowing', 'cpi lower', 'ppi drops'],
  inf_sticky: ['sticky inflation', 'inflation persists', 'inflation stubborn', 'cpi holds',
    'above target', 'inflation stuck', 'persistent inflation', 'services inflation',
    'wage growth', 'shelter inflation', 'core cpi', 'supercore', 'inflation plateau'],
  inf_high: ['inflation spikes', 'inflation surges', 'cpi jumps', 'cpi surges', 'price surge',
    'stagflation', 'energy shock', 'oil shock', 'supply shock', 'soaring prices',
    'inflation accelerating', 'hot inflation', 'inflation above', 'wage-price',
    'price pressures', 'inflation fears', 'runaway inflation'],
  fed_cut: ['rate cut', 'fed cuts', 'easing', 'dovish', 'fed pivot', 'rate reduction',
    'fed lowers', 'monetary easing', 'cut rates', 'dovish pivot', 'emergency cut',
    'fed ease', 'powell dovish', 'rate cuts expected', 'cutting cycle'],
  fed_hold: ['fed holds', 'rates unchanged', 'on hold', 'wait and see', 'patient', 'data dependent',
    'fed pause', 'no change', 'steady rates', 'fed steady', 'hawkish hold'],
  fed_hike: ['rate hike', 'fed hikes', 'rate increase', 'hawkish', 'tightening', 'fed raises',
    'hawkish surprise', 'aggressive hike', 'jumbo hike', 'rate rises', 'volcker',
    'inflation fight', 'tightening cycle'],
  gdp_soft: ['soft landing', 'resilient', 'gdp beats', 'strong jobs', 'labor market strong',
    'growth holds', 'economy holds', 'consumer spending strong', 'gdp growth',
    'solid growth', 'economy expands', 'beats expectations'],
  gdp_recession: ['recession', 'gdp contracts', 'economic slowdown', 'job losses', 'rising unemployment',
    'consumer weakness', 'manufacturing decline', 'pmi below', 'yield curve inversion',
    'economic contraction', 'gdp decline', 'growth stalls'],
  gdp_hard: ['deep recession', 'hard landing', 'severe contraction', 'depression', 'mass layoffs',
    'spiking unemployment', 'economic collapse', 'gdp plunge', 'demand collapse',
    'sharp contraction', 'worst since', 'unemployment surges'],
  tar_escalate: ['tariff escalation', 'new tariffs', 'tariff war', 'trade war', 'china tariffs',
    'retaliatory tariffs', 'trade decoupling', 'tariffs increase', 'broad tariffs',
    '60% tariff', '100% tariff', 'tariff hike', 'trade barriers', 'import tax',
    'trade sanctions', 'chip war', 'chip ban', 'rare earth', 'export controls'],
  tar_truce: ['tariff truce', 'trade deal', 'tariff reduction', 'trade agreement', 'china deal',
    'tariff cuts', 'trade thaw', 'tariff pause', 'trade negotiation', 'lower tariffs',
    'trade breakthrough', 'tariff rollback'],
  geo_conflict: ['war', 'military conflict', 'invasion', 'geopolitical crisis', 'middle east',
    'taiwan strait', 'south china sea', 'nato', 'sanctions', 'proxy war', 'escalation',
    'missile', 'attack', 'bombing', 'nuclear threat', 'iran', 'russia ukraine',
    'armed conflict', 'military strike'],
  geo_stable: ['peace', 'diplomacy', 'de-escalation', 'ceasefire', 'agreement', 'cooperation',
    'alliance', 'stability', 'treaty', 'negotiations succeed'],
  jgb_crisis: ['jgb crisis', 'yen carry unwind', 'boj loses control', 'jgb selloff', 'jgb sell-off',
    'japanese bond crisis', 'yen surge', 'carry trade unwind', 'japanese repatriation',
    'boj shock', 'jgb yield spike', 'japan bond selloff'],
  jgb_normal: ['boj normalization', 'boj hike', 'boj raises', 'jgb yield rises', 'boj tightening',
    'boj exit', 'yield curve control exit', 'boj policy shift', 'japan rate hike',
    'boj taper'],
  fis_stimulus: ['fiscal stimulus', 'spending package', 'tax cuts', 'infrastructure spending',
    'stimulus bill', 'deficit spending', 'government spending', 'fiscal package',
    'economic stimulus', 'relief package', 'fiscal expansion', 'congress passes'],
  fis_austerity: ['austerity', 'spending cuts', 'deficit reduction', 'debt ceiling', 'fiscal cliff',
    'government shutdown', 'sequestration', 'budget cuts', 'fiscal restraint',
    'debt limit', 'spending freeze', 'fiscal consolidation'],
  usd_weak: ['dollar weakens', 'dollar falls', 'dxy drops', 'dollar decline', 'weak dollar',
    'dollar slides', 'dollar dips', 'dollar depreciation', 'dxy falls'],
  usd_strong: ['dollar strengthens', 'dollar surges', 'dxy rises', 'strong dollar', 'dollar rally',
    'dollar gains', 'dxy surges', 'dollar spikes', 'safe haven dollar'],
  rob_surge: ['robotics boom', 'robot investment', 'drone investment', 'automation surge',
    'warehouse robots', 'autonomous systems', 'defense drones', 'drone warfare',
    'manufacturing robots', 'autonomous vehicles', 'robot deployment', 'drone delivery',
    'humanoid robot', 'robot fleet', 'automation capex', 'industrial automation',
    'boston dynamics', 'figure ai', 'physical ai', 'drone strike', 'drone attack'],
  rob_moderate: ['robotics adoption', 'automation growth', 'robot sales', 'drone adoption',
    'logistics automation', 'warehouse automation', 'robotic systems', 'drone market',
    'unmanned systems', 'automation expansion', 'cobots', 'collaborative robots'],
  rob_low: ['labor shortage', 'worker shortage', 'hiring surge', 'manual labor',
    'human workers', 'labor intensive', 'workforce expansion'],
};

const POS_WORDS = ['rally', 'surge', 'gain', 'rise', 'beat', 'strong', 'growth', 'recovery', 'bull', 'boom',
  'up', 'higher', 'soar', 'jump', 'climb', 'advance', 'improve', 'optimism', 'upgrade',
  'outperform', 'breakout', 'record', 'positive', 'confidence', 'expand'];
const NEG_WORDS = ['crash', 'plunge', 'fall', 'drop', 'miss', 'weak', 'decline', 'bear', 'bust', 'recession',
  'down', 'lower', 'slump', 'tumble', 'loss', 'fear', 'worry', 'concern', 'risk', 'cut',
  'downgrade', 'sell', 'negative', 'panic', 'collapse', 'crisis', 'warning', 'danger'];

// Categories whose keywords are amplified by bullish articles (positive news = more signal)
const BULLISH_CATS = new Set(['sev_melt', 'inf_down', 'fed_cut', 'gdp_soft',
  'tar_truce', 'geo_stable', 'jgb_normal', 'fis_stimulus', 'usd_weak']);
// Categories whose keywords are amplified by bearish articles (negative news = more signal)
const BEARISH_CATS = new Set(['sev_base', 'sev_severe', 'sev_mild', 'inf_high', 'inf_sticky',
  'fed_hike', 'gdp_recession', 'gdp_hard', 'tar_escalate',
  'geo_conflict', 'geo_tension', 'jgb_crisis', 'fis_austerity', 'usd_strong']);

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
      // top_k null -> return all label scores for each input
      const results: any = await pipe(chunk, { top_k: null });
      // normalize to array-of-array-of {label, score}
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

function countKeywords(text: string, keywords: string[]): number {
  const t = text.toLowerCase();
  let n = 0;
  for (const kw of keywords) if (t.includes(kw.toLowerCase())) n += 1;
  return n;
}

type Analyzed = { title: string; source: string; finbert: number; cats: Record<string, number>; pos: number; neg: number };

async function analyzeArticles(articles: Article[]): Promise<Analyzed[]> {
  const texts = articles.map((a) => `${a.title} ${a.summary}`);
  console.error(`  Running FinBERT on ${texts.length} articles...`);
  const fbScores = await finbertBatch(texts);
  const results: Analyzed[] = [];
  for (let i = 0; i < articles.length; i++) {
    const a = articles[i];
    const text = texts[i];
    const lower = text.toLowerCase();
    const cats: Record<string, number> = {};
    for (const cat of Object.keys(KW)) {
      const c = countKeywords(text, KW[cat]);
      if (c > 0) cats[cat] = c;
    }
    const pos = POS_WORDS.reduce((acc, w) => acc + (lower.includes(w) ? 1 : 0), 0);
    const neg = NEG_WORDS.reduce((acc, w) => acc + (lower.includes(w) ? 1 : 0), 0);
    results.push({ title: a.title, source: a.source, finbert: fbScores[i], cats, pos, neg });
  }
  return results;
}

function inferDials(analyzed: Analyzed[]): Record<string, any> {
  const scores: Record<string, number> = {};
  for (const cat of Object.keys(KW)) scores[cat] = 0.0;
  for (const a of analyzed) {
    const fb = a.finbert ?? 0.0;
    for (const [cat, cnt] of Object.entries(a.cats)) {
      scores[cat] += cnt * kwWeight(fb, cat);
    }
  }

  const sevScores: Record<string, number> = {
    melt: scores['sev_melt'], mild: scores['sev_mild'], base: scores['sev_base'], severe: scores['sev_severe'],
  };
  const sevTotal = Math.max(sevScores.melt + sevScores.mild + sevScores.base + sevScores.severe, 1);
  const sevRatios: Record<string, number> = {};
  for (const k of Object.keys(sevScores)) sevRatios[k] = sevScores[k] / sevTotal;

  let sev: string;
  if ((sevRatios['severe'] || 0) > 0.35 || sevScores.severe >= 5) sev = 'severe';
  else if ((sevRatios['melt'] || 0) > 0.40 || sevScores.melt >= 6) sev = 'melt';
  else if ((sevRatios['base'] || 0) > 0.35 || sevScores.base >= 4) sev = 'base';
  else if (sevScores.mild >= 2) sev = 'mild';
  else sev = maxOf(sevScores) > 0 ? argmax(sevScores) : 'base';

  const inf_d = scores['inf_down'], inf_s = scores['inf_sticky'], inf_h = scores['inf_high'];
  const inf_total = Math.max(inf_d + inf_s + inf_h, 1);
  let inf: string;
  if (inf_h / inf_total > 0.40 || inf_h >= 4) inf = 'high';
  else if (inf_d / inf_total > 0.40 || inf_d >= 4) inf = 'down';
  else inf = 'sticky';

  const fed_c = scores['fed_cut'], fed_h = scores['fed_hold'], fed_k = scores['fed_hike'];
  let fed: string;
  if (fed_k > fed_c && fed_k >= 2) fed = 'hike';
  else if (fed_c > fed_k && fed_c >= 2) fed = 'cut';
  else fed = 'hold';

  const gdp_s = scores['gdp_soft'], gdp_r = scores['gdp_recession'], gdp_h = scores['gdp_hard'];
  const gdp_total = Math.max(gdp_s + gdp_r + gdp_h, 1);
  let gdp: string;
  if (gdp_h / gdp_total > 0.35 || gdp_h >= 3) gdp = 'hard';
  else if (gdp_s / gdp_total > 0.40 || gdp_s >= 4) gdp = 'soft';
  else if (gdp_r >= 2) gdp = 'recession';
  else gdp = 'recession';

  const tar_e = scores['tar_escalate'], tar_t = scores['tar_truce'];
  let tar: string;
  if (tar_e > tar_t && tar_e >= 3) tar = 'escalate';
  else if (tar_t > tar_e && tar_t >= 2) tar = 'truce';
  else tar = 'deescalate';

  const geo_c = scores['geo_conflict'], geo_s = scores['geo_stable'];
  let geo: string;
  if (geo_c >= 5) geo = 'conflict';
  else if (geo_c >= 2 && geo_c > geo_s) geo = 'tension';
  else geo = 'stable';

  const jgb_c = scores['jgb_crisis'], jgb_n = scores['jgb_normal'];
  let jgb: string;
  if (jgb_c >= 2) jgb = 'crisis';
  else if (jgb_n >= 2) jgb = 'normalization';
  else jgb = 'anchored';

  const fis_s = scores['fis_stimulus'], fis_a = scores['fis_austerity'];
  let fis: string;
  if (fis_s > fis_a && fis_s >= 2) fis = 'stimulus';
  else if (fis_a > fis_s && fis_a >= 2) fis = 'austerity';
  else fis = 'neutral';

  const usd_w = scores['usd_weak'], usd_s = scores['usd_strong'];
  let usd: string;
  if (usd_w > usd_s && usd_w >= 2) usd = 'weak';
  else if (usd_s > usd_w && usd_s >= 2) usd = 'strong';
  else usd = 'neutral';

  const rob_surge = scores['rob_surge'], rob_mod = scores['rob_moderate'];
  let rob: string;
  if (rob_surge >= 2) rob = 'surge';
  else if (rob_mod >= 2 || rob_surge >= 1) rob = 'moderate';
  else rob = 'low';

  const avgFinbert = analyzed.reduce((acc, a) => acc + a.finbert, 0) / Math.max(analyzed.length, 1);
  const totalPos = analyzed.reduce((acc, a) => acc + a.pos, 0);
  const totalNeg = analyzed.reduce((acc, a) => acc + a.neg, 0);

  return {
    sev, inf, fed, gdp, tar, geo, jgb, fis, usd, rob,
    confidence: {
      sev: { ...sevScores },
      inf: { down: inf_d, sticky: inf_s, high: inf_h },
      fed: { cut: fed_c, hold: fed_h, hike: fed_k },
      gdp: { soft: gdp_s, recession: gdp_r, hard: gdp_h },
      tar: { truce: tar_t, deescalate: 0, escalate: tar_e },
      geo: { stable: geo_s, tension: geo_c, conflict: geo_c },
      jgb: { anchored: 0, normalization: jgb_n, crisis: jgb_c },
      fis: { austerity: fis_a, neutral: 0, stimulus: fis_s },
      usd: { weak: usd_w, neutral: 0, strong: usd_s },
    },
    sentiment: {
      avg_finbert: roundN(avgFinbert, 3),
      positive_keywords: totalPos,
      negative_keywords: totalNeg,
      overall: avgFinbert < -0.15 ? 'bearish' : (avgFinbert > 0.15 ? 'bullish' : 'mixed'),
    },
  };
}

function maxOf(obj: Record<string, number>): number {
  return Math.max(...Object.values(obj));
}
function argmax(obj: Record<string, number>): string {
  return Object.keys(obj).reduce((a, b) => (obj[b] > obj[a] ? b : a));
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
  console.error('Fetching financial news from RSS feeds...');
  const allArticles: Article[] = [];
  const sourcesOk: string[] = [];
  const sourcesFail: string[] = [];
  for (const [name, url] of RSS_FEEDS) {
    const entries = await fetchFeed(name, url);
    if (entries.length > 0) {
      console.error(`  [ok]   ${name}: ${entries.length} articles`);
      allArticles.push(...entries);
      sourcesOk.push(name);
    } else {
      console.error(`  [fail] ${name}`);
      sourcesFail.push(name);
    }
  }

  console.error(`\nTotal: ${allArticles.length} articles from ${sourcesOk.length} sources`);
  if (allArticles.length === 0) {
    console.error('ERROR: No articles fetched.');
    process.exit(1);
  }

  console.error('Analyzing sentiment and topics...');
  const analyzed = await analyzeArticles(allArticles);

  console.error('Mapping to simulation dials...');
  const result = inferDials(analyzed);

  const output = {
    timestamp: new Date().toISOString(),
    dials: {
      sev: result.sev, inf: result.inf, fed: result.fed, gdp: result.gdp,
      tar: result.tar, geo: result.geo, jgb: result.jgb, fis: result.fis,
      usd: result.usd, rob: result.rob,
    },
    confidence: result.confidence,
    sentiment: result.sentiment,
    headlines: topHeadlines(allArticles, 20),
    sources: { ok: sourcesOk, failed: sourcesFail, total_articles: allArticles.length },
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
