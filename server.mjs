#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';

import { loadConfig, canvasCredentials } from './lib/env.mjs';
import { fetchCanvas, mockCanvas, CanvasCache, CanvasError } from './lib/canvas.mjs';
import { scanProjects } from './lib/projects.mjs';
import { recentFiles } from './lib/files.mjs';
import { Store } from './lib/store.mjs';
import { syncOnce, deviceInfo, SyncError } from './lib/sync.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const DATA = path.join(ROOT, 'data');
const cfg = loadConfig(ROOT);
const PORT = Number(process.env.PORT || cfg.port || 4747);
const HOST = '127.0.0.1';
const MOCK = process.env.CANVAS_MOCK === '1';

const store = new Store(DATA);
const cache = new CanvasCache(DATA);
const device = deviceInfo(DATA);
store.noteSemester(cfg.semester);

/* ------------------------------------------------------------------ */
/* Canvas (cached on disk, refreshed in the background)                */
/* ------------------------------------------------------------------ */

let canvasInFlight = null;
let lastCanvasError = null;

async function getCanvas({ refresh = false } = {}) {
  const creds = canvasCredentials(cfg, ROOT);
  if (MOCK || !creds.configured) {
    return { ...mockCanvas(), configured: creds.configured, mock: true, error: null };
  }
  const cached = cache.read();
  const ageMin = cached ? (Date.now() - new Date(cached.fetchedAt).getTime()) / 60000 : Infinity;
  if (cached && !refresh && ageMin < cfg.canvas.cacheMinutes) {
    return { ...cached, configured: true, mock: false, error: lastCanvasError };
  }
  if (!canvasInFlight) {
    canvasInFlight = fetchCanvas(creds, { ...cfg.canvas, semesterName: cfg.semester?.name })
      .then((payload) => {
        const site = creds.url.replace(/\/api\/v1$/, '');
        for (const c of payload.courses) if (!c.url) c.url = `${site}/courses/${c.id}`;
        cache.write(payload);
        lastCanvasError = null;
        return payload;
      })
      .catch((err) => {
        lastCanvasError = err instanceof CanvasError ? err.message : `Could not reach Canvas: ${err.message}`;
        console.error('[canvas]', lastCanvasError);
        return null;
      })
      .finally(() => {
        canvasInFlight = null;
      });
  }
  const fresh = await canvasInFlight;
  if (fresh) return { ...fresh, configured: true, mock: false, error: null };
  if (cached) return { ...cached, configured: true, mock: false, stale: true, error: lastCanvasError };
  return { courses: [], items: [], announcements: [], fetchedAt: null, source: 'none', configured: true, mock: false, error: lastCanvasError };
}

/* ------------------------------------------------------------------ */
/* Projects + files (memory cached, cheap to rebuild)                  */
/* ------------------------------------------------------------------ */

let projectsCache = { at: 0, data: null, inFlight: null };
async function getProjects({ refresh = false } = {}) {
  const fresh = Date.now() - projectsCache.at < 120000;
  if (projectsCache.data && fresh && !refresh) return projectsCache.data;
  if (!projectsCache.inFlight) {
    projectsCache.inFlight = scanProjects(cfg.projects)
      .then((data) => {
        projectsCache = { at: Date.now(), data, inFlight: null };
        return data;
      })
      .catch((err) => {
        projectsCache.inFlight = null;
        throw err;
      });
  }
  return projectsCache.inFlight;
}

/* ------------------------------------------------------------------ */
/* Sync                                                                */
/* ------------------------------------------------------------------ */

const syncState = { running: false, lastAt: null, lastError: null, pushed: false, devices: {} };
let syncTimer = null;
let syncQueued = false;

/** A semester pulled from the other machine is written back into config.json. */
function applySemester(doc) {
  const incoming = doc?.semester?.value;
  if (!incoming || JSON.stringify(incoming) === JSON.stringify(cfg.semester)) return;
  cfg.semester = incoming;
  try {
    const file = path.join(ROOT, 'config.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    raw.semester = incoming;
    fs.writeFileSync(file, JSON.stringify(raw, null, 2) + '\n');
    store.noteSemester(incoming);
    console.log('[sync] semester dates updated from another machine');
  } catch (err) {
    console.error('[sync] could not update config.json:', err.message);
  }
}

async function runSync({ reason = 'manual' } = {}) {
  if (!cfg.sync?.repo) return { ...syncState, configured: false };
  if (syncState.running) {
    syncQueued = true;
    return { ...syncState, configured: true };
  }
  syncState.running = true;
  try {
    const res = await syncOnce({ repo: cfg.sync.repo, store, device, semester: cfg.semester, onMerged: (doc) => applySemester(doc) });
    syncState.lastAt = new Date().toISOString();
    syncState.lastError = null;
    syncState.pushed = res.pushed;
    syncState.devices = res.devices || {};
    if (reason !== 'poll' || res.pushed) console.log(`[sync] ${res.pushed ? 'sent changes' : 'up to date'} (${reason})`);
  } catch (err) {
    syncState.lastError = { message: err.message, hint: err.hint || '', fatal: !!err.fatal };
    console.error('[sync]', err.message);
  } finally {
    syncState.running = false;
  }
  if (syncQueued) {
    syncQueued = false;
    return runSync({ reason: 'follow-up' });
  }
  return { ...syncState, configured: true };
}

/** Local edits settle for a moment before they are sent, so typing does not hit the network. */
function scheduleSync(reason) {
  if (!cfg.sync?.repo || cfg.sync.auto === false) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => runSync({ reason }), 2500);
}

const syncStatus = () => ({
  configured: !!cfg.sync?.repo,
  auto: cfg.sync?.auto !== false,
  repo: cfg.sync?.repo || null,
  device,
  running: syncState.running,
  lastAt: syncState.lastAt,
  lastError: syncState.lastError,
  devices: syncState.devices,
});

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(text);
}

function readBody(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

/** Mutating requests must come from this page, not from some other site in the browser. */
function sameOrigin(req) {
  const origin = req.headers.origin;
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return false;
  if (origin && !origin.startsWith(`http://${HOST}:${PORT}`) && !origin.startsWith(`http://localhost:${PORT}`)) return false;
  return true;
}

function insideHome(p) {
  const home = os.homedir();
  const resolved = path.resolve(p);
  return resolved === home || resolved.startsWith(home + path.sep);
}

/* Opening things is the one place the three platforms genuinely differ. */
const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';
const LOCAL = process.env.LOCALAPPDATA || '';
const PROGRAMS = process.env.ProgramFiles || 'C:\\Program Files';

const APPS = IS_MAC
  ? {
      code: { label: 'VS Code', probe: ['/Applications/Visual Studio Code.app'], open: (p) => ['open', ['-a', 'Visual Studio Code', p]] },
      cursor: { label: 'Cursor', probe: ['/Applications/Cursor.app'], open: (p) => ['open', ['-a', 'Cursor', p]] },
      terminal: { label: 'Terminal', probe: ['/System/Applications/Utilities/Terminal.app'], open: (p) => ['open', ['-a', 'Terminal', p]] },
    }
  : IS_WIN
    ? {
        code: { label: 'VS Code', probe: [path.join(LOCAL, 'Programs/Microsoft VS Code/Code.exe'), path.join(PROGRAMS, 'Microsoft VS Code/Code.exe')], open: (p, exe) => [exe, [p]] },
        cursor: { label: 'Cursor', probe: [path.join(LOCAL, 'Programs/cursor/Cursor.exe')], open: (p, exe) => [exe, [p]] },
        terminal: { label: 'Terminal', probe: [path.join(LOCAL, 'Microsoft/WindowsApps/wt.exe')], open: (p, exe) => [exe, ['-d', p]] },
      }
    : {
        code: { label: 'VS Code', probe: ['/usr/bin/code', '/usr/local/bin/code', '/snap/bin/code'], open: (p, exe) => [exe, [p]] },
      };

const appExe = (a) => (a.probe || []).find((f) => { try { return fs.existsSync(f); } catch { return false; } });
const installedApps = () => Object.fromEntries(Object.entries(APPS).filter(([, a]) => appExe(a)).map(([k, a]) => [k, a.label]));

const revealCmd = (p) => (IS_MAC ? ['open', ['-R', p]] : IS_WIN ? ['explorer', [`/select,${p}`]] : ['xdg-open', [path.dirname(p)]]);
const openCmd = (p) => (IS_MAC ? ['open', [p]] : IS_WIN ? ['cmd', ['/c', 'start', '', p]] : ['xdg-open', [p]]);

const OPEN_WITH = {
  default: openCmd,
  finder: revealCmd,
  ...Object.fromEntries(Object.entries(APPS).map(([k, a]) => [k, (p) => a.open(p, appExe(a))])),
};

function openPath(target, app = 'default') {
  const make = OPEN_WITH[app];
  if (!make) throw new Error('unknown app');
  if (APPS[app] && !appExe(APPS[app])) throw new Error(`${APPS[app].label} is not installed here`);
  if (!insideHome(target) || !fs.existsSync(target)) throw new Error('path must exist inside your home folder');
  const [cmd, args] = make(target);
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 8000 }, (err) => (err ? reject(err) : resolve(true)));
  });
}

/** Third-party assets served straight from node_modules, so there is no build step. */
const VENDOR = {
  '/vendor/xterm.mjs': '@xterm/xterm/lib/xterm.mjs',
  '/vendor/xterm.css': '@xterm/xterm/css/xterm.css',
  '/vendor/addon-fit.mjs': '@xterm/addon-fit/lib/addon-fit.mjs',
};

function serveVendor(res, pathname) {
  const rel = VENDOR[pathname];
  const file = path.join(ROOT, 'node_modules', rel);
  fs.readFile(file, (err, buf) => {
    if (err) return json(res, 404, { error: `${rel} is missing. Run: npm install` });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC)) return json(res, 403, { error: 'forbidden' });
  fs.readFile(file, (err, buf) => {
    if (err) return json(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

/* ------------------------------------------------------------------ */
/* Router                                                              */
/* ------------------------------------------------------------------ */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const refresh = url.searchParams.get('refresh') === '1';
  try {
    if (url.pathname === '/api/config' && req.method === 'GET') {
      const creds = canvasCredentials(cfg, ROOT);
      return json(res, 200, {
        semester: cfg.semester,
        pins: cfg.pins,
        shell: cfg.shell || null,
        canvas: { configured: creds.configured, host: creds.url ? new URL(creds.url).host : null, envFile: cfg.canvas.envFile, mock: MOCK },
        home: os.homedir(),
        apps: installedApps(),
        sync: syncStatus(),
        platform: process.platform,
        now: new Date().toISOString(),
      });
    }
    if (url.pathname === '/api/canvas' && req.method === 'GET') return json(res, 200, await getCanvas({ refresh }));
    if (url.pathname === '/api/projects' && req.method === 'GET') return json(res, 200, await getProjects({ refresh }));
    if (url.pathname === '/api/files' && req.method === 'GET') return json(res, 200, recentFiles(cfg.files));
    if (url.pathname === '/api/state' && req.method === 'GET') return json(res, 200, store.view());
    if (url.pathname === '/api/state' && req.method === 'PUT') {
      if (!sameOrigin(req)) return json(res, 403, { error: 'cross-origin write refused' });
      const saved = store.patch(await readBody(req));
      scheduleSync('local edit');
      return json(res, 200, saved);
    }
    if (url.pathname === '/api/sync' && req.method === 'GET') return json(res, 200, syncStatus());
    if (url.pathname === '/api/sync' && req.method === 'POST') {
      if (!sameOrigin(req)) return json(res, 403, { error: 'cross-origin write refused' });
      await runSync({ reason: 'button' });
      return json(res, 200, syncStatus());
    }
    if (url.pathname === '/api/open' && req.method === 'POST') {
      if (!sameOrigin(req)) return json(res, 403, { error: 'cross-origin write refused' });
      const body = await readBody(req);
      await openPath(String(body.path || ''), String(body.app || 'default'));
      return json(res, 200, { ok: true });
    }
    if (VENDOR[url.pathname]) return serveVendor(res, url.pathname);
    if (url.pathname.startsWith('/api/')) return json(res, 404, { error: 'no such endpoint' });
    return serveStatic(req, res, url.pathname);
  } catch (err) {
    console.error(`[${req.method} ${url.pathname}]`, err.message);
    return json(res, 500, { error: err.message });
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') console.error(`Port ${PORT} is already in use. Season may already be running at http://localhost:${PORT}`);
  else console.error(err);
  process.exit(1);
});
server.listen(PORT, HOST, () => {
  const creds = canvasCredentials(cfg, ROOT);
  const addr = `http://localhost:${PORT}`;
  console.log(`Season is on the board at ${addr}`);
  console.log(MOCK ? '  Canvas: mock data (CANVAS_MOCK=1)' : creds.configured ? `  Canvas: ${creds.url}` : `  Canvas: not configured yet, showing sample data. Add your token to ${cfg.canvas.envFile}`);
  if (process.argv.includes('--open')) { const [c, a] = openCmd(addr); execFile(c, a); }
  if (cfg.sync?.repo) {
    console.log(`  Sync: ${cfg.sync.repo} as ${device.name}`);
    runSync({ reason: 'startup' });
    setInterval(() => runSync({ reason: 'poll' }), 5 * 60000);
  } else {
    console.log('  Sync: off. Run `npm run sync:setup` to share this with another computer.');
  }
  // Warm the caches so the first paint has data.
  getCanvas().catch(() => {});
  getProjects().catch(() => {});
});
