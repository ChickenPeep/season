import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function expandHome(p) {
  if (!p) return p;
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

/** Minimal .env parser: KEY=value lines, ignores comments and blanks. */
export function readEnvFile(file) {
  const out = {};
  let text;
  try {
    text = fs.readFileSync(expandHome(file), 'utf8');
  } catch {
    return out;
  }
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

export function loadConfig(root) {
  const file = path.join(root, 'config.json');
  if (!fs.existsSync(file)) fs.copyFileSync(path.join(root, 'config.example.json'), file);
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  cfg.canvas.envFile = expandHome(cfg.canvas.envFile);
  cfg.projects.roots = cfg.projects.roots.map(expandHome);
  cfg.files.roots = cfg.files.roots.map(expandHome);
  return cfg;
}

/**
 * Resolve Canvas credentials, in order: real environment variables, a .env beside
 * this repo, then the Canvas MCP's own .env. The middle one matters on a machine
 * that has Season but not the MCP server.
 */
export function canvasCredentials(cfg, root) {
  const local = root ? readEnvFile(path.join(root, '.env')) : {};
  const shared = readEnvFile(cfg.canvas.envFile);
  const fileEnv = { ...shared, ...local };
  const token = process.env.CANVAS_API_TOKEN || fileEnv.CANVAS_API_TOKEN || '';
  const url = process.env.CANVAS_API_URL || fileEnv.CANVAS_API_URL || '';
  const placeholder =
    !token || token.includes('your_canvas_api_token') || !url || url.includes('your-institution');
  return { token, url: url.replace(/\/+$/, ''), configured: !placeholder };
}
