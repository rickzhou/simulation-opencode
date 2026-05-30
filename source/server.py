#!/usr/bin/env python3
"""Web server for AI Bubble-Bust Simulation dashboard.

Serves the dashboard and provides live news analysis API.

Usage:
    python3 server.py              # start on port 9999
    python3 server.py --port 8080  # custom port

Access from LAN: http://<your-ip>:9999
"""
import http.server
import socketserver
import json
import sys
import subprocess
from pathlib import Path
from urllib.parse import urlparse, parse_qs

HERE = Path(__file__).resolve().parent
PARENT = HERE.parent

try:
    from fetch_news import main as fetch_news_main
    HAS_FETCH = True
except ImportError:
    HAS_FETCH = False


class SimHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(PARENT), **kwargs)

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if path == '/' or path == '':
            self.serve_dashboard()
        elif path == '/api/current-situation':
            self.handle_current_situation()
        elif path == '/api/rebuild':
            self.handle_rebuild()
        else:
            super().do_GET()

    def serve_dashboard(self):
        html_path = PARENT / 'AI-bubble-bust-simulation.html'
        if not html_path.exists():
            self.send_error(404, 'Dashboard not found. Run build.py first.')
            return

        content = html_path.read_bytes()
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(content)))
        self.send_header('Cache-Control', 'no-cache')
        self.end_headers()
        self.wfile.write(content)

    def handle_current_situation(self):
        if not HAS_FETCH:
            self.send_json_error(500, 'fetch_news module not available')
            return

        try:
            result = fetch_news_main()
            self.send_json(200, result)
        except Exception as e:
            self.send_json_error(500, f'Error fetching news: {str(e)}')

    def handle_rebuild(self):
        try:
            venv_py = HERE / '.venv' / 'bin' / 'python3'
            py = str(venv_py) if venv_py.exists() else sys.executable

            result = subprocess.run(
                [py, str(HERE / 'build.py'), '--skip-sim', '--news'],
                cwd=HERE,
                capture_output=True,
                text=True,
                timeout=120
            )

            if result.returncode == 0:
                self.send_json(200, {
                    'status': 'ok',
                    'message': 'Dashboard rebuilt with fresh news',
                    'output': result.stdout
                })
            else:
                self.send_json_error(500, f'Rebuild failed: {result.stderr}')
        except subprocess.TimeoutExpired:
            self.send_json_error(504, 'Rebuild timed out')
        except Exception as e:
            self.send_json_error(500, f'Error rebuilding: {str(e)}')

    def send_json(self, code, data):
        content = json.dumps(data, indent=2).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(content)))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(content)

    def send_json_error(self, code, message):
        self.send_json(code, {'error': message})

    def log_message(self, format, *args):
        print(f"[{self.log_date_time_string()}] {format % args}")


def main():
    port = 9999
    if '--port' in sys.argv:
        idx = sys.argv.index('--port')
        if idx + 1 < len(sys.argv):
            port = int(sys.argv[idx + 1])

    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(('0.0.0.0', port), SimHandler) as httpd:
        print(f'Server running on:', flush=True)
        print(f'  Local:   http://localhost:{port}', flush=True)
        print(f'  LAN:     http://0.0.0.0:{port}', flush=True)
        print(f'\nPress Ctrl+C to stop', flush=True)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print('\nShutting down...', flush=True)


if __name__ == '__main__':
    main()
