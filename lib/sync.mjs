/**
 * Sync between machines.
 *
 * Transport: one JSON document in a PRIVATE GitHub repo, read and written through
 * the `gh` CLI so this code never handles a token. The Contents API gives every
 * write a compare-and-swap: a PUT carries the blob sha it was based on, and GitHub
 * rejects it if the file moved underneath us. That turns "both machines saved" from
 * silent data loss into a retry.
 *
 * Merge: per record, not per file. A task carries updatedAt (and deletedAt as a
 * tombstone) so the newest edit of THAT task wins; checked-off deadlines carry a
 * timestamp each; spaces and semester dates are single values that move as a unit.
 * Nothing here is last-writer-wins over the whole document, which is what makes
 * editing on both machines safe.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DOC_PATH = 'season.json';
const DOC_VERSION = 1;
const TOMBSTONE_DAYS = 45;

export class SyncError extends Error {
  constructor(message, { fatal = false, hint = '' } = {}) {
    super(message);
    this.fatal = fatal; // fatal = setup is wrong; retrying will not help
    this.hint = hint;
  }
}

function run(cmd, args, { input, timeout = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { timeout, maxBuffer: 8 << 20 }, (err, stdout, stderr) => {
      if (err) {
        const e = new Error((stderr || stdout || err.message).trim());
        e.code = err.code;
        e.stderr = stderr || '';
        return reject(e);
      }
      resolve(stdout);
    });
    if (input !== undefined) {
      child.stdin.end(input);
    }
  });
}

/** `gh api` with a JSON body on stdin, so payload size never hits an argv limit. */
async function ghApi(endpoint, { method = 'GET', body = null } = {}) {
  const args = ['api', endpoint, '-H', 'Accept: application/vnd.github+json'];
  if (method !== 'GET') args.push('-X', method);
  if (body) args.push('--input', '-');
  try {
    const out = await run('gh', args, { input: body ? JSON.stringify(body) : undefined });
    return out.trim() ? JSON.parse(out) : {};
  } catch (err) {
    const msg = err.message || '';
    if (/executable file not found|ENOENT|not recognized as an internal/i.test(msg)) {
      throw new SyncError('GitHub CLI (gh) is not installed.', { fatal: true, hint: 'Install it from https://cli.github.com, then run: gh auth login' });
    }
    if (/gh auth login|authentication|Bad credentials|HTTP 401/i.test(msg)) {
      throw new SyncError('GitHub CLI is not signed in.', { fatal: true, hint: 'Run: gh auth login' });
    }
    const status = (msg.match(/HTTP (\d{3})/) || [])[1];
    const e = new SyncError(`GitHub said ${status || 'no'}: ${msg.split('\n')[0]}`.slice(0, 300));
    e.status = status ? Number(status) : null;
    throw e;
  }
}

/* ------------------------------------------------------------------ */
/* Identity                                                            */
/* ------------------------------------------------------------------ */

/** A stable id for this machine, so the doc can say who last touched it. */
export function deviceInfo(dataDir) {
  const file = path.join(dataDir, 'device.json');
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (d.id) return d;
  } catch {}
  const d = {
    id: (globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)).slice(0, 8),
    name: `${os.hostname().replace(/\.local$/, '')} (${{ darwin: 'Mac', win32: 'Windows', linux: 'Linux' }[process.platform] || process.platform})`,
  };
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(d, null, 2));
  return d;
}

/* ------------------------------------------------------------------ */
/* Remote document                                                     */
/* ------------------------------------------------------------------ */

export function emptyDoc() {
  return { v: DOC_VERSION, tasks: [], doneMarks: {}, spaces: null, semester: null, devices: {} };
}

/** Read the remote doc. Returns { doc, sha } — sha null when the file does not exist yet. */
export async function fetchRemote(repo) {
  let res;
  try {
    res = await ghApi(`repos/${repo}/contents/${DOC_PATH}`);
  } catch (err) {
    if (err.status === 404) {
      // Either the file is missing (fine, first sync) or the repo is (setup problem).
      try {
        await ghApi(`repos/${repo}`);
        return { doc: emptyDoc(), sha: null };
      } catch {
        throw new SyncError(`The sync repository ${repo} does not exist or you cannot reach it.`, { fatal: true, hint: 'Run: npm run sync:setup' });
      }
    }
    throw err;
  }
  let doc;
  try {
    doc = JSON.parse(Buffer.from(String(res.content || '').replace(/\s/g, ''), 'base64').toString('utf8'));
  } catch {
    throw new SyncError('The synced file is not readable JSON. Delete it in the sync repo to start over.', { fatal: true });
  }
  return { doc: { ...emptyDoc(), ...doc }, sha: res.sha };
}

/** Write the doc back, only if the remote still matches `sha`. Returns the new sha. */
export async function putRemote(repo, doc, sha, message) {
  const body = {
    message,
    content: Buffer.from(JSON.stringify(doc, null, 2)).toString('base64'),
  };
  if (sha) body.sha = sha;
  const res = await ghApi(`repos/${repo}/contents/${DOC_PATH}`, { method: 'PUT', body });
  return res.content?.sha || null;
}

/* ------------------------------------------------------------------ */
/* Merge                                                               */
/* ------------------------------------------------------------------ */

const newer = (a, b) => (String(a || '') > String(b || '') ? a : b);
const stampOf = (t) => newer(t?.deletedAt, t?.updatedAt) || t?.createdAt || '';

/**
 * Order two records that carry the same timestamp. Clocks on two machines can
 * land on the same millisecond; without a rule that both sides compute the same
 * way, each would keep its own copy and the two would never agree. Comparing the
 * serialized record is arbitrary but identical everywhere, which is what matters.
 */
const tieBreak = (a, b) => (JSON.stringify(a) > JSON.stringify(b) ? a : b);

/** Merge two task lists by id, keeping whichever edit of each task is newer. */
export function mergeTasks(mine, theirs) {
  const byId = new Map();
  for (const t of [...(mine || []), ...(theirs || [])]) {
    if (!t?.id) continue;
    const have = byId.get(t.id);
    if (!have) byId.set(t.id, t);
    else if (stampOf(t) > stampOf(have)) byId.set(t.id, t);
    else if (stampOf(t) === stampOf(have)) byId.set(t.id, tieBreak(t, have));
  }
  const cutoff = new Date(Date.now() - TOMBSTONE_DAYS * 86400000).toISOString();
  return [...byId.values()]
    .filter((t) => !(t.deletedAt && t.deletedAt < cutoff)) // forget old deletions
    .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')) || String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
}

/** Merge checked-off deadlines. Each id carries its own timestamp, so the newest click wins. */
export function mergeDoneMarks(mine, theirs) {
  const out = { ...(theirs || {}) };
  for (const [id, mark] of Object.entries(mine || {})) {
    const have = out[id];
    const mineAt = String(mark?.at || '');
    const theirsAt = String(have?.at || '');
    if (!have || mineAt > theirsAt) out[id] = mark;
    else if (mineAt === theirsAt) out[id] = tieBreak(mark, have);
  }
  const cutoff = new Date(Date.now() - TOMBSTONE_DAYS * 86400000).toISOString();
  for (const [id, mark] of Object.entries(out)) {
    if (mark?.done === false && String(mark.at || '') < cutoff) delete out[id]; // an old un-check is just the default
  }
  return out;
}

/** Single values (spaces, semester) move as a unit: the newer stamp wins. */
export function mergeStamped(mine, theirs) {
  if (!mine) return theirs || null;
  if (!theirs) return mine;
  const a = String(mine.updatedAt || '');
  const b = String(theirs.updatedAt || '');
  if (b > a) return theirs;
  if (a > b) return mine;
  return tieBreak(mine, theirs);
}

export function mergeDocs(mine, theirs) {
  return {
    v: DOC_VERSION,
    tasks: mergeTasks(mine.tasks, theirs.tasks),
    doneMarks: mergeDoneMarks(mine.doneMarks, theirs.doneMarks),
    spaces: mergeStamped(mine.spaces, theirs.spaces),
    semester: mergeStamped(mine.semester, theirs.semester),
    devices: { ...(theirs.devices || {}), ...(mine.devices || {}) },
  };
}

/* ------------------------------------------------------------------ */
/* Local state <-> sync document                                       */
/* ------------------------------------------------------------------ */

/** Pinned tabs travel between machines; which tab is open and where it scrolled does not. */
function shareableFolders(folders) {
  return (folders || []).map((f) => ({
    id: f.id, name: f.name, fixed: !!f.fixed, open: !!f.open, courses: !!f.courses,
    tabs: (f.tabs || []).map((t) => ({ id: t.id, title: t.title, url: t.url, favicon: t.favicon || null })),
  }));
}

/** Build the syncable view of what this machine holds. */
export function docFromState(state, { semester } = {}) {
  return {
    v: DOC_VERSION,
    tasks: state.tasks || [],
    doneMarks: state.doneMarks || {},
    spaces: state.shell?.folders ? { updatedAt: state.shellUpdatedAt || '1970-01-01T00:00:00.000Z', version: state.shell.version || 0, folders: shareableFolders(state.shell.folders) } : null,
    semester: semester ? { updatedAt: state.semesterUpdatedAt || '1970-01-01T00:00:00.000Z', value: semester } : null,
    devices: {},
  };
}

/**
 * Fold a merged document back into local state.
 * Local session details (which tabs are loose, which one is active) are preserved.
 */
export function stateFromDoc(state, doc) {
  const next = { ...state, tasks: doc.tasks || [], doneMarks: doc.doneMarks || {} };
  if (doc.spaces?.folders?.length) {
    const localById = new Map((state.shell?.folders || []).flatMap((f) => (f.tabs || []).map((t) => [t.id, t])));
    next.shell = {
      ...(state.shell || { today: [], activeId: null }),
      version: doc.spaces.version ?? state.shell?.version ?? 0,
      folders: doc.spaces.folders.map((f) => ({
        ...f,
        // Keep this machine's last-visited address for a tab it already knows.
        tabs: (f.tabs || []).map((t) => ({ ...t, lastUrl: localById.get(t.id)?.lastUrl || null })),
      })),
    };
    next.shellUpdatedAt = doc.spaces.updatedAt;
  }
  if (doc.semester?.value) next.semesterUpdatedAt = doc.semester.updatedAt;
  return next;
}

/* ------------------------------------------------------------------ */
/* The sync itself                                                     */
/* ------------------------------------------------------------------ */

/**
 * One full exchange: read remote, merge with local, write back if anything changed.
 * Retries once on a compare-and-swap rejection, which means the other machine
 * wrote while we were merging — the right response is to merge again, not to force.
 */
export async function syncOnce({ repo, store, device, semester, onMerged }) {
  if (!repo) throw new SyncError('No sync repository configured.', { fatal: true, hint: 'Run: npm run sync:setup' });

  for (let attempt = 0; attempt < 3; attempt++) {
    const { doc: remote, sha } = await fetchRemote(repo);
    const local = store.read();
    const mine = docFromState(local, { semester });
    const merged = mergeDocs(mine, remote);
    merged.devices = { ...(remote.devices || {}), [device.id]: { name: device.name, lastSeen: new Date().toISOString() } };

    // Local first: whatever we learned is saved here even if the upload fails.
    const nextState = stateFromDoc(local, merged);
    store.write(nextState);
    onMerged?.(merged, nextState);

    const sameTasks = JSON.stringify(merged.tasks) === JSON.stringify(remote.tasks || []);
    const sameDone = JSON.stringify(merged.doneMarks) === JSON.stringify(remote.doneMarks || {});
    const sameSpaces = JSON.stringify(merged.spaces) === JSON.stringify(remote.spaces || null);
    const sameSemester = JSON.stringify(merged.semester) === JSON.stringify(remote.semester || null);
    if (sha && sameTasks && sameDone && sameSpaces && sameSemester) {
      return { pushed: false, doc: merged, devices: merged.devices };
    }

    try {
      await putRemote(repo, merged, sha, `Sync from ${device.name}`);
      return { pushed: true, doc: merged, devices: merged.devices };
    } catch (err) {
      // 409/422 = the other machine wrote first. Merge again against what it wrote.
      if (err.status === 409 || err.status === 422) continue;
      throw err;
    }
  }
  throw new SyncError('The other machine kept writing while this one merged. Try again in a moment.');
}

/* ------------------------------------------------------------------ */
/* Setup                                                               */
/* ------------------------------------------------------------------ */

export async function currentUser() {
  const me = await ghApi('user');
  return me.login;
}

/** Create the private repo if it is not there yet. Safe to run on the second machine. */
export async function ensureRepo(repo) {
  try {
    const info = await ghApi(`repos/${repo}`);
    if (!info.private) {
      throw new SyncError(`${repo} is a PUBLIC repository. Sync would publish your tasks.`, { fatal: true, hint: 'Make it private on GitHub, or pick another name.' });
    }
    return { created: false, repo };
  } catch (err) {
    // A 404 here is the normal first-run case: the repo is not there yet, so make it.
    if (err.status !== 404) throw err;
  }
  const [owner, name] = repo.split('/');
  const me = await currentUser();
  await ghApi('user/repos', {
    method: 'POST',
    body: { name, private: true, description: 'Season sync: tasks, checked-off deadlines and spaces. Private.', auto_init: false },
  });
  if (owner !== me) throw new SyncError(`Created ${me}/${name}, but the config asks for ${repo}.`, { fatal: true });
  return { created: true, repo };
}
