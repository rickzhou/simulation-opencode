# AI bubble-bust simulation

A self-contained dashboard simulating an AI-bubble collapse over five years (May 2026 - May 2031). 26,244 scenarios from nine dials: bust severity, inflation regime, Fed policy, GDP outcome, tariff regime, geopolitics, Japanese bonds, fiscal policy, and the US dollar. Twelve one-click presets snap all nine dials to canonical historical analogs (dot-com, 1970s stagflation, 2008 GFC, Volcker, melt-up, trade-war stagflation, soft landing, policy error, global conflict, yen carry unwind, 2022 rate shock, 2020 COVID+stimulus).

## What's new in v7

- **Dial 8 — Fiscal Policy** (austerity / neutral / stimulus): Government spending and deficit regime. Stimulus boosts cyclicals, REITs and Bitcoin but pushes the long end higher; austerity is deflationary and hurts cyclicals.
- **Dial 9 — US Dollar** (weak / neutral / strong): The DXY regime. Strong dollar is a "wrecking ball" — crushes commodities, EM-sensitive sectors and Bitcoin. Weak dollar boosts gold, copper, oil and crypto.
- **New asset classes**: Commercial REITs (office, retail, data-center), Residential REITs (apartments, SFR, homebuilders), and Bitcoin (BTC-USD).
- **New presets**: 2022 Rate Shock (validates TLT -31%, REITs -25%, BTC -65%) and 2020 COVID+Stimulus (validates the V-shaped recovery playbook).
- **26,244 scenarios** (up from 2,916 in v6).

## How to view

Open `AI-bubble-bust-simulation.html` in any modern browser (Chrome, Edge, Firefox, Safari). The file is self-contained - the only thing it loads from the network is the Chart.js library from a CDN.

## Current Situation (live news analysis)

The dashboard has a **Current Situation** button at the top that analyzes live financial news and automatically sets all nine dials to match today's market conditions.

### How it works

1. `src/fetchNews.ts` pulls RSS feeds from 23 financial news sources (CNBC, Yahoo Finance, FT, WSJ, Seeking Alpha, MarketWatch, Investing.com, Bloomberg, ZeroHedge, Nasdaq, Benzinga, and more)
2. FinBERT (financial BERT, via `@xenova/transformers`) scores each headline for bullish/bearish tone
3. Keyword analysis maps topics to the ten simulation dials (severity, inflation, Fed, GDP, tariffs, geopolitics, JGB, fiscal, USD, robotics)
4. The recommended dial settings are baked into the HTML at build time

### Usage

```bash
cd source
# Fetch fresh news and rebuild the dashboard:
npm run build -- --skip-sim --news

# Full rebuild (simulation + news):
npm run build -- --news
```

Best of all, run the live server (`npm run serve`) and open the dashboard in a
browser — it auto-fetches the latest news on load and refreshes every 60
minutes. You can also click **Pull Latest News** to refresh on demand.

### Dependencies

The project runs on **Node.js 20+** with TypeScript (executed via `tsx`). The
news feature uses `rss-parser` and `@xenova/transformers` (which downloads the
`Xenova/finbert` ONNX model on first run and caches it). Install everything with:

```bash
cd source
npm install
```

## Cross-PC sync

This folder is inside your Synology Drive (`stock/simulation/market simulation/`), so it auto-syncs to every PC where the Synology Drive client is installed and signed in to the same account. On any such PC, just navigate to the same folder and double-click the HTML file.

If you ever want to open it on a PC that does *not* have Synology Drive, the HTML file is a single self-contained ~2 MB file - you can email it, drop it on a USB stick, or upload it to any cloud (Dropbox, Google Drive, OneDrive, iCloud).

## Regenerating from source (optional)

Everything needed to rebuild the dashboard lives in `source/` (a Node.js +
TypeScript project):

- `src/simulate.ts` - the 26,244-scenario model. No runtime services required - pure computation.
- `src/fetchNews.ts` - fetches financial news from RSS feeds, scores sentiment with FinBERT, and maps to dial settings.
- `src/server.ts` - HTTP server that serves the dashboard and the live `/api/current-situation` news endpoint.
- `src/build.ts` - convenience script that runs the sim and writes the deployed HTML.
- `dashboard_template.html` - the dashboard shell with `/*__SIM_DATA__*/` and `/*__CURRENT_SITUATION__*/` placeholders.
- `sim_data.json` - the most recent generated data.
- `current_situation.json` - the most recent news analysis output.
- `package.json` / `tsconfig.json` - project manifest and TypeScript config.

To rebuild (after `npm install`):

```bash
cd source
npm run build                       # full rebuild (runs the simulation)
npm run build -- --skip-sim         # skip simulation (use existing sim_data.json)
npm run build -- --news             # also fetch live news for Current Situation
npm run build -- --skip-sim --news  # fast: just inject news into existing build
```

Other scripts: `npm run serve` (live server on :9999), `npm run simulate`
(regenerate `sim_data.json` only), `npm run fetch-news` (regenerate
`current_situation.json` only), `npm run typecheck`.

That refreshes `AI-bubble-bust-simulation.html` one folder up. Edit
`src/simulate.ts` to change scenarios, model parameters, or add metrics; edit
`dashboard_template.html` to change the UI.

## What the nine dials do

- **Severity** (melt / mild / base / severe) - the equity-bust shape.
- **Inflation** (down / sticky / high) - the CPI regime.
- **Fed** (cut / hold / hike) - the Fed funds path.
- **GDP** (soft landing / recession / hard landing) - the real-economy outcome.
- **Tariffs** (truce / de-escalate / escalate) - the US-China trade regime. Adds ~1pp goods CPI on escalation, drags trade-exposed sectors, bids gold and agriculture, offers copper and uranium.
- **Geopolitics** (stable / tension / conflict) - the world political environment. Adds energy and safe-haven commodity tilts; defense benefits, tech suffers.
- **JGB / Japan** (anchored / normalization / crisis) - the Japanese bond market. Moves the US long end independent of the Fed via yen-carry trade dynamics.
- **Fiscal** (austerity / neutral / stimulus) - government spending and deficit regime. Stimulus boosts cyclicals, REITs and Bitcoin but pushes the long end higher (crowding-out). Austerity is deflationary.
- **USD** (weak / neutral / strong) - the dollar regime. Strong dollar is a "wrecking ball" on commodities, EM and Bitcoin. Weak dollar boosts gold, copper, oil and crypto.

The dials are deliberately independent, so you can build coherent combinations (high inflation + Fed hikes = Volcker response) and policy errors (high inflation + Fed cuts + tariff escalation). Section 13 (Scenario finder) ranks all 26,244 by any metric so you can jump straight to the best or worst corners.

## Presets

Above the dial rows are twelve historical-analog presets that snap all nine dials at once: **Dot-com 2000-02**, **1970s Stagflation**, **2008 GFC**, **Volcker 1979-82**, **AI Melt-up continues**, **Trade-war Stagflation**, **Soft landing**, **Policy error**, **Global Conflict Shock**, **Yen Carry Unwind**, **2022 Rate Shock**, and **2020 COVID + Stimulus**.

The last two presets are specifically for **historical validation**: the 2022 Rate Shock preset should produce TLT drawdowns near -31%, REITs near -25%, and Bitcoin near -65% — matching what actually happened. The 2020 COVID + Stimulus preset should produce a severe crash followed by a massive V-shaped recovery.

Not investment advice - this is a scenario explorer, not a forecast.
