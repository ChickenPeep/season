import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

async function git(cwd, args) {
  try {
    const { stdout } = await exec('git', ['-C', cwd, ...args], { timeout: 8000, maxBuffer: 1 << 20 });
    return stdout.trim();
  } catch {
    return '';
  }
}

/** Find git repositories under the configured roots (breadth-limited). */
export function findRepos(roots, maxDepth = 2) {
  const found = new Map();
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.name === '.git')) {
      found.set(path.resolve(dir), true);
      return; // don't descend into a repo looking for nested repos
    }
    if (depth >= maxDepth) return;
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
      walk(path.join(dir, e.name), depth + 1);
    }
  };
  for (const r of roots) walk(r, 0);
  return [...found.keys()];
}

/** First "## " heading after the title in docs/handoff.md, if the repo keeps one. */
function handoffHeadline(repo) {
  for (const rel of ['docs/handoff.md', 'HANDOFF.md', 'handoff.md']) {
    const f = path.join(repo, rel);
    if (!fs.existsSync(f)) continue;
    const text = fs.readFileSync(f, 'utf8');
    const current = text.match(/^## Current session[^\n]*/m);
    const any = text.match(/^## [^\n]+/m);
    const line = (current || any || [null])[0];
    return line ? { file: rel, headline: line.replace(/^## /, '').slice(0, 220) } : null;
  }
  return null;
}

function repoSlug(remote) {
  const m = remote.match(/github\.com[:/]([^/]+\/[^/.]+)(?:\.git)?/);
  return m ? m[1] : null;
}

async function openPRs(slug) {
  if (!slug) return [];
  try {
    const { stdout } = await exec(
      'gh',
      ['pr', 'list', '--repo', slug, '--state', 'open', '--limit', '10', '--json', 'number,title,headRefName,url,isDraft,updatedAt'],
      { timeout: 10000 }
    );
    return JSON.parse(stdout);
  } catch {
    return [];
  }
}

export async function describeRepo(dir, { withPRs = true } = {}) {
  const [branch, status, last, remote, upstream] = await Promise.all([
    git(dir, ['branch', '--show-current']),
    git(dir, ['status', '--porcelain']),
    git(dir, ['log', '-1', '--format=%s%x1f%cI%x1f%h']),
    git(dir, ['remote', 'get-url', 'origin']),
    git(dir, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}']),
  ]);
  const [subject, committedAt, sha] = last.split('\x1f');
  const [ahead, behind] = upstream ? upstream.split(/\s+/).map(Number) : [0, 0];
  const slug = repoSlug(remote);
  const worktree = fs.existsSync(path.join(dir, '.git')) && fs.statSync(path.join(dir, '.git')).isFile();
  return {
    name: path.basename(dir),
    path: dir,
    branch: branch || '(detached)',
    dirty: status ? status.split('\n').filter(Boolean).length : 0,
    lastCommit: subject ? { subject, at: committedAt, sha } : null,
    ahead: ahead || 0,
    behind: behind || 0,
    remote: slug ? `https://github.com/${slug}` : null,
    slug,
    worktree,
    handoff: handoffHeadline(dir),
    prs: withPRs ? await openPRs(slug) : [],
  };
}

export async function scanProjects(cfg) {
  const repos = findRepos(cfg.roots, cfg.maxDepth);
  const seenSlugs = new Set();
  const out = [];
  for (const dir of repos) {
    const info = await describeRepo(dir, { withPRs: false });
    out.push(info);
  }
  // Fetch PRs once per GitHub repo, share across worktrees of the same remote.
  const prBySlug = new Map();
  for (const p of out) {
    if (p.slug && !seenSlugs.has(p.slug)) {
      seenSlugs.add(p.slug);
      prBySlug.set(p.slug, await openPRs(p.slug));
    }
  }
  for (const p of out) {
    const all = p.slug ? prBySlug.get(p.slug) || [] : [];
    p.prs = all.filter((pr) => pr.headRefName === p.branch);
    p.repoOpenPRs = all.length;
  }
  out.sort((a, b) => new Date(b.lastCommit?.at || 0) - new Date(a.lastCommit?.at || 0));
  return out;
}
