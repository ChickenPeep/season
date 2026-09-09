/* Home — deadlines and tasks in one agenda, quiet lists beside it. Vanilla ES module. */

const $ = (sel, root = document) => root.querySelector(sel);
const DAY = 86400000;
const COURSE_COLORS = ['var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)', 'var(--c5)', 'var(--c6)'];

const S = {
  config: null,
  canvas: null,
  projects: null,
  files: null,
  local: { tasks: [], doneItems: [] },
  weekStart: mondayOf(new Date()),
  courseColor: new Map(),
  lastLoad: null,
  showAllCourses: false,
  showAllFiles: false,
  openAdd: null, // date key whose add-task field is open
};

/* ------------------------------------------------------------------ */
/* Utilities                                                           */
/* ------------------------------------------------------------------ */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
const dateKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
function fromKey(k) { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); }
function mondayOf(d) { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
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
const homeRel = (p) => (S.config?.home && p.startsWith(S.config.home) ? '~' + p.slice(S.config.home.length) : p);
const courseById = (id) => S.canvas?.courses.find((c) => c.id === id);
const shortCode = (code) => String(code || '').replace(/\s*[-–]\s*\d{2,3}[A-Z]?(\s*&\s*\d{2,3}[A-Z]?)?\s*$/, '').trim();
const colorFor = (courseId) => S.courseColor.get(courseId) || 'var(--text-3)';
const isDone = (item) => item.complete || S.local.doneItems.includes(item.id);
const isLate = (item, now = new Date()) => !isDone(item) && new Date(item.dueAt) < now && item.type !== 'calendar_event';

function currentCourses() {
  const all = S.canvas?.courses || [];
  const cur = all.filter((c) => c.current);
  return cur.length ? cur : all;
}
/** Deadlines that matter: from this term's courses (or untied to a course). */
function relevantItems() {
  const ids = new Set(currentCourses().map((c) => c.id));
  return (S.canvas?.items || []).filter((it) => it.courseId === null || ids.has(it.courseId));
}

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2400);
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
      const saved = await api('/api/state', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tasks: S.local.tasks, doneItems: S.local.doneItems }) });
      S.local.tasks = saved.tasks;
      S.local.doneItems = saved.doneItems;
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
    api('/api/config').then((c) => { S.config = c; renderHeader(); }),
    api('/api/state').then((st) => { S.local = { tasks: st.tasks || [], doneItems: st.doneItems || [] }; renderAgenda(); }),
    api('/api/canvas' + q).then((cv) => {
      S.canvas = cv;
      const ordered = [...cv.courses].sort((a, b) => (b.current ? 1 : 0) - (a.current ? 1 : 0));
      S.courseColor = new Map(ordered.map((c, i) => [c.id, COURSE_COLORS[i % COURSE_COLORS.length]]));
      renderBanner();
      renderHeader();
      renderAgenda();
      renderLater();
      renderCourses();
    }),
    api('/api/projects' + q).then((p) => { S.projects = p; renderProjects(); }),
    api('/api/files').then((f) => { S.files = f; renderFiles(); }),
  ];
  const results = await Promise.allSettled(jobs);
  const failed = results.filter((r) => r.status === 'rejected');
  if (failed.length) toast(`Some sections did not load: ${failed.map((f) => f.reason.message).join(', ')}`);
  S.lastLoad = new Date();
  renderUpdated();
}

function renderUpdated() {
  const at = S.canvas?.fetchedAt ? new Date(S.canvas.fetchedAt) : S.lastLoad;
  $('#updated').textContent = at ? `Updated ${relTime(at.toISOString())}` : '';
}

/* ------------------------------------------------------------------ */
/* Header                                                              */
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
  $('#date').textContent = fmtLong.format(now);
  const parts = [];
  if (info) {
    if (info.week < 1) parts.push(`${info.name} starts in ${Math.ceil((info.start - now) / DAY)} days`);
    else if (info.week > info.totalWeeks) parts.push(`${info.name} is over`);
    else parts.push(`Week ${info.week} of ${info.totalWeeks}`, `${info.daysLeft} days left`);
    $('#progress-bar').style.width = `${Math.max(0, Math.min(100, ((startOfDay(now) - info.start) / (info.end - info.start)) * 100))}%`;
  }
  const todayItems = relevantItems().filter((i) => dateKey(new Date(i.dueAt)) === dateKey(now) && !isDone(i)).sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt));
  if (todayItems.length) parts.push(`Next: ${todayItems[0].title} at ${fmtTime.format(new Date(todayItems[0].dueAt))}`);
  const open = relevantItems().filter((i) => !isDone(i) && new Date(i.dueAt) >= startOfDay(now)).length;
  if (S.canvas && !todayItems.length) parts.push(open ? `${open} open in the next four weeks` : 'Nothing due in the next four weeks');
  $('#sub').textContent = parts.join(' · ');
}

function renderBanner() {
  const b = $('#banner');
  const cv = S.canvas;
  const env = S.config?.canvas?.envFile ? homeRel(S.config.canvas.envFile) : '~/tools/canvas-mcp/.env';
  b.className = 'banner';
  if (cv?.mock) {
    b.hidden = false;
    b.innerHTML = `Showing sample Canvas data. Put your token and school URL in <code>${esc(env)}</code> and restart. Projects and files are real.`;
  } else if (cv?.error) {
    b.hidden = false;
    b.classList.add('error');
    b.textContent = cv.error + (cv.stale ? ` Showing what was cached ${relTime(cv.fetchedAt)}.` : '');
  } else b.hidden = true;
}

/* ------------------------------------------------------------------ */
/* Agenda                                                              */
/* ------------------------------------------------------------------ */

function itemRow(it, { showDate = false } = {}) {
  const c = courseById(it.courseId);
  const d = new Date(it.dueAt);
  const done = isDone(it);
  const late = isLate(it);
  const status = it.missing && !done ? '<span class="pill miss">missing</span>' : it.late && it.submitted ? '<span class="pill late">late</span>' : it.submitted ? '<span class="pill ok">submitted</span>' : '';
  const when = it.type === 'calendar_event' ? fmtTime.format(d) : `${showDate ? fmtDayShort.format(d) + ' ' + fmtMonthDay.format(d).replace(/^\w+ /, '') + ' · ' : ''}${fmtTime.format(d)}`;
  return `<div class="row item ${done ? 'done' : ''} ${late ? 'late' : ''}">
    <input type="checkbox" data-id="${esc(it.id)}" ${done ? 'checked' : ''} ${it.complete ? 'disabled' : ''} aria-label="Done: ${esc(it.title)}">
    <a class="grow title" href="${esc(it.url || '#')}" target="_blank" rel="noopener">${esc(it.title)}</a>
    ${status}
    <span class="tag" style="--cc:${colorFor(it.courseId)}">${esc(shortCode(c?.code) || it.contextName || '')}</span>
    <span class="dim when">${esc(when)}</span>
    ${it.points != null ? `<span class="mono">${it.points} pt</span>` : ''}
  </div>`;
}

function taskRow(t) {
  return `<div class="row task ${t.done ? 'done' : ''}" draggable="true" data-id="${esc(t.id)}">
    <input type="checkbox" ${t.done ? 'checked' : ''} aria-label="Done: ${esc(t.title)}">
    <span class="grow">${esc(t.title)}</span>
    <button type="button" class="x" aria-label="Remove task">×</button>
  </div>`;
}

function renderAgenda() {
  const el = $('#agenda');
  const now = new Date();
  const todayKey = dateKey(now);
  const info = semesterInfo();
  const sameWeek = dateKey(S.weekStart) === dateKey(mondayOf(now));
  const weekNo = info ? Math.floor((S.weekStart - info.start) / (7 * DAY)) + 1 : null;
  $('#week-title').textContent = sameWeek ? 'This week' : `Week of ${fmtMonthDay.format(S.weekStart)}${weekNo && weekNo >= 1 && weekNo <= info.totalWeeks ? ` · week ${weekNo}` : ''}`;
  const items = relevantItems();

  let html = '';
  // Overdue, only while looking at the current week: anything unfinished before today that isn't in view.
  if (sameWeek) {
    const overdue = items.filter((it) => isLate(it, now) && new Date(it.dueAt) < S.weekStart).sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt));
    if (overdue.length) html += `<div class="day"><div class="day-head"><span class="day-name" style="color:var(--red)">Overdue</span></div>${overdue.map((it) => itemRow(it, { showDate: true })).join('')}</div>`;
  }
  for (let i = 0; i < 7; i++) {
    const d = addDays(S.weekStart, i);
    const k = dateKey(d);
    const dayItems = items.filter((it) => dateKey(new Date(it.dueAt)) === k).sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt));
    const tasks = S.local.tasks.filter((t) => t.date === k);
    const isToday = k === todayKey;
    const past = d < startOfDay(now) && !isToday;
    html += `<div class="day ${isToday ? 'today' : ''} ${past ? 'past' : ''}" data-date="${k}">
      <div class="day-head">
        <span class="day-name">${esc(fmtDayShort.format(d))}</span>
        <span class="day-num">${esc(fmtMonthDay.format(d))}</span>
        ${isToday ? '<span class="day-flag">Today</span>' : ''}
        <button type="button" class="day-add" title="Add a task" aria-label="Add a task for ${esc(fmtMonthDay.format(d))}">+</button>
      </div>
      ${dayItems.map((it) => itemRow(it)).join('')}
      ${tasks.map(taskRow).join('')}
      ${!dayItems.length && !tasks.length && S.openAdd !== k ? '<div class="free">Nothing due</div>' : ''}
      <form class="add-form" ${S.openAdd === k ? '' : 'hidden'}><input name="title" placeholder="New task" aria-label="New task" maxlength="300" autocomplete="off"></form>
    </div>`;
  }
  el.innerHTML = html;
  wireAgenda(el);
  if (S.openAdd) el.querySelector(`[data-date="${S.openAdd}"] .add-form input`)?.focus();
}

function wireAgenda(root) {
  root.querySelectorAll('.item input[type="checkbox"]').forEach((cb) => cb.addEventListener('change', () => toggleItem(cb.dataset.id, cb.checked)));
  root.querySelectorAll('.day-add').forEach((b) => b.addEventListener('click', () => {
    const k = b.closest('.day').dataset.date;
    S.openAdd = S.openAdd === k ? null : k;
    renderAgenda();
  }));
  root.querySelectorAll('.add-form').forEach((form) => {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const title = form.title.value.trim();
      if (!title) return;
      S.local.tasks.push({ id: crypto.randomUUID(), title, date: form.closest('.day').dataset.date, done: false, createdAt: new Date().toISOString() });
      saveLocal();
      renderAgenda();
    });
    form.querySelector('input').addEventListener('keydown', (e) => { if (e.key === 'Escape') { S.openAdd = null; renderAgenda(); } });
    form.querySelector('input').addEventListener('blur', () => { if (!form.title.value.trim() && S.openAdd) { S.openAdd = null; renderAgenda(); } });
  });
  root.querySelectorAll('.task').forEach((el) => {
    const id = el.dataset.id;
    el.querySelector('input').addEventListener('change', (e) => { const t = S.local.tasks.find((x) => x.id === id); if (t) t.done = e.target.checked; saveLocal(); renderAgenda(); });
    el.querySelector('.x').addEventListener('click', () => { S.local.tasks = S.local.tasks.filter((x) => x.id !== id); saveLocal(); renderAgenda(); });
    el.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', id); e.dataTransfer.effectAllowed = 'move'; el.classList.add('dragging'); });
    el.addEventListener('dragend', () => el.classList.remove('dragging'));
  });
  root.querySelectorAll('.day[data-date]').forEach((day) => {
    day.addEventListener('dragover', (e) => { e.preventDefault(); day.classList.add('drop'); });
    day.addEventListener('dragleave', () => day.classList.remove('drop'));
    day.addEventListener('drop', (e) => {
      e.preventDefault();
      day.classList.remove('drop');
      const t = S.local.tasks.find((x) => x.id === e.dataTransfer.getData('text/plain'));
      if (t && t.date !== day.dataset.date) { t.date = day.dataset.date; saveLocal(); renderAgenda(); }
    });
  });
}

function toggleItem(id, checked) {
  S.local.doneItems = checked ? [...new Set([...S.local.doneItems, id])] : S.local.doneItems.filter((x) => x !== id);
  saveLocal();
  renderAgenda();
  renderLater();
  renderCourses();
  renderHeader();
}

/* ------------------------------------------------------------------ */
/* Coming up                                                           */
/* ------------------------------------------------------------------ */

function renderLater() {
  const el = $('#later');
  const now = new Date();
  const weekEnd = addDays(mondayOf(now), 7);
  const nextWeekEnd = addDays(weekEnd, 7);
  const items = relevantItems().filter((it) => new Date(it.dueAt) >= weekEnd && !(isDone(it) && new Date(it.dueAt) < now)).sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt));
  if (!items.length) {
    el.innerHTML = `<div class="empty">${S.canvas ? 'Nothing after this week yet.' : ''}</div>`;
    $('#later-meta').textContent = '';
    return;
  }
  const next = items.filter((it) => new Date(it.dueAt) < nextWeekEnd);
  const later = items.filter((it) => new Date(it.dueAt) >= nextWeekEnd);
  el.innerHTML = (next.length ? `<div class="group">Next week</div>${next.map((it) => itemRow(it, { showDate: true })).join('')}` : '') + (later.length ? `<div class="group">Later</div>${later.map((it) => itemRow(it, { showDate: true })).join('')}` : '');
  $('#later-meta').textContent = `${items.filter((it) => !isDone(it)).length} open`;
  el.querySelectorAll('.item input[type="checkbox"]').forEach((cb) => cb.addEventListener('change', () => toggleItem(cb.dataset.id, cb.checked)));
}

/* ------------------------------------------------------------------ */
/* School                                                              */
/* ------------------------------------------------------------------ */

function renderCourses() {
  const el = $('#courses');
  const all = S.canvas?.courses || [];
  const cur = currentCourses();
  const courses = S.showAllCourses ? all : cur;
  if (!courses.length) {
    el.innerHTML = `<div class="empty">${S.canvas?.configured ? 'No active courses.' : 'Connect Canvas to see courses.'}</div>`;
    $('#announcements').innerHTML = '';
    return;
  }
  const now = new Date();
  const items = relevantItems();
  el.innerHTML = courses
    .map((c) => {
      const open = items.filter((it) => it.courseId === c.id && !isDone(it) && new Date(it.dueAt) >= startOfDay(now)).sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt));
      const late = items.filter((it) => it.courseId === c.id && isLate(it, now)).length;
      const next = open[0];
      const nextText = late ? `<span style="color:var(--red)">${late} overdue</span>` : next ? `${esc(fmtDayShort.format(new Date(next.dueAt)))} · ${esc(next.title)}` : 'Nothing due';
      const grade = c.score != null ? `${Math.round(c.score * 10) / 10}${c.grade ? ' ' + esc(c.grade) : ''}` : '—';
      return `<a class="row course" style="--cc:${colorFor(c.id)}" href="${esc(c.url || '#')}" target="_blank" rel="noopener" title="${esc(c.name)}${!c.current && c.term ? ' · ' + esc(c.term) : ''}">
        <span class="code">${esc(shortCode(c.code))}</span>
        <span class="grow">${esc(c.name)}</span>
        <span class="dim">${nextText}</span>
        <span class="grade">${grade}</span>
      </a>`;
    })
    .join('');
  const others = all.length - cur.length;
  const meta = $('#courses-meta');
  meta.innerHTML = others > 0 ? `<button type="button" class="linkish" id="toggle-courses">${S.showAllCourses ? 'Hide' : 'Show'} ${others} past</button>` : '';
  $('#toggle-courses')?.addEventListener('click', () => { S.showAllCourses = !S.showAllCourses; renderCourses(); });

  const anns = (S.canvas?.announcements || []).filter((a) => cur.some((c) => c.id === a.courseId) && Date.now() - new Date(a.postedAt) < 10 * DAY).slice(0, 5);
  $('#announcements').innerHTML = anns.length
    ? `<div class="group">Announcements</div>` + anns.map((a) => `<a class="row ann" href="${esc(a.url || '#')}" target="_blank" rel="noopener">
        <span class="tag" style="--cc:${colorFor(a.courseId)}">${esc(shortCode(courseById(a.courseId)?.code))}</span>
        <span class="grow"><span>${esc(a.title)}</span><br><span class="body">${esc(a.excerpt)}</span></span>
        <span class="dim">${esc(relTime(a.postedAt))}</span>
      </a>`).join('')
    : '';
}

/* ------------------------------------------------------------------ */
/* Projects                                                            */
/* ------------------------------------------------------------------ */

function renderProjects() {
  const el = $('#projects');
  const ps = S.projects || [];
  if (!ps.length) {
    el.innerHTML = `<div class="empty">No git repositories under the configured folders.</div>`;
    return;
  }
  el.innerHTML = ps
    .map((p, i) => {
      const pr = p.prs?.[0];
      const sync = [p.ahead ? `↑${p.ahead}` : '', p.behind ? `↓${p.behind}` : ''].filter(Boolean).join(' ');
      return `<div class="row project" data-i="${i}">
        <span class="name">${esc(p.name)}</span>
        <span class="branch" title="${esc(p.branch)}">${esc(p.branch)}</span>
        <span class="state ${p.dirty ? 'dirty' : ''}">${p.dirty ? `${p.dirty} uncommitted` : 'clean'}${sync ? ` · ${esc(sync)}` : ''}</span>
        <span class="acts">
          ${Object.entries(S.config?.apps || {}).map(([k, label]) => `<button type="button" data-open="${esc(k)}">${esc(label)}</button>`).join('')}
          <button type="button" data-open="finder">Finder</button>
          ${p.remote ? `<a href="${esc(p.remote)}" target="_blank" rel="noopener">GitHub</a>` : ''}
        </span>
        ${pr ? `<span class="commit"><a href="${esc(pr.url)}" target="_blank" rel="noopener" style="color:var(--accent)">#${pr.number} ${esc(pr.title)}</a>${pr.isDraft ? ' · draft' : ''}</span>` : p.lastCommit ? `<span class="commit" title="${esc(p.lastCommit.subject)}">${esc(p.lastCommit.subject)} · ${esc(relTime(p.lastCommit.at))}</span>` : ''}
        ${p.handoff ? `<span class="handoff" title="${esc(p.handoff.headline)}">${esc(p.handoff.headline)}</span>` : ''}
      </div>`;
    })
    .join('');
  $('#projects-meta').textContent = `${ps.length}`;
  el.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => openPath(ps[Number(b.closest('.project').dataset.i)].path, b.dataset.open)));
}

/* ------------------------------------------------------------------ */
/* Files                                                               */
/* ------------------------------------------------------------------ */

const KIND = { image: 'img', video: 'vid', pdf: 'pdf', text: 'txt', code: 'src', doc: 'doc', file: '' };

function renderFiles() {
  const el = $('#files');
  const files = S.files || [];
  const shown = S.showAllFiles ? files : files.slice(0, 6);
  if (!files.length) {
    el.innerHTML = `<div class="empty">Nothing touched in the last two weeks.</div>`;
    $('#files-more').hidden = true;
    return;
  }
  el.innerHTML = shown
    .map((f, i) => `<div class="row file" data-i="${i}" title="${esc(f.path)}" role="button" tabindex="0">
      <span class="kind">${KIND[f.kind] ?? ''}</span>
      <span class="grow">${esc(f.name)}</span>
      <span class="dim">${esc(homeRel(f.dir))}</span>
      <span class="dim">${esc(relTime(f.modifiedAt))}</span>
    </div>`)
    .join('');
  const more = $('#files-more');
  more.hidden = files.length <= 6;
  more.textContent = S.showAllFiles ? 'Show fewer' : `Show all ${files.length}`;
  el.querySelectorAll('.file').forEach((row) => {
    const open = () => openPath(files[Number(row.dataset.i)].path);
    row.addEventListener('click', open);
    row.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
  });
}
$('#files-more').addEventListener('click', () => { S.showAllFiles = !S.showAllFiles; renderFiles(); });

/* ------------------------------------------------------------------ */
/* Palette                                                             */
/* ------------------------------------------------------------------ */

const palette = { open: false, items: [], filtered: [], index: 0 };

function paletteItems() {
  const out = [];
  const now = new Date();
  out.push({ k: 'action', t: 'Refresh', s: 'R', run: () => loadAll({ refresh: true }) });
  out.push({ k: 'action', t: 'This week', s: '', run: () => { S.weekStart = mondayOf(new Date()); renderAgenda(); } });
  if (S.config?.canvas?.host) out.push({ k: 'link', t: 'Canvas', s: S.config.canvas.host, run: () => window.open(`https://${S.config.canvas.host}`, '_blank', 'noopener') });
  for (const c of S.canvas?.courses || []) out.push({ k: 'course', t: `${shortCode(c.code)} ${c.name}`, s: c.grade || '', run: () => c.url && window.open(c.url, '_blank', 'noopener') });
  for (const it of relevantItems()) {
    if (isDone(it) && new Date(it.dueAt) < now) continue;
    out.push({ k: 'due', t: it.title, s: `${shortCode(courseById(it.courseId)?.code)} · ${fmtMonthDay.format(new Date(it.dueAt))}`, run: () => it.url && window.open(it.url, '_blank', 'noopener') });
  }
  for (const p of S.projects || []) {
    for (const [k, label] of Object.entries(S.config?.apps || {})) out.push({ k: 'project', t: `${p.name} → ${label}`, s: p.branch, run: () => openPath(p.path, k) });
    out.push({ k: 'project', t: `${p.name} → Finder`, s: p.branch, run: () => openPath(p.path, 'finder') });
    if (p.remote) out.push({ k: 'project', t: `${p.name} → GitHub`, s: p.slug, run: () => window.open(p.remote, '_blank', 'noopener') });
  }
  for (const f of S.files || []) out.push({ k: 'file', t: f.name, s: homeRel(f.dir), run: () => openPath(f.path) });
  return out;
}

function fuzzyScore(query, text) {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (!q) return 1;
  if (t.includes(q)) return 100 - t.indexOf(q) * 0.5;
  let qi = 0, score = 0, streak = 0;
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) { streak += 1; score += streak * 2 + (i === 0 || /\W/.test(t[i - 1]) ? 4 : 0); qi += 1; }
    else streak = 0;
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
function closePalette() { palette.open = false; $('#palette').hidden = true; }
function filterPalette(q) {
  palette.filtered = palette.items.map((it) => ({ it, score: fuzzyScore(q, `${it.t} ${it.s}`) })).filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, 12).map((x) => x.it);
  palette.index = 0;
  renderPalette();
}
function renderPalette() {
  const ul = $('#palette-list');
  ul.innerHTML = palette.filtered.map((it, i) => `<li role="option" aria-selected="${i === palette.index}" data-i="${i}"><span class="k">${esc(it.k)}</span><span class="t">${esc(it.t)}</span><span class="s">${esc(it.s)}</span></li>`).join('') || `<li><span class="k"></span><span class="t" style="color:var(--text-3)">No matches</span><span class="s"></span></li>`;
  ul.querySelectorAll('li[data-i]').forEach((li) => {
    li.addEventListener('mouseenter', () => { palette.index = Number(li.dataset.i); renderPalette(); });
    li.addEventListener('click', runPalette);
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
/* Nav + shortcuts                                                     */
/* ------------------------------------------------------------------ */

$('#refresh').addEventListener('click', () => loadAll({ refresh: true }));
$('#week-prev').addEventListener('click', () => { S.weekStart = addDays(S.weekStart, -7); S.openAdd = null; renderAgenda(); });
$('#week-next').addEventListener('click', () => { S.weekStart = addDays(S.weekStart, 7); S.openAdd = null; renderAgenda(); });
$('#week-today').addEventListener('click', () => { S.weekStart = mondayOf(new Date()); S.openAdd = null; renderAgenda(); });

document.addEventListener('keydown', (e) => {
  const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); palette.open ? closePalette() : openPalette(); return; }
  if (palette.open || typing || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'r') loadAll({ refresh: true });
  else if (e.key === '[') $('#week-prev').click();
  else if (e.key === ']') $('#week-next').click();
  else if (e.key === '/') { e.preventDefault(); openPalette(); }
});

setInterval(() => { renderUpdated(); renderHeader(); }, 60000);
setInterval(() => loadAll(), 10 * 60000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && S.lastLoad && Date.now() - S.lastLoad > 5 * 60000) loadAll(); });

loadAll();
