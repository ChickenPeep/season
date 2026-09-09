import fs from 'node:fs';
import path from 'node:path';

function globToRegex(g) {
  return new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i');
}

/** Recently modified files across the configured roots, newest first. */
export function recentFiles(cfg) {
  const cutoff = Date.now() - cfg.recentDays * 86400000;
  const ignore = (cfg.ignore || []).map(globToRegex);
  const skip = (name) => ignore.some((re) => re.test(name));
  const out = [];

  const walk = (dir, depth) => {
    if (depth > 3) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || skip(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name.endsWith('.app') || e.name.endsWith('.xcarchive')) continue;
        if (fs.existsSync(path.join(full, '.git'))) continue; // a repo: the Projects panel owns it
        walk(full, depth + 1);
      } else if (e.isFile()) {
        let st;
        try {
          st = fs.statSync(full);
        } catch {
          continue;
        }
        if (st.mtimeMs < cutoff) continue;
        out.push({ name: e.name, path: full, dir: path.dirname(full), size: st.size, modifiedAt: st.mtime.toISOString(), kind: kindOf(e.name) });
      }
    }
  };
  for (const r of cfg.roots) walk(r, 0);
  out.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  return out.slice(0, cfg.limit);
}

function kindOf(name) {
  const ext = path.extname(name).toLowerCase().slice(1);
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic'].includes(ext)) return 'image';
  if (['mp4', 'mov', 'm4v'].includes(ext)) return 'video';
  if (['pdf'].includes(ext)) return 'pdf';
  if (['md', 'txt', 'rtf'].includes(ext)) return 'text';
  if (['ts', 'tsx', 'js', 'mjs', 'jsx', 'py', 'swift', 'json', 'css', 'html', 'sql'].includes(ext)) return 'code';
  if (['doc', 'docx', 'pptx', 'xlsx', 'key', 'pages', 'numbers'].includes(ext)) return 'doc';
  return 'file';
}
