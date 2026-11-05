// Local-only browser fixture; no external API, filesystem scan or real credentials.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = resolve(fileURLToPath(new URL('../dist', import.meta.url)));
const admin = process.env.FIXTURE_ADMIN !== '0';
const routes = new Map([
  ['/api/v1/session', { authenticated: true, csrf_token: 'fixture-csrf', user: { id: 'fixture', name: 'Тестовый пользователь', admin } }],
  ['/audit/api/instance', { machineName: 'test-server', roots: [{ name: 'Документы', localPath: 'D:\\Fixture', serverUNC: '', dfsPath: '' }], thresholds: { warningPathLength: 180, badPathLength: 220, criticalPathLength: 250, longNameLength: 100, maxDepth: 12 }, latestCompletedScanId: null, latestCompletedScanFinishedAtUtc: null, latestCompletedRootNames: [] }],
  ['/audit/api/scans', []],
  ['/audit/api/departments', []],
]);
const types = { '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.html': 'text/html' };
createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
  if (url.pathname === '/audit/api/scans/current') { res.writeHead(204).end(); return; }
  if (routes.has(url.pathname)) { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(routes.get(url.pathname))); return; }
  if (url.pathname.startsWith('/api/') || url.pathname.includes('/api/')) { res.writeHead(404).end(); return; }
  const relative = url.pathname.startsWith('/audit/') ? url.pathname.slice('/audit/'.length) : url.pathname.replace(/^\//, '');
  if (url.pathname.startsWith('/audit/') && relative === 'theme-init.js') { res.writeHead(404).end(); return; }
  const file = relative.startsWith('assets/') || relative.startsWith('ecosystem/') || relative === 'favicon.svg' || relative === 'theme-init.js' ? relative : 'index.html';
  const full = resolve(dist, file);
  if (!full.startsWith(dist + sep)) { res.writeHead(404).end(); return; }
  try { const body = await readFile(full); res.writeHead(200, { 'content-type': types[extname(full)] || 'application/octet-stream' }).end(body); }
  catch { res.writeHead(404).end(); }
}).listen(Number(process.env.FIXTURE_PORT || 0), '127.0.0.1', function () {
  process.stdout.write(`fixture listening ${this.address().port}\n`);
});
