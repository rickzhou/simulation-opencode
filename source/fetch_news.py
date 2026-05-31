#!/usr/bin/env python3
"""Fetch financial news from RSS feeds, analyze sentiment, and map to simulation dials.

Uses FinBERT (financial BERT) for sentiment scoring and keyword analysis to determine
current market conditions, then outputs recommended dial settings for the simulation.

Usage:
    python3 fetch_news.py              # output current_situation.json
    python3 fetch_news.py --stdout     # print JSON to stdout only
"""
import json
import sys
import urllib.request
import ssl
from datetime import datetime, timezone
from pathlib import Path

try:
    import feedparser
    HAS_FEEDPARSER = True
except ImportError:
    HAS_FEEDPARSER = False

try:
    from transformers import pipeline as _hf_pipeline
    HAS_FINBERT = True
except ImportError:
    HAS_FINBERT = False

_finbert_pipe = None

def _get_finbert():
    global _finbert_pipe
    if _finbert_pipe is None:
        print('  Loading FinBERT model...', file=sys.stderr)
        _finbert_pipe = _hf_pipeline(
            'text-classification',
            model='ProsusAI/finbert',
            top_k=None,
            device=-1,
        )
    return _finbert_pipe

HERE = Path(__file__).resolve().parent

RSS_FEEDS = [
    ('CNBC Top News',      'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100003114'),
    ('CNBC Economy',       'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=20910258'),
    ('CNBC Finance',       'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=10000664'),
    ('CNBC World',         'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100727362'),
    ('Yahoo Finance',      'https://finance.yahoo.com/news/rssindex'),
    ('MarketWatch Top',    'https://feeds.content.dowjones.io/public/rss/mw_topstories'),
    ('FT Markets',         'https://www.ft.com/markets?format=rss'),
    ('FT Economy',         'https://www.ft.com/global-economy?format=rss'),
    ('Seeking Alpha',      'https://seekingalpha.com/market_currents.xml'),
    ('Investing.com',      'https://www.investing.com/rss/news.rss'),
    ('WSJ Markets',        'https://feeds.a.dj.com/rss/RSSMarketsMain.xml'),
    ('WSJ Economy',        'https://feeds.a.dj.com/rss/RSSWorldNews.xml'),
    ('Bloomberg Markets',  'https://feeds.bloomberg.com/markets/news.rss'),
    ('TheStreet',          'https://www.thestreet.com/.rss/full/'),
    ('Economist Finance',  'https://www.economist.com/finance-and-economics/rss.xml'),
    ('Motley Fool',        'https://www.fool.com/feeds/index.aspx?id=top-articles&format=rss'),
    ('ZeroHedge',          'https://feeds.feedburner.com/zerohedge/feed'),
    ('Real Clear Markets', 'https://www.realclearmarkets.com/index.xml'),
    ('ETF Trends',         'https://www.etftrends.com/feed/'),
    ('FX Street',          'https://www.fxstreet.com/rss/news'),
    ('Oil Price',          'https://oilprice.com/rss/main'),
    ('Nasdaq News',        'https://www.nasdaq.com/feed/nasdaq-original/rss.xml'),
    ('Benzinga',           'https://www.benzinga.com/feed'),
]

KW = {
    'sev_melt': [
        'melt-up','melt up','all-time high','record high','new high','rally extends',
        'bull run','euphoria','fomo','blow-off','blowoff','parabolic','surge past',
        'ai boom','ai rally','tech rally','nvidia beats','earnings beat','ai spending',
        'capex surge','hyperscaler','ai capex','ai revenue','ai demand','ai growth',
        'stocks soar','market soars','breakout','momentum','all time high',
    ],
    'sev_mild': [
        'correction','pullback','dip','growth scare','valuation concern','overvalued',
        'earnings disappoint','multiple compression','profit warning','revenue miss',
        'ai disappoint','ai monetization','cooling','slowdown','modest decline',
        'rotation','sector rotation','narrowing breadth','tech selloff','tech sells off',
    ],
    'sev_base': [
        'bubble burst','bubble pops','bust','crash','bear market','sell-off','selloff',
        'contagion','capitulation','debt crisis','ai debt','credit event','downgrade',
        'default wave','layoffs','recession fears','market tumble','steep decline',
        'plunge','sharp decline','widespread losses','panic selling',
    ],
    'sev_severe': [
        'financial crisis','systemic','credit crunch','liquidity crisis','bank failure',
        'cascade','forced selling','margin call','circuit breaker','flash crash',
        'black swan','catastrophic','depression','collapse',' Lehman','contagion spreads',
        'frozen markets','credit freeze','bank run','insolvency','bailout',
    ],
    'inf_down': [
        'disinflation','inflation falls','inflation cools','cpi drops','cpi falls',
        'prices decline','deflation','falling prices','inflation eases','cooling inflation',
        'lower inflation','price drops','inflation slowing','cpi lower','ppi drops',
    ],
    'inf_sticky': [
        'sticky inflation','inflation persists','inflation stubborn','cpi holds',
        'above target','inflation stuck','persistent inflation','services inflation',
        'wage growth','shelter inflation','core cpi','supercore','inflation plateau',
    ],
    'inf_high': [
        'inflation spikes','inflation surges','cpi jumps','cpi surges','price surge',
        'stagflation','energy shock','oil shock','supply shock','soaring prices',
        'inflation accelerating','hot inflation','inflation above','wage-price',
        'price pressures','inflation fears','runaway inflation',
    ],
    'fed_cut': [
        'rate cut','fed cuts','easing','dovish','fed pivot','rate reduction',
        'fed lowers','monetary easing','cut rates','dovish pivot','emergency cut',
        'fed ease','powell dovish','rate cuts expected','cutting cycle',
    ],
    'fed_hold': [
        'fed holds','rates unchanged','on hold','wait and see','patient','data dependent',
        'fed pause','no change','steady rates','fed steady','hawkish hold',
    ],
    'fed_hike': [
        'rate hike','fed hikes','rate increase','hawkish','tightening','fed raises',
        'hawkish surprise','aggressive hike','jumbo hike','rate rises','volcker',
        'inflation fight','tightening cycle',
    ],
    'gdp_soft': [
        'soft landing','resilient','gdp beats','strong jobs','labor market strong',
        'growth holds','economy holds','consumer spending strong','gdp growth',
        'solid growth','economy expands','beats expectations',
    ],
    'gdp_recession': [
        'recession','gdp contracts','economic slowdown','job losses','rising unemployment',
        'consumer weakness','manufacturing decline','pmi below','yield curve inversion',
        'economic contraction','gdp decline','growth stalls',
    ],
    'gdp_hard': [
        'deep recession','hard landing','severe contraction','depression','mass layoffs',
        'spiking unemployment','economic collapse','gdp plunge','demand collapse',
        'sharp contraction','worst since','unemployment surges',
    ],
    'tar_escalate': [
        'tariff escalation','new tariffs','tariff war','trade war','china tariffs',
        'retaliatory tariffs','trade decoupling','tariffs increase','broad tariffs',
        '60% tariff','100% tariff','tariff hike','trade barriers','import tax',
        'trade sanctions','chip war','chip ban','rare earth','export controls',
    ],
    'tar_truce': [
        'tariff truce','trade deal','tariff reduction','trade agreement','china deal',
        'tariff cuts','trade thaw','tariff pause','trade negotiation','lower tariffs',
        'trade breakthrough','tariff rollback',
    ],
    'geo_conflict': [
        'war','military conflict','invasion','geopolitical crisis','middle east',
        'taiwan strait','south china sea','nato','sanctions','proxy war','escalation',
        'missile','attack','bombing','nuclear threat','iran','russia ukraine',
        'armed conflict','military strike',
    ],
    'geo_stable': [
        'peace','diplomacy','de-escalation','ceasefire','agreement','cooperation',
        'alliance','stability','treaty','negotiations succeed',
    ],
    'jgb_crisis': [
        'jgb crisis','yen carry unwind','boj loses control','jgb selloff','jgb sell-off',
        'japanese bond crisis','yen surge','carry trade unwind','japanese repatriation',
        'boj shock','jgb yield spike','japan bond selloff',
    ],
    'jgb_normal': [
        'boj normalization','boj hike','boj raises','jgb yield rises','boj tightening',
        'boj exit','yield curve control exit','boj policy shift','japan rate hike',
        'boj taper',
    ],
    'fis_stimulus': [
        'fiscal stimulus','spending package','tax cuts','infrastructure spending',
        'stimulus bill','deficit spending','government spending','fiscal package',
        'economic stimulus','relief package','fiscal expansion','congress passes',
    ],
    'fis_austerity': [
        'austerity','spending cuts','deficit reduction','debt ceiling','fiscal cliff',
        'government shutdown','sequestration','budget cuts','fiscal restraint',
        'debt limit','spending freeze','fiscal consolidation',
    ],
    'usd_weak': [
        'dollar weakens','dollar falls','dxy drops','dollar decline','weak dollar',
        'dollar slides','dollar dips','dollar depreciation','dxy falls',
    ],
    'usd_strong': [
        'dollar strengthens','dollar surges','dxy rises','strong dollar','dollar rally',
        'dollar gains','dxy surges','dollar spikes','safe haven dollar',
    ],
    'rob_surge': [
        'robotics boom','robot investment','drone investment','automation surge',
        'warehouse robots','autonomous systems','defense drones','drone warfare',
        'manufacturing robots','autonomous vehicles','robot deployment','drone delivery',
        'humanoid robot','robot fleet','automation capex','industrial automation',
        'boston dynamics','figure ai','physical ai','drone strike','drone attack',
    ],
    'rob_moderate': [
        'robotics adoption','automation growth','robot sales','drone adoption',
        'logistics automation','warehouse automation','robotic systems','drone market',
        'unmanned systems','automation expansion','cobots','collaborative robots',
    ],
    'rob_low': [
        'labor shortage','worker shortage','hiring surge','manual labor',
        'human workers','labor intensive','workforce expansion',
    ],
}

POS_WORDS = [
    'rally','surge','gain','rise','beat','strong','growth','recovery','bull','boom',
    'up','higher','soar','jump','climb','advance','improve','optimism','upgrade',
    'outperform','breakout','record','positive','confidence','expand',
]
NEG_WORDS = [
    'crash','plunge','fall','drop','miss','weak','decline','bear','bust','recession',
    'down','lower','slump','tumble','loss','fear','worry','concern','risk','cut',
    'downgrade','sell','negative','panic','collapse','crisis','warning','danger',
]


def fetch_feed(name, url, timeout=12):
    if not HAS_FEEDPARSER:
        return []
    try:
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        req = urllib.request.Request(url, headers={
            'User-Agent': 'Mozilla/5.0 (compatible; MarketSim/1.0)'
        })
        resp = urllib.request.urlopen(req, timeout=timeout, context=ctx)
        raw = resp.read()
        feed = feedparser.parse(raw)
        entries = []
        for e in feed.entries[:25]:
            title = e.get('title', '')
            summary = e.get('summary', e.get('description', ''))
            entries.append({
                'title': title,
                'summary': summary[:500] if summary else '',
                'source': name,
                'published': e.get('published', ''),
            })
        return entries
    except Exception as ex:
        print(f'  [warn] {name}: {ex}', file=sys.stderr)
        return []


# Categories whose keywords are amplified by bullish articles (positive news = more signal)
_BULLISH_CATS = frozenset([
    'sev_melt', 'inf_down', 'fed_cut', 'gdp_soft',
    'tar_truce', 'geo_stable', 'jgb_normal', 'fis_stimulus', 'usd_weak',
])
# Categories whose keywords are amplified by bearish articles (negative news = more signal)
_BEARISH_CATS = frozenset([
    'sev_base', 'sev_severe', 'sev_mild', 'inf_high', 'inf_sticky',
    'fed_hike', 'gdp_recession', 'gdp_hard', 'tar_escalate',
    'geo_conflict', 'geo_tension', 'jgb_crisis', 'fis_austerity', 'usd_strong',
])

def _kw_weight(compound, cat):
    """Scale a keyword hit by how well the article's sentiment aligns with the category."""
    if cat in _BULLISH_CATS:
        return max(0.2, 0.6 + 0.4 * compound)
    if cat in _BEARISH_CATS:
        return max(0.2, 0.6 - 0.4 * compound)
    return 0.6


def finbert_batch(texts):
    """Return FinBERT compound scores (-1..+1) for a list of texts."""
    if not HAS_FINBERT:
        return [0.0] * len(texts)
    try:
        pipe = _get_finbert()
        results = pipe([t[:512] for t in texts], truncation=True, batch_size=32)
        scores = []
        for r in results:
            label_scores = {item['label']: item['score'] for item in r}
            scores.append(round(label_scores.get('positive', 0) - label_scores.get('negative', 0), 4))
        return scores
    except Exception as ex:
        print(f'  [warn] FinBERT failed: {ex}', file=sys.stderr)
        return [0.0] * len(texts)


def count_keywords(text, keywords):
    t = text.lower()
    return sum(1 for kw in keywords if kw.lower() in t)


def score_category(text, cat_key):
    return count_keywords(text, KW.get(cat_key, []))


def analyze_articles(articles):
    texts = [f"{a['title']} {a['summary']}" for a in articles]
    print(f'  Running FinBERT on {len(texts)} articles...', file=sys.stderr)
    fb_scores = finbert_batch(texts)
    results = []
    for a, text, fb in zip(articles, texts, fb_scores):
        cats = {}
        for cat in KW:
            c = score_category(text, cat)
            if c > 0:
                cats[cat] = c
        pos = sum(1 for w in POS_WORDS if w in text.lower())
        neg = sum(1 for w in NEG_WORDS if w in text.lower())
        results.append({
            'title': a['title'],
            'source': a['source'],
            'finbert': fb,
            'cats': cats,
            'pos': pos,
            'neg': neg,
        })
    return results


def infer_dials(analyzed):
    scores = {cat: 0.0 for cat in KW}
    for a in analyzed:
        fb = a.get('finbert', 0.0)
        for cat, cnt in a['cats'].items():
            scores[cat] += cnt * _kw_weight(fb, cat)

    total = max(sum(scores.values()), 1)

    sev_scores = {
        'melt':   scores['sev_melt'],
        'mild':   scores['sev_mild'],
        'base':   scores['sev_base'],
        'severe': scores['sev_severe'],
    }
    sev_total = max(sum(sev_scores.values()), 1)
    sev_ratios = {k: v / sev_total for k, v in sev_scores.items()}

    if sev_ratios.get('severe', 0) > 0.35 or sev_scores['severe'] >= 5:
        sev = 'severe'
    elif sev_ratios.get('melt', 0) > 0.40 or sev_scores['melt'] >= 6:
        sev = 'melt'
    elif sev_ratios.get('base', 0) > 0.35 or sev_scores['base'] >= 4:
        sev = 'base'
    elif sev_scores['mild'] >= 2:
        sev = 'mild'
    else:
        sev = max(sev_scores, key=sev_scores.get) if max(sev_scores.values()) > 0 else 'base'

    inf_d = scores['inf_down']
    inf_s = scores['inf_sticky']
    inf_h = scores['inf_high']
    inf_total = max(inf_d + inf_s + inf_h, 1)
    if inf_h / inf_total > 0.40 or inf_h >= 4:
        inf = 'high'
    elif inf_d / inf_total > 0.40 or inf_d >= 4:
        inf = 'down'
    else:
        inf = 'sticky'

    fed_c = scores['fed_cut']
    fed_h = scores['fed_hold']
    fed_k = scores['fed_hike']
    if fed_k > fed_c and fed_k >= 2:
        fed = 'hike'
    elif fed_c > fed_k and fed_c >= 2:
        fed = 'cut'
    else:
        fed = 'hold'

    gdp_s = scores['gdp_soft']
    gdp_r = scores['gdp_recession']
    gdp_h = scores['gdp_hard']
    gdp_total = max(gdp_s + gdp_r + gdp_h, 1)
    if gdp_h / gdp_total > 0.35 or gdp_h >= 3:
        gdp = 'hard'
    elif gdp_s / gdp_total > 0.40 or gdp_s >= 4:
        gdp = 'soft'
    elif gdp_r >= 2:
        gdp = 'recession'
    else:
        gdp = 'recession'

    tar_e = scores['tar_escalate']
    tar_t = scores['tar_truce']
    if tar_e > tar_t and tar_e >= 3:
        tar = 'escalate'
    elif tar_t > tar_e and tar_t >= 2:
        tar = 'truce'
    else:
        tar = 'deescalate'

    geo_c = scores['geo_conflict']
    geo_s = scores['geo_stable']
    if geo_c >= 5:
        geo = 'conflict'
    elif geo_c >= 2 and geo_c > geo_s:
        geo = 'tension'
    else:
        geo = 'stable'

    jgb_c = scores['jgb_crisis']
    jgb_n = scores['jgb_normal']
    if jgb_c >= 2:
        jgb = 'crisis'
    elif jgb_n >= 2:
        jgb = 'normalization'
    else:
        jgb = 'anchored'

    fis_s = scores['fis_stimulus']
    fis_a = scores['fis_austerity']
    if fis_s > fis_a and fis_s >= 2:
        fis = 'stimulus'
    elif fis_a > fis_s and fis_a >= 2:
        fis = 'austerity'
    else:
        fis = 'neutral'

    usd_w = scores['usd_weak']
    usd_s = scores['usd_strong']
    if usd_w > usd_s and usd_w >= 2:
        usd = 'weak'
    elif usd_s > usd_w and usd_s >= 2:
        usd = 'strong'
    else:
        usd = 'neutral'

    rob_surge = scores['rob_surge']
    rob_mod   = scores['rob_moderate']
    if rob_surge >= 2:
        rob = 'surge'
    elif rob_mod >= 2 or rob_surge >= 1:
        rob = 'moderate'
    else:
        rob = 'low'

    avg_finbert = sum(a['finbert'] for a in analyzed) / max(len(analyzed), 1)
    total_pos = sum(a['pos'] for a in analyzed)
    total_neg = sum(a['neg'] for a in analyzed)

    return {
        'sev': sev, 'inf': inf, 'fed': fed, 'gdp': gdp,
        'tar': tar, 'geo': geo, 'jgb': jgb, 'fis': fis, 'usd': usd, 'rob': rob,
        'confidence': {
            'sev': {k: v for k, v in sev_scores.items()},
            'inf': {'down': inf_d, 'sticky': inf_s, 'high': inf_h},
            'fed': {'cut': fed_c, 'hold': fed_h, 'hike': fed_k},
            'gdp': {'soft': gdp_s, 'recession': gdp_r, 'hard': gdp_h},
            'tar': {'truce': tar_t, 'deescalate': 0, 'escalate': tar_e},
            'geo': {'stable': geo_s, 'tension': geo_c, 'conflict': geo_c},
            'jgb': {'anchored': 0, 'normalization': jgb_n, 'crisis': jgb_c},
            'fis': {'austerity': fis_a, 'neutral': 0, 'stimulus': fis_s},
            'usd': {'weak': usd_w, 'neutral': 0, 'strong': usd_s},
        },
        'sentiment': {
            'avg_finbert': round(avg_finbert, 3),
            'positive_keywords': total_pos,
            'negative_keywords': total_neg,
            'overall': 'bearish' if avg_finbert < -0.15 else ('bullish' if avg_finbert > 0.15 else 'mixed'),
        },
    }


def top_headlines(articles, n=15):
    seen = set()
    unique = []
    for a in articles:
        t = a['title'].strip()
        if t and t not in seen:
            seen.add(t)
            unique.append(a)
    return [{'title': a['title'], 'source': a['source']} for a in unique[:n]]


def main():
    if not HAS_FEEDPARSER:
        print('ERROR: feedparser not installed. Run: pip install feedparser', file=sys.stderr)
        sys.exit(1)

    print('Fetching financial news from RSS feeds...', file=sys.stderr)
    all_articles = []
    sources_ok = []
    sources_fail = []
    for name, url in RSS_FEEDS:
        entries = fetch_feed(name, url)
        if entries:
            print(f'  [ok]   {name}: {len(entries)} articles', file=sys.stderr)
            all_articles.extend(entries)
            sources_ok.append(name)
        else:
            print(f'  [fail] {name}', file=sys.stderr)
            sources_fail.append(name)

    print(f'\nTotal: {len(all_articles)} articles from {len(sources_ok)} sources', file=sys.stderr)

    if not all_articles:
        print('ERROR: No articles fetched.', file=sys.stderr)
        sys.exit(1)

    print('Analyzing sentiment and topics...', file=sys.stderr)
    analyzed = analyze_articles(all_articles)

    print('Mapping to simulation dials...', file=sys.stderr)
    result = infer_dials(analyzed)

    output = {
        'timestamp': datetime.now(timezone.utc).isoformat(),
        'dials': {
            'sev': result['sev'],
            'inf': result['inf'],
            'fed': result['fed'],
            'gdp': result['gdp'],
            'tar': result['tar'],
            'geo': result['geo'],
            'jgb': result['jgb'],
            'fis': result['fis'],
            'usd': result['usd'],
            'rob': result['rob'],
        },
        'confidence': result['confidence'],
        'sentiment': result['sentiment'],
        'headlines': top_headlines(all_articles, 20),
        'sources': {
            'ok': sources_ok,
            'failed': sources_fail,
            'total_articles': len(all_articles),
        },
    }

    out_path = HERE / 'current_situation.json'
    out_path.write_text(json.dumps(output, indent=2))
    print(f'\nWritten: {out_path}', file=sys.stderr)

    if '--stdout' in sys.argv or len(sys.argv) < 2:
        print(json.dumps(output, indent=2))

    return output


if __name__ == '__main__':
    main()
