#!/usr/bin/env tsx
/**
 * Web server for the AI Bubble-Bust Simulation dashboard.
 *
 * Serves the dashboard and provides a live news-analysis API.
 *
 * Faithful TypeScript port of server.py. The news pipeline (RSS + FinBERT) is
 * run as a subprocess so a ~1-minute analysis never blocks the HTTP server, and
 * its result is cached + de-duplicated across concurrent requests.
 *
 * Usage:
 *   npm run serve                 # start on port 9999
 *   npm run serve -- --port 8080  # custom port
 */
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, extname } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));   // source/src
const SRC = join(HERE, '..');                           // source/
const PARENT = join(HERE, '..', '..');                  // market simulation/
const DASHBOARD = join(PARENT, 'AI-bubble-bust-simulation.html');
const TSX = join(SRC, 'node_modules', '.bin', 'tsx');

// ---------- news cache (shared across concurrent requests) ----------
const NEWS_CACHE_TTL = 300_000; // ms
let newsCache: { data: any; ts: number } = { data: null, ts: 0 };
let newsInFlight: Promise<any> | null = null;

function runFetchNews(): Promise<any> {
  return new Promise((resolve, reject) => {
    const proc = spawn(TSX, [join('src', 'fetchNews.ts'), '--stdout'], { cwd: SRC });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error('news fetch timed out')); }, 240_000);
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => { err += d; });
    proc.on('error', (e) => { clearTimeout(timer); reject(e); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const tail = err.trim().split('\n').slice(-3).join(' | ');
        reject(new Error(`fetchNews failed: ${tail}`));
        return;
      }
      try { resolve(JSON.parse(out)); } catch (e) { reject(e as Error); }
    });
  });
}

async function fetchCurrentNews(): Promise<any> {
  const now = Date.now();
  if (newsCache.data && now - newsCache.ts < NEWS_CACHE_TTL) return newsCache.data;
  if (newsInFlight) return newsInFlight;
  newsInFlight = runFetchNews()
    .then((data) => { newsCache = { data, ts: Date.now() }; return data; })
    .finally(() => { newsInFlight = null; });
  return newsInFlight;
}

// ---------- helpers ----------
function sendJson(res: ServerResponse, code: number, data: unknown): void {
  const content = Buffer.from(JSON.stringify(data, null, 2), 'utf8');
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Content-Length': content.length,
    'Access-Control-Allow-Origin': '*',
  });
  res.end(content);
}
const sendJsonError = (res: ServerResponse, code: number, message: string) => sendJson(res, code, { error: message });

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.json': 'application/json', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain',
  '.md': 'text/markdown', '.webp': 'image/webp', '.woff': 'font/woff', '.woff2': 'font/woff2',
};

async function serveDashboard(res: ServerResponse): Promise<void> {
  try {
    const content = await readFile(DASHBOARD);
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': content.length,
      'Cache-Control': 'no-cache',
    });
    res.end(content);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Dashboard not found. Run build.ts first.');
  }
}

async function serveStatic(res: ServerResponse, urlPath: string): Promise<void> {
  // Resolve within PARENT, preventing path traversal.
  const rel = normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]+/, '');
  const filePath = join(PARENT, rel);
  if (!filePath.startsWith(PARENT)) { res.writeHead(403); res.end('Forbidden'); return; }
  try {
    const st = await stat(filePath);
    if (st.isDirectory()) { res.writeHead(403); res.end('Forbidden'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
    });
    createReadStream(filePath).pipe(res);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
}

async function handleRebuild(res: ServerResponse): Promise<void> {
  try {
    const result = spawnSync(TSX, [join('src', 'build.ts'), '--skip-sim', '--news'], {
      cwd: SRC, encoding: 'utf8', timeout: 120_000,
    });
    if (result.status === 0) {
      sendJson(res, 200, { status: 'ok', message: 'Dashboard rebuilt with fresh news', output: result.stdout });
    } else if (result.signal === 'SIGTERM') {
      sendJsonError(res, 504, 'Rebuild timed out');
    } else {
      sendJsonError(res, 500, `Rebuild failed: ${result.stderr}`);
    }
  } catch (e) {
    sendJsonError(res, 500, `Error rebuilding: ${(e as Error).message}`);
  }
}

function logRequest(req: IncomingMessage, code: number): void {
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${now}] ${req.method} ${req.url} ${code}`);
}

async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url || '/', 'http://localhost');
  const path = url.pathname;
  res.on('finish', () => logRequest(req, res.statusCode));
  try {
    if (path === '/' || path === '') {
      await serveDashboard(res);
    } else if (path === '/api/current-situation') {
      try {
        const data = await fetchCurrentNews();
        sendJson(res, 200, data);
      } catch (e) {
        sendJsonError(res, 500, `Error fetching news: ${(e as Error).message}`);
      }
    } else if (path === '/api/rebuild') {
      await handleRebuild(res);
    } else {
      await serveStatic(res, path);
    }
  } catch (e) {
    sendJsonError(res, 500, (e as Error).message);
  }
}

function main(): void {
  let port = 9999;
  const idx = process.argv.indexOf('--port');
  if (idx !== -1 && idx + 1 < process.argv.length) port = parseInt(process.argv[idx + 1], 10);

  const server = createServer((req, res) => { void handler(req, res); });
  server.listen(port, '0.0.0.0', () => {
    console.log('Server running on:');
    console.log(`  Local:   http://localhost:${port}`);
    console.log(`  LAN:     http://0.0.0.0:${port}`);
    console.log('\nPress Ctrl+C to stop');
  });
  process.on('SIGINT', () => { console.log('\nShutting down...'); server.close(() => process.exit(0)); });
}

main();
