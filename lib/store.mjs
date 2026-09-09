import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_STATE = {
  tasks: [],            // includes tombstones (deletedAt) so a delete can travel between machines
  pins: [],
  focus: { sessions: [] },
  hiddenCourses: [],
  doneMarks: {},        // { canvasItemId: { done, at } } — the merge ledger behind doneItems
  shell: null,
  shellUpdatedAt: null,
  semester: null,       // last semester block seen, so a change to it can be detected and synced
  semesterUpdatedAt: null,
  version: 1,
};

/**
 * Timestamps that never repeat. Two edits in the same millisecond would otherwise
 * be indistinguishable, and "newest wins" needs an order to work with.
 */
let lastStamp = '';
function now() {
  let t = new Date().toISOString();
  if (t <= lastStamp) t = new Date(new Date(lastStamp).getTime() + 1).toISOString();
  lastStamp = t;
  return t;
}

/** Tiny JSON-file store for everything the board remembers between launches. */
export class Store {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'state.json');
    fs.mkdirSync(dir, { recursive: true });
  }

  /** Raw state, tombstones and all. Used internally and by sync. */
  read() {
    let parsed = {};
    try {
      parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return { ...DEFAULT_STATE };
    }
    const state = { ...DEFAULT_STATE, ...parsed };
    // Files written before sync existed carry a plain doneItems array; adopt it once.
    if (!parsed.doneMarks && Array.isArray(parsed.doneItems)) {
      state.doneMarks = Object.fromEntries(parsed.doneItems.map((id) => [id, { done: true, at: '1970-01-01T00:00:00.000Z' }]));
    }
    delete state.doneItems;
    return state;
  }

  /** What a client sees: live tasks only, and checked-off deadlines as a plain list. */
  view() {
    const state = this.read();
    return {
      ...state,
      tasks: (state.tasks || []).filter((t) => !t.deletedAt),
      doneItems: Object.entries(state.doneMarks || {}).filter(([, m]) => m?.done).map(([id]) => id),
    };
  }

  write(state) {
    const next = { ...DEFAULT_STATE, ...state, version: 1 };
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
    fs.renameSync(tmp, this.file);
    return next;
  }

  /**
   * Apply a validated patch from a client. Only known keys are accepted.
   * Every accepted change is timestamped here, which is what lets two machines
   * merge later without either one's edits being silently dropped.
   */
  patch(partial) {
    const cur = this.read();
    const next = { ...cur };
    const at = now();

    if (Array.isArray(partial.tasks)) {
      const incoming = partial.tasks.filter(validTask).slice(0, 500);
      const known = new Map((cur.tasks || []).map((t) => [t.id, t]));
      const seen = new Set();
      const out = [];
      for (const t of incoming) {
        seen.add(t.id);
        const had = known.get(t.id);
        const changed = !had || had.deletedAt || had.title !== t.title || had.date !== t.date || !!had.done !== !!t.done;
        out.push({
          id: t.id,
          title: t.title,
          date: t.date ?? null,
          done: !!t.done,
          createdAt: had?.createdAt || t.createdAt || at,
          updatedAt: changed ? at : had.updatedAt || at,
        });
      }
      // A task the client stopped sending was deleted: keep a tombstone so the delete syncs.
      for (const [id, had] of known) {
        if (seen.has(id)) continue;
        out.push(had.deletedAt ? had : { ...had, deletedAt: at });
      }
      next.tasks = out.slice(0, 1000);
    }

    if (Array.isArray(partial.doneItems)) {
      const wanted = new Set(partial.doneItems.filter((x) => typeof x === 'string').slice(0, 1000));
      const marks = { ...(cur.doneMarks || {}) };
      for (const id of wanted) if (!marks[id]?.done) marks[id] = { done: true, at };
      for (const [id, m] of Object.entries(marks)) if (m?.done && !wanted.has(id)) marks[id] = { done: false, at };
      next.doneMarks = marks;
    }

    if (Array.isArray(partial.pins)) next.pins = partial.pins.filter(validPin).slice(0, 100);
    if (partial.focus && Array.isArray(partial.focus.sessions)) {
      next.focus = { sessions: partial.focus.sessions.filter(validSession).slice(-500) };
    }
    if (Array.isArray(partial.hiddenCourses)) {
      next.hiddenCourses = partial.hiddenCourses.filter((x) => typeof x === 'number' || typeof x === 'string').slice(0, 50);
    }
    if (partial.shell && typeof partial.shell === 'object') {
      next.shell = validShell(partial.shell);
      // Only a change to the SHARED part (spaces and their pinned tabs) counts as an edit.
      // Which tab is open, and where it navigated, is this machine's business.
      if (shareableJson(next.shell) !== shareableJson(cur.shell)) next.shellUpdatedAt = at;
    }

    this.write(next);
    return this.view();
  }

  /** Note a semester block from config so a change to it can be synced. */
  noteSemester(semester) {
    const cur = this.read();
    if (JSON.stringify(cur.semester) === JSON.stringify(semester)) return cur;
    return this.write({ ...cur, semester, semesterUpdatedAt: cur.semester ? now() : cur.semesterUpdatedAt || '1970-01-01T00:00:00.000Z' });
  }
}

/** The part of the sidebar that is the same on every machine. */
function shareableJson(shell) {
  return JSON.stringify((shell?.folders || []).map((f) => ({ id: f.id, name: f.name, fixed: f.fixed, courses: f.courses, tabs: (f.tabs || []).map((t) => ({ id: t.id, title: t.title, url: t.url })) })));
}

function validTask(t) {
  return (
    t &&
    typeof t.id === 'string' &&
    typeof t.title === 'string' &&
    t.title.length > 0 &&
    t.title.length <= 300 &&
    (t.date === null || t.date === undefined || /^\d{4}-\d{2}-\d{2}$/.test(t.date)) &&
    typeof t.done === 'boolean'
  );
}

function validPin(p) {
  return p && typeof p.label === 'string' && p.label.length <= 120 && (typeof p.url === 'string' || typeof p.path === 'string');
}

function validSession(s) {
  return s && typeof s.startedAt === 'string' && typeof s.minutes === 'number' && s.minutes > 0 && s.minutes <= 240;
}

const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
function validShellTab(t) {
  if (!t || typeof t !== 'object' || typeof t.id !== 'string') return null;
  return { id: t.id.slice(0, 64), title: str(t.title, 200), url: str(t.url, 2000), favicon: str(t.favicon, 2000) || null, lastUrl: str(t.lastUrl, 2000) || null };
}
function validShell(sh) {
  const folders = (Array.isArray(sh.folders) ? sh.folders : []).slice(0, 30).map((f) => ({
    id: str(f?.id, 64) || 'f',
    name: str(f?.name, 60),
    fixed: !!f?.fixed,
    open: f?.open !== false,
    courses: !!f?.courses,
    tabs: (Array.isArray(f?.tabs) ? f.tabs : []).map(validShellTab).filter(Boolean).slice(0, 100),
  }));
  const today = (Array.isArray(sh.today) ? sh.today : []).map(validShellTab).filter(Boolean).slice(0, 200);
  return { folders, today, activeId: str(sh.activeId, 64) || null, version: Number(sh.version) || 0 };
}
