import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_STATE = {
  tasks: [],
  pins: [],
  focus: { sessions: [] },
  hiddenCourses: [],
  doneItems: [],
  shell: null,
  version: 1,
};

/** Tiny JSON-file store for everything the board remembers between launches. */
export class Store {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'state.json');
    fs.mkdirSync(dir, { recursive: true });
  }

  read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return { ...DEFAULT_STATE, ...parsed };
    } catch {
      return { ...DEFAULT_STATE };
    }
  }

  write(state) {
    const next = { ...DEFAULT_STATE, ...state, version: 1 };
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
    fs.renameSync(tmp, this.file);
    return next;
  }

  /** Apply a validated patch. Only known keys are accepted. */
  patch(partial) {
    const cur = this.read();
    const next = { ...cur };
    if (Array.isArray(partial.tasks)) next.tasks = partial.tasks.filter(validTask).slice(0, 500);
    if (Array.isArray(partial.pins)) next.pins = partial.pins.filter(validPin).slice(0, 100);
    if (partial.focus && Array.isArray(partial.focus.sessions)) {
      next.focus = { sessions: partial.focus.sessions.filter(validSession).slice(-500) };
    }
    if (Array.isArray(partial.hiddenCourses)) {
      next.hiddenCourses = partial.hiddenCourses.filter((x) => typeof x === 'number' || typeof x === 'string').slice(0, 50);
    }
    if (partial.shell && typeof partial.shell === 'object') next.shell = validShell(partial.shell);
    if (Array.isArray(partial.doneItems)) next.doneItems = partial.doneItems.filter((x) => typeof x === 'string').slice(0, 1000);
    return this.write(next);
  }
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
