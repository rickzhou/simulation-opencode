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

1. `fetch_news.py` pulls RSS feeds from 15 financial news sources (CNBC, Yahoo Finance, FT, WSJ, Seeking Alpha, MarketWatch, Investing.com, Reuters)
2. NLP sentiment analysis (VADER) scores each headline for bullish/bearish tone
3. Keyword analysis maps topics to the nine simulation dials (severity, inflation, Fed, GDP, tariffs, geopolitics, JGB, fiscal, USD)
4. The recommended dial settings are baked into the HTML at build time

### Usage

```bash
cd source
# Fetch fresh news and rebuild the dashboard:
python3 build.py --skip-sim --news

# Full rebuild (simulation + news):
python3 build.py --news
```

Then open the HTML and click the **Current Situation** button to see the analysis and apply the settings.

### Dependencies

The news feature requires `feedparser` and `nltk` (with VADER lexicon). A virtual environment is included:

```bash
cd source
source .venv/bin/activate
```

Or install manually: `pip install feedparser nltk && python3 -c "import nltk; nltk.download('vader_lexicon')"`

## Cross-PC sync

This folder is inside your Synology Drive (`stock/simulation/market simulation/`), so it auto-syncs to every PC where the Synology Drive client is installed and signed in to the same account. On any such PC, just navigate to the same folder and double-click the HTML file.

If you ever want to open it on a PC that does *not* have Synology Drive, the HTML file is a single self-contained ~2 MB file - you can email it, drop it on a USB stick, or upload it to any cloud (Dropbox, Google Drive, OneDrive, iCloud).

## Regenerating from source (optional)

Everything needed to rebuild the dashboard lives in `source/`:

- `simulate.py` - the 26,244-scenario Python model. No external packages required - pure stdlib.
- `dashboard_template.html` - the dashboard shell with a `/*__SIM_DATA__*/` placeholder.
- `sim_data.json` - the most recent generated data.
- `build.py` - convenience script that runs the sim and writes the deployed HTML.
- `fetch_news.py` - fetches financial news from RSS feeds, analyzes sentiment with NLP, and maps to dial settings.
- `current_situation.json` - the most recent news analysis output.
- `.venv/` - Python virtual environment with `feedparser` and `nltk` for the news feature.

To rebuild:

```bash
cd source
python3 build.py                # full rebuild (runs simulate.py)
python3 build.py --skip-sim     # skip simulation (use existing sim_data.json)
python3 build.py --news         # also fetch live news for Current Situation
python3 build.py --skip-sim --news  # fast: just inject news into existing build
```

That refreshes `AI-bubble-bust-simulation.html` one folder up. Edit `simulate.py` to change scenarios, model parameters, or add metrics; edit `dashboard_template.html` to change the UI.

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
