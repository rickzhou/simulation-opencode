#!/usr/bin/env python3
"""Rebuild the AI-bubble-bust dashboard.

Runs simulate.py to refresh the data, optionally runs fetch_news.py for
current situation data, then injects everything into dashboard_template.html
and writes the deployed HTML one folder up.

Usage (from this folder):
    python3 build.py              # rebuild (runs simulate.py)
    python3 build.py --news       # also fetch live news
    python3 build.py --skip-sim   # skip simulate.py (use existing sim_data.json)
    python3 build.py --skip-sim --news  # fast rebuild with news only
"""
import pathlib, subprocess, sys, json

HERE = pathlib.Path(__file__).resolve().parent
OUT  = HERE.parent / 'AI-bubble-bust-simulation.html'

skip_sim = '--skip-sim' in sys.argv
if not skip_sim:
    print('[1/3] running simulate.py ...')
    subprocess.run([sys.executable, str(HERE / 'simulate.py')], cwd=HERE, check=True)
else:
    print('[1/3] skipping simulate.py (--skip-sim)')

news_data = 'null'
if '--news' in sys.argv:
    print('[2/3] running fetch_news.py ...')
    venv_py = HERE / '.venv' / 'bin' / 'python3'
    py = str(venv_py) if venv_py.exists() else sys.executable
    subprocess.run([py, str(HERE / 'fetch_news.py'), '--stdout'],
                   cwd=HERE, check=False, capture_output=True)
else:
    print('[2/3] skipping fetch_news.py (use --news to fetch)')

cs_path = HERE / 'current_situation.json'
if cs_path.exists():
    news_data = cs_path.read_text()
    print(f'  loaded current_situation.json ({len(news_data)} bytes)')
else:
    print('  no current_situation.json found')

print('[3/3] injecting data into dashboard_template.html ...')
data = (HERE / 'sim_data.json').read_text()
tpl  = (HERE / 'dashboard_template.html').read_text()
html = tpl.replace('/*__SIM_DATA__*/', data)
html = html.replace('/*__CURRENT_SITUATION__*/', news_data)
OUT.write_text(html)
print(f'written: {OUT}  ({round(len(html)/1024/1024,2)} MB)')
