/* Season — board logic. Vanilla ES module, no build step. */

const $ = (sel, root = document) => root.querySelector(sel);
const DAY = 86400000;
const COURSE_COLORS = ['var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)', 'var(--c5)', 'var(--c6)'];

const S = {
  config: null,
  canvas: null,
  projects: null,
  files: null,
  local: { tasks: [], pins: [], focus: { sessions: [] }, doneItems: [] },
  weekStart: mondayOf(new Date()),
  courseColor: new Map(),
  lastLoad: null,
};

/* ------------------------------------------------------------------ */
/* Utilities                                                           */
/* ------------------------------------------------------------------ */

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function pad(n) {
  return String(n).padStart(2, '0');
}
function dateKey(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function fromKey(k) {
  const [y, m, d] = k.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function mondayOf(d) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dow = (x.getDay() + 6) % 7; // Mon=0
  x.setDate(x.getDate() - dow);
  return x;
}
function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
const fmtTime = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const fmtDayShort = new Intl.DateTimeFormat(undefined, { weekday: 'short' });
const fmtMonthDay = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const fmtLong = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' });

function relTime(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const abs = Math.abs(diff);
  const s = diff < 0 ? 'in ' : '';
  const e = diff < 0 ? '' : ' ago';
  if (abs < 60000) return 'just now';
  if (abs < 3600000) return `${s}${Math.round(abs / 60000)}m${e}`;
  if (abs < DAY) return `${s}${Math.round(abs / 3600000)}h${e}`;
  if (abs < 14 * DAY) return `${s}${Math.round(abs / DAY)}d${e}`;
  return fmtMonthDay.format(new Date(iso));
}
function homeRel(p) {
  const home = S.config?.home;
  return home && p.startsWith(home) ? '~' + p.slice(home.length) : p;
}
function courseById(id) {
  return S.canvas?.courses.find((c) => c.id === id);
}
/** "INFO SYS 316-001C" → "INFO SYS 316"; "MHR 351-001C & 002C" → "MHR 351". Section suffixes are noise on a chip. */
function shortCode(code) {
  return String(code || '').replace(/\s*[-–]\s*\d{2,3}[A-Z]?(\s*&\s*\d{2,3}[A-Z]?)?\s*$/, '').trim();
}
function colorFor(courseId) {
  return S.courseColor.get(courseId) || 'var(--ink-3)';
}
function isDone(item) {
  return item.complete || S.local.doneItems.includes(item.id);
}
function isLate(item, now = new Date()) {
  return !isDone(item) && new Date(item.dueAt) < now && item.type !== 'calendar_event';
}

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2600);
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `${res.status}`);
  return body;
}

let saveTimer;
function saveLocal() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      S.local = await api('/api/state', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(S.local) });
    } catch (e) {
      toast(`Could not save: ${e.message}`);
    }
  }, 250);
}

async function openPath(path, app = 'default') {
  try {
    await api('/api/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path, app }) });
  } catch (e) {
    toast(`Could not open: ${e.message}`);
  }
}

/* ------------------------------------------------------------------ */
/* Loading                                                             */
/* ------------------------------------------------------------------ */

async function loadAll({ refresh = false } = {}) {
  const q = refresh ? '?refresh=1' : '';
  $('#updated').textContent = 'updating…';
  const jobs = [
    api('/api/config').then((c) => {
      S.config = c;
      renderHeader();
      renderPins();
    }),
    api('/api/state').then((st) => {
      S.local = st;
      renderPins();
    }),
    api('/api/canvas' + q).then((cv) => {
      S.canvas = cv;
      const ordered = [...cv.courses].sort((a, b) => (b.current ? 1 : 0) - (a.current ? 1 : 0));
      S.courseColor = new Map(ordered.map((c, i) => [c.id, COURSE_COLORS[i % COURSE_COLORS.length]]));
      renderBanner();
      renderStrip();
      renderWeek();
      renderDeck();
      renderCourses();
      renderAnnouncements();
      renderHeader();
    }),
    api('/api/projects' + q).then((p) => {
      S.projects = p;
      renderProjects();
    }),
    api('/api/files').then((f) => {
      S.files = f;
      renderFiles();
    }),
  ];
  const results = await Promise.allSettled(jobs);
  const failed = results.filter((r) => r.status === 'rejected');
  if (failed.length) {
    console.error(failed);
    toast(`Some panels did not load: ${failed.map((f) => f.reason.message).join(', ')}`);
  }
  S.lastLoad = new Date();
  renderUpdated();
}

function renderUpdated() {
  const at = S.canvas?.fetchedAt ? new Date(S.canvas.fetchedAt) : S.lastLoad;
  $('#updated').textContent = at ? `updated ${relTime(at.toISOString())}` : 'updated';
}

/* ------------------------------------------------------------------ */
/* Header + banner                                                     */
/* ------------------------------------------------------------------ */

function semesterInfo(now = new Date()) {
  const sem = S.config?.semester;
  if (!sem) return null;
  const start = fromKey(sem.start);
  const end = fromKey(sem.end);
  const totalWeeks = Math.max(1, Math.ceil((end - start) / (7 * DAY)));
  const week = Math.floor((startOfDay(now) - start) / (7 * DAY)) + 1;
  const daysLeft = Math.ceil((end - startOfDay(now)) / DAY);
  return { start, end, totalWeeks, week, daysLeft, name: sem.name };
}

function renderHeader() {
  const now = new Date();
  const info = semesterInfo(now);
  $('#term').textContent = info?.name || '';
  const parts = [`<strong>${esc(fmtLong.format(now))}</strong>`];
  if (info) {
    if (info.week < 1) parts.push(`season starts in ${Math.ceil((info.start - now) / DAY)} days`);
    else if (info.week > info.totalWeeks) parts.push('season over');
    else parts.push(`Week ${info.week} of ${info.totalWeeks}`, `${info.daysLeft} days left`);
  }
  const todayItems = (S.canvas?.items || []).filter((i) => dateKey(new Date(i.dueAt)) === dateKey(now) && !isDone(i));
  if (todayItems.length) {
    const next = todayItems.sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt))[0];
    parts.push(`next: ${esc(next.title)} at ${esc(fmtTime.format(new Date(next.dueAt)))}`);
  }
  $('#today').innerHTML = parts.join(' <span aria-hidden="true">·</span> ');
}

function renderBanner() {
  const b = $('#banner');
  const cv = S.canvas;
  const env = S.config?.canvas?.envFile ? homeRel(S.config.canvas.envFile) : '~/tools/canvas-mcp/.env';
  b.className = 'banner';
  if (cv?.mock) {
    b.hidden = false;
    b.innerHTML = `Showing <strong>sample Canvas data</strong>. Paste your token and school URL into <code>${esc(env)}</code> (<code>CANVAS_API_TOKEN</code>, <code>CANVAS_API_URL</code>) and restart Season. Projects and files below are real.`;
  } else if (cv?.error) {
    b.hidden = false;
    b.classList.add('error');
    b.innerHTML = `${esc(cv.error)}${cv.stale ? ` Showing what was cached ${esc(relTime(cv.fetchedAt))}.` : ''}`;
  } else {
    b.hidden = true;
  }
}

/* ------------------------------------------------------------------ */
/* Season strip (signature)                                            */
/* ------------------------------------------------------------------ */

function renderStrip() {
  const svg = $('#season-strip');
  const info = semesterInfo();
  if (!info) return;
  const W = Math.max(720, svg.clientWidth || 900);
  const H = 96;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const left = 8;
  const right = W - 8;
  const span = right - left;
  const total = info.end - info.start + DAY;
  const x = (d) => left + ((startOfDay(d) - info.start) / total) * span;
  const wx = (n) => left + ((n * 7 * DAY) / total) * span; // start x of week n (0-based)
  const now = new Date();
  const todayX = x(now);
  const bandTop = 18;
  const baseY = 72;
  const items = S.canvas?.items || [];
  const selectedWeek = Math.floor((S.weekStart - info.start) / (7 * DAY));

  let out = '';
  // Month labels
  let m = new Date(info.start.getFullYear(), info.start.getMonth(), 1);
  while (m <= info.end) {
    const mx = Math.max(left, x(m));
    if (m >= info.start) out += `<line class="tick" x1="${mx}" y1="${bandTop - 6}" x2="${mx}" y2="${bandTop}"/>`;
    out += `<text class="month" x="${mx + 4}" y="10">${esc(m.toLocaleString(undefined, { month: 'short' }))}</text>`;
    m = new Date(m.getFullYear(), m.getMonth() + 1, 1);
  }
  // Breaks (optional config)
  for (const br of S.config?.semester?.breaks || []) {
    const bx1 = x(fromKey(br.start));
    const bx2 = x(addDays(fromKey(br.end), 1));
    out += `<rect class="break-band" x="${bx1}" y="${bandTop}" width="${bx2 - bx1}" height="${baseY - bandTop}"/>`;
    out += `<text class="break-label" x="${(bx1 + bx2) / 2}" y="${bandTop + 10}" text-anchor="middle">${esc(br.label)}</text>`;
  }
  // Week bands + numbers
  for (let n = 0; n < info.totalWeeks; n++) {
    const x1 = wx(n);
    const x2 = Math.min(right, wx(n + 1));
    const cls = ['week-band', n + 1 === info.week ? 'current' : '', n === selectedWeek ? 'selected' : ''].join(' ');
    out += `<rect class="${cls}" data-week="${n}" x="${x1}" y="${bandTop}" width="${x2 - x1}" height="${baseY - bandTop}" rx="3"><title>Week ${n + 1}: plan this week</title></rect>`;
    out += `<line class="tick" x1="${x1}" y1="${baseY}" x2="${x1}" y2="${baseY + 5}"/>`;
    out += `<text class="week-num ${n + 1 === info.week ? 'current' : ''}" x="${(x1 + x2) / 2}" y="${baseY + 17}" text-anchor="middle">${n + 1}</text>`;
  }
  out += `<line class="baseline" x1="${left}" y1="${baseY}" x2="${right}" y2="${baseY}"/>`;
  // Pips, stacked per day
  const byDay = new Map();
  for (const it of items) {
    const d = new Date(it.dueAt);
    if (d < info.start || d > addDays(info.end, 1)) continue;
    const k = dateKey(d);
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(it);
  }
  for (const [k, list] of byDay) {
    const px = x(fromKey(k));
    list.sort((a, b) => (isLate(a) ? -1 : 1) - (isLate(b) ? -1 : 1));
    list.slice(0, 5).forEach((it, i) => {
      const cls = it.type === 'calendar_event' ? 'event' : isDone(it) ? 'done' : isLate(it, now) ? 'late' : 'due';
      out += `<circle class="pip ${cls}" data-id="${esc(it.id)}" cx="${px}" cy="${baseY - 6 - i * 9}" r="3.6"><title>${esc(it.title)} · ${esc(shortCode(courseById(it.courseId)?.code) || it.contextName || '')} · ${esc(fmtMonthDay.format(fromKey(k)))}</title></circle>`;
    });
    if (list.length > 5) out += `<text class="week-num" x="${px + 6}" y="${baseY - 6 - 4 * 9 + 3}">+${list.length - 5}</text>`;
  }
  // Today
  if (now >= info.start && now <= addDays(info.end, 1)) {
    out += `<line class="today-line" x1="${todayX}" y1="${bandTop - 4}" x2="${todayX}" y2="${baseY + 4}"/>`;
    const flagAnchor = todayX > right - 60 ? 'end' : 'start';
    out += `<text class="today-flag" x="${todayX + (flagAnchor === 'end' ? -5 : 5)}" y="${bandTop + 11}" text-anchor="${flagAnchor}">Today</text>`;
  }
  svg.innerHTML = out;
  svg.querySelectorAll('.week-band').forEach((band) => {
    band.addEventListener('click', () => {
      S.weekStart = addDays(info.start, Number(band.dataset.week) * 7);
      renderWeek();
      renderStrip();
      $('#week').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
  svg.querySelectorAll('.pip').forEach((pip) => {
    pip.addEventListener('click', () => {
      const it = items.find((i) => i.id === pip.dataset.id);
      if (it?.url) window.open(it.url, '_blank', 'noopener');
    });
  });
}

/* ------------------------------------------------------------------ */
/* Week / game plan                                                    */
/* ------------------------------------------------------------------ */

function renderWeek() {
  const grid = $('#week-grid');
  const now = new Date();
  const todayKey = dateKey(now);
  const info = semesterInfo();
  const weekNo = info ? Math.floor((S.weekStart - info.start) / (7 * DAY)) + 1 : null;
  const title = $('#week-title');
  const sameWeek = dateKey(S.weekStart) === dateKey(mondayOf(now));
  title.textContent = sameWeek ? 'Game plan · this week' : `Game plan · ${weekNo ? `week ${weekNo}` : fmtMonthDay.format(S.weekStart)}`;
  const items = S.canvas?.items || [];

  let html = '';
  for (let i = 0; i < 7; i++) {
    const d = addDays(S.weekStart, i);
    const k = dateKey(d);
    const dayItems = items.filter((it) => dateKey(new Date(it.dueAt)) === k).sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt));
    const tasks = S.local.tasks.filter((t) => t.date === k);
    const cls = ['day', k === todayKey ? 'today' : '', d < startOfDay(now) && k !== todayKey ? 'past' : ''].join(' ');
    html += `<div class="${cls}" data-date="${k}">
      <div class="day-head"><span class="day-name">${esc(fmtDayShort.format(d))}</span><span class="day-date">${esc(fmtMonthDay.format(d))}</span></div>
      <div class="day-items">
        ${dayItems
          .map((it) => {
            const c = courseById(it.courseId);
            const cls = ['chip', isDone(it) ? 'done' : '', isLate(it, now) ? 'late' : ''].join(' ');
            const when = it.type === 'calendar_event' ? fmtTime.format(new Date(it.dueAt)) : `due ${fmtTime.format(new Date(it.dueAt))}`;
            return `<a class="${cls}" style="--cc:${colorFor(it.courseId)}" href="${esc(it.url || '#')}" target="_blank" rel="noopener" title="${esc(it.title)}">${esc(it.title)}<span class="chip-meta"><span>${esc(shortCode(c?.code) || it.contextName || '')}</span><span>${esc(when)}${it.points != null ? ` · ${it.points}pt` : ''}</span></span></a>`;
          })
          .join('')}
        ${tasks
          .map(
            (t) => `<div class="task ${t.done ? 'done' : ''}" draggable="true" data-id="${esc(t.id)}">
              <input type="checkbox" ${t.done ? 'checked' : ''} aria-label="Done: ${esc(t.title)}">
              <span class="task-title">${esc(t.title)}</span>
              <button type="button" class="task-x" aria-label="Remove task">×</button>
            </div>`
          )
          .join('')}
      </div>
      <form class="add-task"><input name="title" placeholder="+ add" aria-label="Add a task for ${esc(fmtMonthDay.format(d))}" maxlength="300" autocomplete="off"></form>
    </div>`;
  }
  grid.innerHTML = html;

  // Wire up tasks
  grid.querySelectorAll('.add-task').forEach((form) => {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const input = form.querySelector('input');
      const title = input.value.trim();
      if (!title) return;
      S.local.tasks.push({ id: crypto.randomUUID(), title, date: form.closest('.day').dataset.date, done: false, createdAt: new Date().toISOString() });
      saveLocal();
      renderWeek();
      grid.querySelector(`[data-date="${form.closest('.day').dataset.date}"] .add-task input`)?.focus();
    });
  });
  grid.querySelectorAll('.task').forEach((el) => {
    const id = el.dataset.id;
    el.querySelector('input').addEventListener('change', (e) => {
      const t = S.local.tasks.find((x) => x.id === id);
      if (t) t.done = e.target.checked;
      saveLocal();
      renderWeek();
    });
    el.querySelector('.task-x').addEventListener('click', () => {
      S.local.tasks = S.local.tasks.filter((x) => x.id !== id);
      saveLocal();
      renderWeek();
    });
    el.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', id);
      e.dataTransfer.effectAllowed = 'move';
      el.classList.add('dragging');
    });
    el.addEventListener('dragend', () => el.classList.remove('dragging'));
  });
  grid.querySelectorAll('.day').forEach((day) => {
    day.addEventListener('dragover', (e) => {
      e.preventDefault();
      day.classList.add('drop');
    });
    day.addEventListener('dragleave', () => day.classList.remove('drop'));
    day.addEventListener('drop', (e) => {
      e.preventDefault();
      day.classList.remove('drop');
      const id = e.dataTransfer.getData('text/plain');
      const t = S.local.tasks.find((x) => x.id === id);
      if (t && t.date !== day.dataset.date) {
        t.date = day.dataset.date;
        saveLocal();
        renderWeek();
      }
    });
  });
}

/* ------------------------------------------------------------------ */
/* On deck                                                             */
/* ------------------------------------------------------------------ */

function renderDeck() {
  const list = $('#deck-list');
  const now = new Date();
  // Hide what Canvas itself says is finished and past. Locally checked-off items stay visible so they can be unchecked.
  const items = (S.canvas?.items || []).filter((it) => !(it.complete && new Date(it.dueAt) < now));
  if (!items.length) {
    list.innerHTML = `<div class="empty">Nothing on deck. ${S.canvas?.configured ? 'Enjoy it.' : 'Connect Canvas to see deadlines here.'}</div>`;
    $('#deck-meta').textContent = '';
    return;
  }
  const todayStart = startOfDay(now);
  const weekEnd = addDays(mondayOf(now), 7);
  const nextWeekEnd = addDays(weekEnd, 7);
  const groups = [
    { key: 'late', label: 'Overdue', test: (d, it) => d < now && it.type !== 'calendar_event' },
    { key: 'now', label: 'Today', test: (d) => dateKey(d) === dateKey(now) },
    { key: 'tmrw', label: 'Tomorrow', test: (d) => dateKey(d) === dateKey(addDays(now, 1)) },
    { key: 'week', label: 'This week', test: (d) => d < weekEnd && d >= todayStart },
    { key: 'next', label: 'Next week', test: (d) => d >= weekEnd && d < nextWeekEnd },
    { key: 'later', label: 'Later', test: () => true },
  ];
  const sorted = [...items].sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt));
  const buckets = new Map(groups.map((g) => [g.key, []]));
  for (const it of sorted) {
    const d = new Date(it.dueAt);
    const g = groups.find((g) => g.test(d, it));
    buckets.get(g.key).push(it);
  }
  let open = 0;
  let html = '';
  for (const g of groups) {
    const rows = buckets.get(g.key);
    if (!rows.length) continue;
    html += `<div class="deck-group ${g.key}">${g.label} <span class="panel-meta">${rows.length}</span></div>`;
    for (const it of rows) {
      const d = new Date(it.dueAt);
      const c = courseById(it.courseId);
      const done = isDone(it);
      if (!done) open += 1;
      const status = it.missing && !done ? '<span class="status miss">missing</span>' : it.late && it.submitted ? '<span class="status late">late</span>' : it.submitted ? '<span class="status ok">submitted</span>' : '';
      html += `<div class="deck-row ${done ? 'done' : ''} ${isLate(it, now) ? 'late' : ''}">
        <div class="when">${esc(fmtDayShort.format(d))} ${esc(fmtMonthDay.format(d).replace(/^\w+ /, ''))}<small>${esc(fmtTime.format(d))}</small></div>
        <div class="what"><a href="${esc(it.url || '#')}" target="_blank" rel="noopener">${esc(it.title)}</a>
          <div class="sub"><span class="tag" style="--cc:${colorFor(it.courseId)}">${esc(shortCode(c?.code) || it.contextName || '')}</span>${status}</div></div>
        <div style="display:flex;align-items:center;gap:8px"><span class="pts">${it.points != null ? `${it.points}pt` : ''}</span><input type="checkbox" data-id="${esc(it.id)}" ${done ? 'checked' : ''} ${it.complete ? 'disabled' : ''} aria-label="Mark done: ${esc(it.title)}"></div>
      </div>`;
    }
  }
  list.innerHTML = html;
  $('#deck-meta').textContent = `${open} open · next four weeks`;
  list.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
    cb.addEventListener('change', () => {
      const id = cb.dataset.id;
      S.local.doneItems = cb.checked ? [...new Set([...S.local.doneItems, id])] : S.local.doneItems.filter((x) => x !== id);
      saveLocal();
      renderDeck();
      renderWeek();
      renderStrip();
      renderCourses();
    });
  });
}

/* ------------------------------------------------------------------ */
/* Courses                                                             */
/* ------------------------------------------------------------------ */

let showAllCourses = false;
function currentCourses() {
  const all = S.canvas?.courses || [];
  const cur = all.filter((c) => c.current);
  return cur.length ? cur : all; // if the term match finds nothing, show everything rather than an empty board
}

function renderCourses() {
  const grid = $('#course-grid');
  const all = S.canvas?.courses || [];
  const cur = currentCourses();
  const courses = showAllCourses ? all : cur;
  if (!courses.length) {
    grid.innerHTML = `<div class="empty">No active courses. ${S.canvas?.configured ? 'Canvas returned none for this term.' : 'Connect Canvas to see them.'}</div>`;
    return;
  }
  const now = new Date();
  const items = S.canvas.items || [];
  grid.innerHTML = courses
    .map((c) => {
      const open = items.filter((it) => it.courseId === c.id && !isDone(it) && new Date(it.dueAt) >= startOfDay(now)).sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt));
      const late = items.filter((it) => it.courseId === c.id && isLate(it, now)).length;
      const next = open[0];
      const anns = (S.canvas.announcements || []).filter((a) => a.courseId === c.id && Date.now() - new Date(a.postedAt) < 7 * DAY).length;
      const grade = c.score != null ? `<b>${Math.round(c.score * 10) / 10}</b><span>${esc(c.grade || '')}</span>` : `<b>—</b><span>no grade yet</span>`;
      return `<a class="course" style="--cc:${colorFor(c.id)}" href="${esc(c.url || '#')}" target="_blank" rel="noopener">
        <span class="code">${esc(shortCode(c.code))}${anns ? ` · ${anns} new` : ''}${!c.current && c.term ? ` · ${esc(c.term)}` : ''}</span>
        <span class="name">${esc(c.name)}</span>
        <span class="grade">${grade}</span>
        <span class="next">${late ? `<em style="color:var(--red)">${late} overdue</em> · ` : ''}${next ? `<em>${esc(fmtDayShort.format(new Date(next.dueAt)))}</em> ${esc(next.title)}` : 'nothing due'}</span>
      </a>`;
    })
    .join('');
  const others = all.length - cur.length;
  const meta = $('#courses-meta');
  meta.innerHTML = others > 0
    ? `${cur.length} this term · <button type="button" class="linkish" id="toggle-courses">${showAllCourses ? 'hide' : 'show'} ${others} other${others === 1 ? '' : 's'}</button>`
    : `${courses.length} this term`;
  $('#toggle-courses')?.addEventListener('click', () => { showAllCourses = !showAllCourses; renderCourses(); });
}

/* ------------------------------------------------------------------ */
/* Projects                                                            */
/* ------------------------------------------------------------------ */

function renderProjects() {
  const list = $('#project-list');
  const ps = S.projects || [];
  if (!ps.length) {
    list.innerHTML = `<div class="empty">No git repositories found under the configured folders. Edit <strong>projects.roots</strong> in config.json.</div>`;
    return;
  }
  list.innerHTML = ps
    .map((p) => {
      const sync = [p.ahead ? `↑${p.ahead}` : '', p.behind ? `↓${p.behind}` : ''].filter(Boolean).join(' ');
      const pr = p.prs?.[0];
      return `<div class="project">
        <div class="p-head"><span class="p-name">${esc(p.name)}</span><span class="p-branch" title="${esc(p.branch)}">${esc(p.branch)}</span>${p.worktree ? '<span class="p-worktree">worktree</span>' : ''}</div>
        <div class="p-line">${p.dirty ? `<span class="dirty">${p.dirty} uncommitted</span>` : '<span class="clean">clean</span>'}${sync ? `<span class="sync">${esc(sync)}</span>` : ''}${p.repoOpenPRs ? `<span>${p.repoOpenPRs} open PR${p.repoOpenPRs === 1 ? '' : 's'}</span>` : ''}</div>
        ${p.lastCommit ? `<div class="p-commit" title="${esc(p.lastCommit.subject)}">${esc(p.lastCommit.subject)}<small>${esc(relTime(p.lastCommit.at))}</small></div>` : ''}
        ${pr ? `<div class="p-pr"><a href="${esc(pr.url)}" target="_blank" rel="noopener">#${pr.number} ${esc(pr.title)}</a> ${pr.isDraft ? '<span class="draft">draft</span>' : ''}</div>` : ''}
        ${p.handoff ? `<div class="p-handoff"><b>${esc(p.handoff.file)}</b>${esc(p.handoff.headline)}</div>` : ''}
        <div class="p-actions">
          ${Object.entries(S.config?.apps || {}).map(([k, label]) => `<button type="button" class="tool small" data-open="${esc(k)}">${esc(label)}</button>`).join('')}
          <button type="button" class="tool small" data-open="default">Finder</button>
          ${p.remote ? `<a class="tool small" href="${esc(p.remote)}" target="_blank" rel="noopener">GitHub</a>` : ''}
        </div>
      </div>`;
    })
    .join('');
  $('#projects-meta').textContent = `${ps.length} repo${ps.length === 1 ? '' : 's'}`;
  list.querySelectorAll('[data-open]').forEach((btn, i) => {
    btn.addEventListener('click', () => {
      const card = btn.closest('.project');
      const idx = [...list.children].indexOf(card);
      openPath(ps[idx].path, btn.dataset.open);
    });
  });
}

/* ------------------------------------------------------------------ */
/* Announcements                                                       */
/* ------------------------------------------------------------------ */

function renderAnnouncements() {
  const list = $('#announce-list');
  const anns = (S.canvas?.announcements || []).slice(0, 12);
  if (!anns.length) {
    list.innerHTML = `<div class="empty">No announcements in the last three weeks.</div>`;
    $('#announce-meta').textContent = '';
    return;
  }
  list.innerHTML = anns
    .map((a) => {
      const c = courseById(a.courseId);
      return `<div class="ann">
        <div class="ann-top"><span class="tag" style="--cc:${colorFor(a.courseId)}">${esc(shortCode(c?.code))}</span><span class="ann-when">${esc(relTime(a.postedAt))}</span></div>
        <a class="ann-title" href="${esc(a.url || '#')}" target="_blank" rel="noopener">${esc(a.title)}</a>
        <div class="ann-body">${esc(a.excerpt)}</div>
      </div>`;
    })
    .join('');
  $('#announce-meta').textContent = `${anns.length} recent`;
}

/* ------------------------------------------------------------------ */
/* Files + pins                                                        */
/* ------------------------------------------------------------------ */

const KIND_LABEL = { image: 'img', video: 'vid', pdf: 'pdf', text: 'txt', code: 'src', doc: 'doc', file: 'file' };

function renderFiles() {
  const list = $('#file-list');
  const files = S.files || [];
  if (!files.length) {
    list.innerHTML = `<div class="empty">Nothing touched in the last two weeks.</div>`;
    return;
  }
  list.innerHTML = files
    .map(
      (f, i) => `<button type="button" class="file" data-i="${i}" title="${esc(f.path)}">
        <span class="f-icon">${KIND_LABEL[f.kind] || 'file'}</span>
        <span><span class="f-name">${esc(f.name)}</span><br><span class="f-dir">${esc(homeRel(f.dir))}</span></span>
        <span class="f-when">${esc(relTime(f.modifiedAt))}</span>
      </button>`
    )
    .join('');
  $('#files-meta').textContent = `${files.length} in 14 days`;
  list.querySelectorAll('.file').forEach((btn) => btn.addEventListener('click', () => openPath(files[Number(btn.dataset.i)].path)));
}

function renderPins() {
  const list = $('#pin-list');
  const fixed = (S.config?.pins || []).map((p) => ({ ...p, fixed: true }));
  const mine = S.local.pins || [];
  const all = [...fixed, ...mine];
  if (!all.length) {
    list.innerHTML = `<div class="empty">Pin the links and folders you open every day.</div>`;
    return;
  }
  list.innerHTML = all
    .map((p, i) => {
      const isPath = !!p.path;
      const host = isPath ? homeRel(p.path) : safeHost(p.url);
      const body = isPath
        ? `<button type="button" class="pin-open" data-i="${i}">${esc(p.label)}</button>`
        : `<a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.label)}</a>`;
      return `<div class="pin">${body}<span class="pin-host">${esc(host)}</span>${p.fixed ? '' : `<button type="button" class="task-x" data-i="${i}" aria-label="Remove pin">×</button>`}</div>`;
    })
    .join('');
  list.querySelectorAll('.pin-open').forEach((b) => b.addEventListener('click', () => openPath(expandTilde(all[Number(b.dataset.i)].path))));
  list.querySelectorAll('.task-x').forEach((b) =>
    b.addEventListener('click', () => {
      const p = all[Number(b.dataset.i)];
      S.local.pins = S.local.pins.filter((x) => x !== p);
      saveLocal();
      renderPins();
    })
  );
}

function safeHost(url) {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return '';
  }
}
function expandTilde(p) {
  return p.startsWith('~') && S.config?.home ? S.config.home + p.slice(1) : p;
}

$('#pin-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const form = e.target;
  const label = form.label.value.trim();
  const target = form.url.value.trim();
  if (!label || !target) return;
  const pin = /^(~|\/)/.test(target) ? { label, path: target } : { label, url: /^https?:\/\//.test(target) ? target : `https://${target}` };
  S.local.pins.push(pin);
  saveLocal();
  renderPins();
  form.reset();
});

/* ------------------------------------------------------------------ */
/* Focus timer                                                         */
/* ------------------------------------------------------------------ */

const FOCUS_MIN = 25;
const BREAK_MIN = 5;
const focus = { mode: 'idle', endsAt: null, startedAt: null, tick: null };

function renderFocus() {
  const btn = $('#focus-toggle');
  const time = $('#focus-time');
  const label = $('#focus-label');
  btn.className = 'focus-btn' + (focus.mode === 'focus' ? ' running' : focus.mode === 'break' ? ' break' : '');
  if (focus.mode === 'idle') {
    time.textContent = `${FOCUS_MIN}:00`;
    label.textContent = 'Focus';
    document.title = 'Season';
  } else {
    const left = Math.max(0, focus.endsAt - Date.now());
    const mm = Math.floor(left / 60000);
    const ss = Math.floor((left % 60000) / 1000);
    time.textContent = `${mm}:${pad(ss)}`;
    label.textContent = focus.mode === 'focus' ? 'Stop' : 'Break';
    document.title = `${mm}:${pad(ss)} · Season`;
  }
  const todayKey = dateKey(new Date());
  const n = (S.local.focus?.sessions || []).filter((s) => dateKey(new Date(s.startedAt)) === todayKey).length;
  $('#focus-count').textContent = n ? '●'.repeat(Math.min(n, 8)) + (n > 8 ? ` ${n}` : '') : '';
}

function startFocus(mode) {
  focus.mode = mode;
  focus.startedAt = new Date().toISOString();
  focus.endsAt = Date.now() + (mode === 'focus' ? FOCUS_MIN : BREAK_MIN) * 60000;
  clearInterval(focus.tick);
  focus.tick = setInterval(() => {
    if (Date.now() >= focus.endsAt) finishFocus();
    renderFocus();
  }, 500);
  renderFocus();
}

function finishFocus() {
  clearInterval(focus.tick);
  if (focus.mode === 'focus') {
    S.local.focus = S.local.focus || { sessions: [] };
    S.local.focus.sessions.push({ startedAt: focus.startedAt, minutes: FOCUS_MIN });
    saveLocal();
    toast('Focus block done. Five minutes off.');
    notify('Focus block done', 'Take five.');
    startFocus('break');
  } else {
    focus.mode = 'idle';
    toast('Break over.');
    notify('Break over', 'Back on the board.');
    renderFocus();
  }
}

function notify(title, body) {
  if ('Notification' in window && Notification.permission === 'granted') new Notification(title, { body });
}

$('#focus-toggle').addEventListener('click', () => {
  if (focus.mode === 'idle') {
    if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
    startFocus('focus');
  } else {
    clearInterval(focus.tick);
    focus.mode = 'idle';
    toast('Stopped.');
    renderFocus();
  }
});

/* ------------------------------------------------------------------ */
/* Command palette                                                     */
/* ------------------------------------------------------------------ */

const palette = { open: false, items: [], filtered: [], index: 0 };

function paletteItems() {
  const out = [];
  const now = new Date();
  out.push({ k: 'action', t: 'Refresh everything', s: 'R', run: () => loadAll({ refresh: true }) });
  out.push({ k: 'action', t: 'Switch whiteboard / chalkboard', s: 'theme', run: toggleTheme });
  out.push({ k: 'action', t: 'Go to this week', s: '', run: () => { S.weekStart = mondayOf(new Date()); renderWeek(); renderStrip(); } });
  out.push({ k: 'action', t: focus.mode === 'idle' ? 'Start a focus block' : 'Stop the focus block', s: '25 min', run: () => $('#focus-toggle').click() });
  if (S.config?.canvas?.host) out.push({ k: 'link', t: 'Open Canvas', s: S.config.canvas.host, run: () => window.open(`https://${S.config.canvas.host}`, '_blank', 'noopener') });
  for (const c of S.canvas?.courses || []) out.push({ k: 'course', t: `${shortCode(c.code)} ${c.name}`, s: c.grade || '', run: () => c.url && window.open(c.url, '_blank', 'noopener') });
  for (const it of S.canvas?.items || []) {
    if (isDone(it) && new Date(it.dueAt) < now) continue;
    out.push({ k: 'due', t: it.title, s: `${shortCode(courseById(it.courseId)?.code)} · ${fmtMonthDay.format(new Date(it.dueAt))}`, run: () => it.url && window.open(it.url, '_blank', 'noopener') });
  }
  for (const p of S.projects || []) {
    for (const [k, label] of Object.entries(S.config?.apps || {})) out.push({ k: 'project', t: `${p.name} → ${label}`, s: p.branch, run: () => openPath(p.path, k) });
    out.push({ k: 'project', t: `${p.name} → Finder`, s: p.branch, run: () => openPath(p.path, 'finder') });
    if (p.remote) out.push({ k: 'project', t: `${p.name} → GitHub`, s: p.slug, run: () => window.open(p.remote, '_blank', 'noopener') });
  }
  for (const f of S.files || []) out.push({ k: 'file', t: f.name, s: homeRel(f.dir), run: () => openPath(f.path) });
  for (const p of [...(S.config?.pins || []), ...(S.local.pins || [])]) out.push({ k: 'pin', t: p.label, s: p.url ? safeHost(p.url) : homeRel(p.path), run: () => (p.url ? window.open(p.url, '_blank', 'noopener') : openPath(expandTilde(p.path))) });
  return out;
}

function fuzzyScore(query, text) {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (!q) return 1;
  if (t.includes(q)) return 100 - t.indexOf(q) * 0.5;
  let qi = 0;
  let score = 0;
  let streak = 0;
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) {
      streak += 1;
      score += streak * 2 + (i === 0 || /\W/.test(t[i - 1]) ? 4 : 0);
      qi += 1;
    } else streak = 0;
  }
  return qi === q.length ? score : 0;
}

function openPalette() {
  palette.open = true;
  palette.items = paletteItems();
  $('#palette').hidden = false;
  const input = $('#palette-input');
  input.value = '';
  filterPalette('');
  input.focus();
}
function closePalette() {
  palette.open = false;
  $('#palette').hidden = true;
}
function filterPalette(q) {
  palette.filtered = palette.items
    .map((it) => ({ it, score: fuzzyScore(q, `${it.t} ${it.s}`) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 14)
    .map((x) => x.it);
  palette.index = 0;
  renderPalette();
}
function renderPalette() {
  const ul = $('#palette-list');
  ul.innerHTML = palette.filtered
    .map((it, i) => `<li role="option" aria-selected="${i === palette.index}" data-i="${i}"><span class="k">${esc(it.k)}</span><span class="t">${esc(it.t)}</span><span class="s">${esc(it.s)}</span></li>`)
    .join('') || `<li><span class="k"></span><span class="t" style="color:var(--ink-3)">No matches</span><span class="s"></span></li>`;
  ul.querySelectorAll('li[data-i]').forEach((li) => {
    li.addEventListener('mouseenter', () => { palette.index = Number(li.dataset.i); renderPalette(); });
    li.addEventListener('click', () => runPalette());
  });
  ul.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
}
function runPalette() {
  const it = palette.filtered[palette.index];
  if (!it) return;
  closePalette();
  it.run();
}

$('#palette-input').addEventListener('input', (e) => filterPalette(e.target.value));
$('#palette-input').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); palette.index = Math.min(palette.filtered.length - 1, palette.index + 1); renderPalette(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); palette.index = Math.max(0, palette.index - 1); renderPalette(); }
  else if (e.key === 'Enter') { e.preventDefault(); runPalette(); }
  else if (e.key === 'Escape') closePalette();
});
$('#palette').addEventListener('click', (e) => { if (e.target === e.currentTarget) closePalette(); });
$('#open-palette').addEventListener('click', openPalette);

/* ------------------------------------------------------------------ */
/* Theme, nav, shortcuts                                               */
/* ------------------------------------------------------------------ */

function toggleTheme() {
  const root = document.documentElement;
  const systemDark = matchMedia('(prefers-color-scheme: dark)').matches;
  const cur = root.dataset.theme || (systemDark ? 'dark' : 'light');
  const next = cur === 'dark' ? 'light' : 'dark';
  root.dataset.theme = next;
  try { localStorage.setItem('season:theme', next); } catch {}
  toast(next === 'dark' ? 'Chalkboard' : 'Whiteboard');
}
$('#theme').addEventListener('click', toggleTheme);
$('#refresh').addEventListener('click', () => loadAll({ refresh: true }));
$('#week-prev').addEventListener('click', () => { S.weekStart = addDays(S.weekStart, -7); renderWeek(); renderStrip(); });
$('#week-next').addEventListener('click', () => { S.weekStart = addDays(S.weekStart, 7); renderWeek(); renderStrip(); });
$('#week-today').addEventListener('click', () => { S.weekStart = mondayOf(new Date()); renderWeek(); renderStrip(); });

document.addEventListener('keydown', (e) => {
  const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); palette.open ? closePalette() : openPalette(); return; }
  if (palette.open || typing || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'r') loadAll({ refresh: true });
  else if (e.key === '[') $('#week-prev').click();
  else if (e.key === ']') $('#week-next').click();
  else if (e.key === 't') toggleTheme();
  else if (e.key === 'f') $('#focus-toggle').click();
  else if (e.key === '/') { e.preventDefault(); openPalette(); }
});

let resizeTimer;
addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(renderStrip, 120); });
setInterval(() => { renderUpdated(); renderHeader(); }, 60000);
setInterval(() => loadAll(), 10 * 60000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && S.lastLoad && Date.now() - S.lastLoad > 5 * 60000) loadAll(); });

renderFocus();
loadAll();
