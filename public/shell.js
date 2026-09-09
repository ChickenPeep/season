/* Season shell — spaces in the sidebar, real tabs on the stage. Runs inside the Electron app; degrades to a preview in a browser. */

const $ = (sel, root = document) => root.querySelector(sel);
const isApp = !!window.season?.isApp;
const COURSE_COLORS = ['var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)', 'var(--c5)', 'var(--c6)'];
const BOARD_URL = `${location.origin}/`;

const S = {
  config: null,
  canvas: null,
  shell: { folders: [], today: [], activeId: null },
  runtime: new Map(), // tabId -> { view, url, title, favicon, loading, canBack, canFwd }
  closed: [],
  sidebarHidden: false,
};

/* ------------------------------------------------------------------ */
/* Utilities                                                           */
/* ------------------------------------------------------------------ */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2));
const hostOf = (url) => { try { return new URL(url).host.replace(/^www\./, ''); } catch { return ''; } };
const shortCode = (code) => String(code || '').replace(/\s*[-–]\s*\d{2,3}[A-Z]?(\s*&\s*\d{2,3}[A-Z]?)?\s*$/, '').trim();

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
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const shell = {
      folders: S.shell.folders.map((f) => ({ id: f.id, name: f.name, icon: f.icon, open: !!f.open, courses: !!f.courses, tabs: f.tabs.map(stripTab) })),
      today: S.shell.today.map(stripTab),
      activeId: S.shell.activeId,
    };
    api('/api/state', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ shell }) }).catch((e) => toast(`Could not save tabs: ${e.message}`));
  }, 300);
}
function stripTab(t) {
  const rt = S.runtime.get(t.id);
  return { id: t.id, title: t.title, url: t.url, favicon: rt?.favicon || t.favicon || null, lastUrl: rt?.url || t.lastUrl || null };
}

/** Turn what someone typed into somewhere to go. */
function resolveInput(text) {
  const t = text.trim();
  if (!t) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return t;
  if (/^localhost(:\d+)?(\/|$)/.test(t) || /^\d+\.\d+\.\d+\.\d+/.test(t)) return `http://${t}`;
  if (!/\s/.test(t) && /\.[a-z]{2,}(\/|$|:)/i.test(t)) return `https://${t}`;
  const engine = S.config?.shell?.search || 'https://www.google.com/search?q=';
  return engine + encodeURIComponent(t);
}

/* ------------------------------------------------------------------ */
/* Tabs model                                                          */
/* ------------------------------------------------------------------ */

function courseTabs() {
  const courses = (S.canvas?.courses || []).filter((c) => c.current);
  return courses.map((c, i) => ({ id: `course:${c.id}`, title: shortCode(c.code) || c.name, sub: c.name, url: c.url, auto: true, color: COURSE_COLORS[i % COURSE_COLORS.length] }));
}
function folderTabs(f) {
  return f.courses ? [...f.tabs, ...courseTabs()] : f.tabs;
}
function allTabs() {
  return [...S.shell.folders.flatMap(folderTabs), ...S.shell.today];
}
function findTab(id) {
  return allTabs().find((t) => t.id === id) || null;
}
function homeOf(id) {
  for (const f of S.shell.folders) if (folderTabs(f).some((t) => t.id === id)) return f;
  return null;
}
function activeTab() {
  return findTab(S.shell.activeId);
}

function seedShell() {
  const seed = S.config?.shell?.folders || [];
  S.shell.folders = seed.map((f) => ({ id: f.id || uid(), name: f.name, icon: f.icon || '▪', open: f.open !== false, courses: !!f.courses, tabs: (f.tabs || []).map((t) => ({ id: uid(), title: t.title, url: t.url, favicon: null })) }));
  S.shell.today = [];
  S.shell.activeId = S.shell.folders[0]?.tabs[0]?.id || null;
}

/* ------------------------------------------------------------------ */
/* Views (webview in the app, iframe preview in a browser)             */
/* ------------------------------------------------------------------ */

function ensureView(tab) {
  let rt = S.runtime.get(tab.id);
  if (rt?.view) return rt;
  if (!rt) {
    rt = { view: null, url: tab.lastUrl || tab.url, title: tab.title, favicon: tab.favicon || null, loading: false, canBack: false, canFwd: false };
    S.runtime.set(tab.id, rt);
  }
  if (!tab.url) return rt; // a blank new tab: nothing to load yet
  const startUrl = tab.auto || homeOf(tab) ? tab.url : rt.url || tab.url;
  const external = !startUrl.startsWith(location.origin);
  if (!isApp && external) return rt; // browsers cannot frame most sites; the stage explains

  const view = document.createElement(isApp ? 'webview' : 'iframe');
  view.dataset.tab = tab.id;
  if (isApp) {
    view.setAttribute('partition', 'persist:season');
    view.setAttribute('src', startUrl);
    view.addEventListener('did-start-loading', () => { rt.loading = true; syncTab(tab.id); });
    view.addEventListener('did-stop-loading', () => { rt.loading = false; rt.canBack = view.canGoBack(); rt.canFwd = view.canGoForward(); syncTab(tab.id); });
    view.addEventListener('page-title-updated', (e) => { rt.title = e.title; syncTab(tab.id); });
    view.addEventListener('page-favicon-updated', (e) => { rt.favicon = e.favicons?.[0] || rt.favicon; syncTab(tab.id); persist(); });
    const onNav = (e) => { rt.url = e.url || view.getURL(); rt.canBack = view.canGoBack(); rt.canFwd = view.canGoForward(); syncTab(tab.id); persist(); };
    view.addEventListener('did-navigate', onNav);
    view.addEventListener('did-navigate-in-page', onNav);
    view.addEventListener('did-fail-load', (e) => {
      if (e.errorCode === -3 || !e.isMainFrame) return; // aborted, or a subframe
      rt.loading = false;
      rt.title = 'Could not load';
      syncTab(tab.id);
      toast(`${hostOf(e.validatedURL) || 'Page'} did not load (${e.errorDescription || e.errorCode}).`);
    });
    view.addEventListener('focus', () => closePalette());
  } else {
    view.src = startUrl;
    view.addEventListener('load', () => { rt.loading = false; syncTab(tab.id); });
  }
  $('#views').appendChild(view);
  rt.view = view;
  rt.loading = true;
  return rt;
}

function dropView(id) {
  const rt = S.runtime.get(id);
  if (rt?.view) {
    rt.view.remove();
    rt.view = null;
    rt.loading = false;
  }
}

function viewAction(fn) {
  const rt = S.runtime.get(S.shell.activeId);
  if (rt?.view && isApp) fn(rt.view, rt);
}

/* ------------------------------------------------------------------ */
/* Activation, opening, closing, moving                                */
/* ------------------------------------------------------------------ */

function activate(id, { focusOmni = false } = {}) {
  const tab = findTab(id);
  if (!tab) return;
  S.shell.activeId = id;
  const rt = ensureView(tab);
  for (const el of $('#views').querySelectorAll('webview, iframe')) el.classList.toggle('active', el.dataset.tab === id);
  const external = tab.url && !tab.url.startsWith(location.origin);
  $('#newtab').hidden = !!tab.url;
  $('#notapp').hidden = !(!isApp && external);
  if (!tab.url) renderQuick();
  renderSidebar();
  syncToolbar();
  document.title = (rt.title || tab.title || 'Season') + ' · Season';
  if (focusOmni || !tab.url) { const o = $('#omni'); o.focus(); o.select(); }
  else if (rt.view && isApp) rt.view.focus?.();
  persist();
}

function openTab(url, { folderId = null, title = null, activate: act = true, next = false } = {}) {
  const tab = { id: uid(), title: title || (url ? hostOf(url) || url : 'New tab'), url: url || '', favicon: null };
  const folder = folderId ? S.shell.folders.find((f) => f.id === folderId) : null;
  if (folder) folder.tabs.push(tab);
  else if (next && S.shell.today.some((t) => t.id === S.shell.activeId)) S.shell.today.splice(S.shell.today.findIndex((t) => t.id === S.shell.activeId) + 1, 0, tab);
  else S.shell.today.push(tab);
  tab.fresh = true;
  if (act) activate(tab.id, { focusOmni: !url });
  else { renderSidebar(); persist(); }
  return tab;
}

function neighborOf(id) {
  const list = allTabs();
  const i = list.findIndex((t) => t.id === id);
  return list[i + 1] || list[i - 1] || list[0] || null;
}

function closeTab(id) {
  const tab = findTab(id);
  if (!tab) return;
  const home = homeOf(id);
  const rt = S.runtime.get(id);
  const wasActive = S.shell.activeId === id;
  if (home) {
    // Pinned tabs sleep instead of disappearing.
    if (!rt?.view) return toast('Already asleep. Right-click to remove it from the space.');
    dropView(id);
    if (wasActive) { const n = neighborOf(id); if (n && n.id !== id) activate(n.id); else renderSidebar(); }
    else renderSidebar();
    return;
  }
  S.closed.push({ url: rt?.url || tab.url, title: tab.title });
  dropView(id);
  S.runtime.delete(id);
  S.shell.today = S.shell.today.filter((t) => t.id !== id);
  if (wasActive) {
    const n = neighborOf(id) || allTabs()[0];
    if (n) activate(n.id); else openTab('');
  } else { renderSidebar(); persist(); }
}

function removeFromSpace(id) {
  for (const f of S.shell.folders) f.tabs = f.tabs.filter((t) => t.id !== id);
  dropView(id);
  S.runtime.delete(id);
  if (S.shell.activeId === id) { const n = allTabs()[0]; if (n) activate(n.id); else openTab(''); }
  else { renderSidebar(); persist(); }
}

function moveTab(id, targetFolderId) {
  const tab = findTab(id);
  if (!tab || tab.auto) return;
  for (const f of S.shell.folders) f.tabs = f.tabs.filter((t) => t.id !== id);
  S.shell.today = S.shell.today.filter((t) => t.id !== id);
  const rt = S.runtime.get(id);
  if (targetFolderId) {
    const f = S.shell.folders.find((x) => x.id === targetFolderId);
    if (!f) return;
    // Pinning freezes the current page as the tab's home.
    if (rt?.url) tab.url = rt.url;
    if (rt?.title) tab.title = rt.title;
    f.tabs.push(tab);
    f.open = true;
  } else S.shell.today.push(tab);
  renderSidebar();
  persist();
}

function reopenClosed() {
  const last = S.closed.pop();
  if (!last) return toast('Nothing to reopen.');
  openTab(last.url, { title: last.title });
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

function favHtml(tab) {
  const rt = S.runtime.get(tab.id);
  const fav = rt?.favicon || tab.favicon;
  if (tab.auto) return `<span class="fav mono" style="--cc:${tab.color}">${esc(tab.title.split(' ').pop())}</span>`;
  if (tab.url?.startsWith(location.origin)) return `<span class="fav" style="background:var(--blue);color:#fff;font-family:var(--display);font-weight:700">S</span>`;
  if (fav) return `<span class="fav"><img src="${esc(fav)}" alt="" onerror="this.parentNode.textContent='${esc((hostOf(tab.url)[0] || '·').toUpperCase())}'"></span>`;
  return `<span class="fav">${esc((hostOf(tab.url)[0] || '+').toUpperCase())}</span>`;
}

function tabHtml(tab, { inFolder }) {
  const rt = S.runtime.get(tab.id);
  const active = tab.id === S.shell.activeId;
  const title = inFolder ? tab.title : rt?.title || tab.title;
  const sub = inFolder ? (tab.sub ? tab.sub : hostOf(tab.url)) : '';
  const cls = ['tab', active ? 'active' : '', rt?.loading ? 'loading' : '', inFolder && !rt?.view ? 'sleeping' : '', tab.fresh ? 'enter' : ''].join(' ');
  delete tab.fresh;
  return `<div class="${cls}" data-id="${esc(tab.id)}" draggable="${tab.auto ? 'false' : 'true'}" title="${esc(rt?.url || tab.url || 'New tab')}" role="button" tabindex="0">
    ${favHtml(tab)}
    <span class="title">${esc(title)}</span>
    ${sub && !active ? '' : sub ? `<span class="sub">${esc(sub.length > 22 ? sub.slice(0, 20) + '…' : sub)}</span>` : ''}
    <button type="button" class="x" aria-label="${inFolder ? 'Sleep tab' : 'Close tab'}" title="${inFolder ? 'Sleep (⌘W)' : 'Close (⌘W)'}">×</button>
  </div>`;
}

function renderSidebar() {
  const spaces = $('#spaces');
  spaces.innerHTML = S.shell.folders
    .map((f) => {
      const tabs = folderTabs(f);
      return `<section class="folder ${f.open ? 'open' : ''}" data-id="${esc(f.id)}">
        <button type="button" class="folder-head" aria-expanded="${f.open}">
          <span class="folder-icon">${esc(f.icon)}</span>
          <span class="folder-name">${esc(f.name)}</span>
          <span class="folder-count">${tabs.length}</span>
          <span class="folder-add" role="button" title="New tab in ${esc(f.name)}" aria-label="New tab in ${esc(f.name)}">+</span>
          <svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>
        </button>
        <div class="folder-body"><div><div class="folder-tabs">${tabs.map((t) => tabHtml(t, { inFolder: true })).join('')}</div></div></div>
      </section>`;
    })
    .join('');
  $('#today-tabs').innerHTML = S.shell.today.map((t) => tabHtml(t, { inFolder: false })).join('');
  wireSidebar();
  requestAnimationFrame(moveMarker);
}

function syncTab(id) {
  // Cheap partial update for one tab's row(s) and the toolbar if active.
  const tab = findTab(id);
  if (!tab) return;
  const rt = S.runtime.get(id);
  document.querySelectorAll(`.tab[data-id="${CSS.escape(id)}"]`).forEach((el) => {
    const inFolder = !!el.closest('.folder');
    el.classList.toggle('loading', !!rt?.loading);
    el.classList.toggle('sleeping', inFolder && !rt?.view);
    if (!inFolder) el.querySelector('.title').textContent = rt?.title || tab.title;
    el.title = rt?.url || tab.url || '';
    const favWrap = el.querySelector('.fav');
    if (favWrap && rt?.favicon && !favWrap.querySelector('img') && !tab.auto && !tab.url?.startsWith(location.origin)) favWrap.outerHTML = favHtml(tab);
  });
  if (id === S.shell.activeId) {
    syncToolbar();
    document.title = (rt?.title || tab.title || 'Season') + ' · Season';
  }
}

function syncToolbar() {
  const tab = activeTab();
  const rt = tab ? S.runtime.get(tab.id) : null;
  const omni = $('#omni');
  if (document.activeElement !== omni) omni.value = rt?.url || tab?.url || '';
  $('#back').disabled = !rt?.canBack;
  $('#fwd').disabled = !rt?.canFwd;
  $('#omni-loading').hidden = !rt?.loading;
  const lock = $('#omni-lock');
  const u = rt?.url || tab?.url || '';
  lock.className = 'omni-lock' + (u.startsWith(location.origin) ? ' local' : u.startsWith('http:') ? ' insecure' : '');
  lock.hidden = !u;
}

function moveMarker() {
  const el = document.querySelector(`.tab.active`);
  const marker = $('#marker');
  if (!el) return marker.classList.remove('on');
  const side = $('#sidebar').getBoundingClientRect();
  const r = el.getBoundingClientRect();
  marker.style.top = `${r.top - side.top + (r.height - 20) / 2}px`;
  marker.classList.add('on');
}

function renderQuick() {
  const items = [...S.shell.folders.flatMap((f) => folderTabs(f).map((t) => ({ t, f })))];
  $('#quick').innerHTML = items
    .filter(({ t }) => t.url)
    .map(({ t, f }) => `<button type="button" data-id="${esc(t.id)}">${favHtml(t)}<span><span class="q-title">${esc(t.title)}</span><br><span class="q-sub">${esc(f.name)}${t.sub ? ' · ' + esc(t.sub) : ''}</span></span></button>`)
    .join('');
  $('#quick').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
    const blank = activeTab();
    if (blank && !blank.url) { S.shell.today = S.shell.today.filter((t) => t.id !== blank.id); S.runtime.delete(blank.id); }
    activate(b.dataset.id);
  }));
}

function renderWeek() {
  const sem = S.config?.semester;
  if (!sem) return;
  const start = new Date(sem.start + 'T00:00');
  const end = new Date(sem.end + 'T00:00');
  const now = new Date();
  const totalWeeks = Math.max(1, Math.ceil((end - start) / (7 * 86400000)));
  const week = Math.floor((now - start) / (7 * 86400000)) + 1;
  $('#side-week').textContent = week >= 1 && week <= totalWeeks ? `Wk ${week}/${totalWeeks}` : sem.name;
}

/* ------------------------------------------------------------------ */
/* Wiring                                                              */
/* ------------------------------------------------------------------ */

function wireSidebar() {
  document.querySelectorAll('.folder').forEach((sec) => {
    const f = S.shell.folders.find((x) => x.id === sec.dataset.id);
    sec.querySelector('.folder-head').addEventListener('click', (e) => {
      if (e.target.closest('.folder-add')) { openTab('', { folderId: f.id }); return; }
      f.open = !f.open;
      sec.classList.toggle('open', f.open);
      sec.querySelector('.folder-head').setAttribute('aria-expanded', String(f.open));
      setTimeout(moveMarker, 250);
      persist();
    });
    sec.addEventListener('dragover', (e) => { e.preventDefault(); sec.classList.add('drop'); });
    sec.addEventListener('dragleave', () => sec.classList.remove('drop'));
    sec.addEventListener('drop', (e) => { e.preventDefault(); sec.classList.remove('drop'); moveTab(e.dataTransfer.getData('text/plain'), f.id); });
  });
  const today = $('#today-wrap');
  today.addEventListener('dragover', (e) => e.preventDefault());
  today.addEventListener('drop', (e) => { e.preventDefault(); moveTab(e.dataTransfer.getData('text/plain'), null); });

  document.querySelectorAll('.tab').forEach((el) => {
    const id = el.dataset.id;
    el.addEventListener('click', (e) => { if (e.target.closest('.x')) return; activate(id); });
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(id); } });
    el.querySelector('.x').addEventListener('click', (e) => { e.stopPropagation(); closeTab(id); });
    el.addEventListener('auxclick', (e) => { if (e.button === 1) closeTab(id); });
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); showContext(e.clientX, e.clientY, id); });
    el.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', id); e.dataTransfer.effectAllowed = 'move'; el.classList.add('dragging'); });
    el.addEventListener('dragend', () => el.classList.remove('dragging'));
  });
}

function showContext(x, y, id) {
  const tab = findTab(id);
  const home = homeOf(id);
  const rt = S.runtime.get(id);
  const menu = $('#ctx');
  const url = rt?.url || tab.url;
  const folders = S.shell.folders.filter((f) => f.id !== home?.id);
  menu.innerHTML = [
    `<button data-act="reload">Reload</button>`,
    `<button data-act="external">Open in default browser</button>`,
    `<button data-act="copy">Copy address</button>`,
    `<hr>`,
    ...(!tab.auto ? folders.map((f) => `<button data-act="move" data-f="${esc(f.id)}">Pin to ${esc(f.name)}</button>`) : []),
    !tab.auto && home ? `<button data-act="move" data-f="">Move to Today</button>` : '',
    `<hr>`,
    home && rt?.view ? `<button data-act="sleep">Sleep</button>` : '',
    home && !tab.auto ? `<button data-act="remove" class="danger">Remove from ${esc(home.name)}</button>` : '',
    !home ? `<button data-act="close" class="danger">Close</button>` : '',
  ].join('');
  menu.hidden = false;
  const w = menu.offsetWidth, h = menu.offsetHeight;
  menu.style.left = `${Math.min(x, innerWidth - w - 8)}px`;
  menu.style.top = `${Math.min(y, innerHeight - h - 8)}px`;
  menu.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
    menu.hidden = true;
    const act = b.dataset.act;
    if (act === 'reload') { const r = S.runtime.get(id); r?.view?.reload?.(); }
    else if (act === 'external') { if (isApp) window.season.openExternal(url); else window.open(url, '_blank', 'noopener'); }
    else if (act === 'copy') navigator.clipboard.writeText(url).then(() => toast('Copied.'));
    else if (act === 'move') moveTab(id, b.dataset.f || null);
    else if (act === 'sleep') { dropView(id); renderSidebar(); if (S.shell.activeId === id) activate(id); }
    else if (act === 'remove') removeFromSpace(id);
    else if (act === 'close') closeTab(id);
  }));
}
document.addEventListener('click', (e) => { if (!e.target.closest('#ctx')) $('#ctx').hidden = true; });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('#ctx').hidden = true; });

/* Toolbar */
$('#back').addEventListener('click', () => viewAction((v) => v.goBack()));
$('#fwd').addEventListener('click', () => viewAction((v) => v.goForward()));
$('#reload').addEventListener('click', () => viewAction((v) => v.reload()));
$('#external').addEventListener('click', () => {
  const tab = activeTab();
  const url = S.runtime.get(tab?.id)?.url || tab?.url;
  if (!url) return;
  if (isApp) window.season.openExternal(url); else window.open(url, '_blank', 'noopener');
});
$('#sidebar-btn').addEventListener('click', toggleSidebar);
$('#omni').addEventListener('focus', (e) => setTimeout(() => e.target.select(), 0));
$('#omni-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const target = resolveInput($('#omni').value);
  if (!target) return;
  const tab = activeTab();
  if (!tab) return openTab(target);
  if (!tab.url) {
    tab.url = target;
    tab.title = hostOf(target) || target;
    activate(tab.id);
    return;
  }
  const rt = ensureView(tab);
  if (rt.view) { if (isApp) rt.view.loadURL(target); else rt.view.src = target; }
  rt.url = target;
  syncToolbar();
  rt.view?.focus?.();
});

/* Sidebar buttons */
$('#new-tab-btn').addEventListener('click', () => openTab(''));
$('#clear-today').addEventListener('click', () => {
  const ids = S.shell.today.map((t) => t.id);
  ids.forEach((id) => { const rt = S.runtime.get(id); S.closed.push({ url: rt?.url || findTab(id)?.url, title: findTab(id)?.title }); dropView(id); S.runtime.delete(id); });
  S.shell.today = [];
  if (ids.includes(S.shell.activeId)) { const n = allTabs()[0]; if (n) activate(n.id); else openTab(''); } else { renderSidebar(); persist(); }
});
$('#theme-btn').addEventListener('click', toggleTheme);
$('#spaces').addEventListener('scroll', moveMarker, { passive: true });
addEventListener('resize', moveMarker);

function toggleSidebar() {
  S.sidebarHidden = !S.sidebarHidden;
  $('#app').classList.toggle('side-hidden', S.sidebarHidden);
  try { localStorage.setItem('season:sidebar', S.sidebarHidden ? 'hidden' : 'shown'); } catch {}
  setTimeout(moveMarker, 240);
}
function toggleTheme() {
  const root = document.documentElement;
  const systemDark = matchMedia('(prefers-color-scheme: dark)').matches;
  const cur = root.dataset.theme || (systemDark ? 'dark' : 'light');
  const next = cur === 'dark' ? 'light' : 'dark';
  root.dataset.theme = next;
  try { localStorage.setItem('season:theme', next); } catch {}
  if (isApp) window.season.setTheme(next);
  toast(next === 'dark' ? 'Chalkboard' : 'Whiteboard');
}

/* ------------------------------------------------------------------ */
/* Palette                                                             */
/* ------------------------------------------------------------------ */

const palette = { open: false, items: [], filtered: [], index: 0, query: '' };

function paletteItems() {
  const out = [];
  for (const f of S.shell.folders) for (const t of folderTabs(f)) out.push({ k: f.name, t: t.title + (t.sub ? ` · ${t.sub}` : ''), s: hostOf(t.url), run: () => activate(t.id) });
  for (const t of S.shell.today) { const rt = S.runtime.get(t.id); out.push({ k: 'today', t: rt?.title || t.title, s: hostOf(rt?.url || t.url), run: () => activate(t.id) }); }
  out.push({ k: 'action', t: 'New tab', s: '⌘T', run: () => openTab('') });
  out.push({ k: 'action', t: 'Go to the board', s: '⌘⇧H', run: goHome });
  out.push({ k: 'action', t: 'Toggle sidebar', s: '⌘\\', run: toggleSidebar });
  out.push({ k: 'action', t: 'Whiteboard / chalkboard', s: '⌘⇧D', run: toggleTheme });
  out.push({ k: 'action', t: 'Refresh Canvas data', s: '', run: () => api('/api/canvas?refresh=1').then(loadCanvas).then(() => toast('Canvas refreshed.')) });
  const now = new Date();
  for (const it of S.canvas?.items || []) {
    if (it.complete && new Date(it.dueAt) < now) continue;
    const c = (S.canvas.courses || []).find((x) => x.id === it.courseId);
    out.push({ k: 'due', t: it.title, s: `${shortCode(c?.code) || ''} · ${new Date(it.dueAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`, run: () => it.url && openTab(it.url, { title: it.title }) });
  }
  for (const p of S.projects || []) {
    for (const [k, label] of Object.entries(S.config?.apps || {})) out.push({ k: 'project', t: `${p.name} → ${label}`, s: p.branch, run: () => api('/api/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: p.path, app: k }) }).catch((e) => toast(e.message)) });
    if (p.remote) out.push({ k: 'project', t: `${p.name} → GitHub`, s: p.slug, run: () => openTab(p.remote) });
  }
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
  palette.query = q;
  const ranked = palette.items.map((it) => ({ it, score: fuzzyScore(q, `${it.t} ${it.s} ${it.k}`) })).filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, 14).map((x) => x.it);
  if (q.trim()) ranked.push({ k: 'go', t: /\.[a-z]{2,}/i.test(q) && !/\s/.test(q) ? `Open ${q.trim()}` : `Search for “${q.trim()}”`, s: '', run: () => openTab(resolveInput(q)) });
  palette.filtered = ranked;
  palette.index = 0;
  renderPalette();
}
function renderPalette() {
  const ul = $('#palette-list');
  ul.innerHTML = palette.filtered.map((it, i) => `<li role="option" aria-selected="${i === palette.index}" data-i="${i}"><span class="k">${esc(it.k)}</span><span class="t">${esc(it.t)}</span><span class="s">${esc(it.s)}</span></li>`).join('');
  ul.querySelectorAll('li').forEach((li) => {
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

/* ------------------------------------------------------------------ */
/* Shortcuts (menu accelerators in the app, keydown in a browser)      */
/* ------------------------------------------------------------------ */

function goHome() {
  const board = allTabs().find((t) => t.url === BOARD_URL || t.url === BOARD_URL.slice(0, -1));
  if (board) activate(board.id); else openTab(BOARD_URL, { title: 'Season' });
}

function shortcut(id) {
  const tabs = allTabs();
  const i = tabs.findIndex((t) => t.id === S.shell.activeId);
  switch (id) {
    case 'new-tab': return openTab('', { next: true });
    case 'close-tab': return palette.open ? closePalette() : closeTab(S.shell.activeId);
    case 'reopen-tab': return reopenClosed();
    case 'reload': return viewAction((v) => v.reload());
    case 'back': return viewAction((v) => v.goBack());
    case 'forward': return viewAction((v) => v.goForward());
    case 'focus-url': { const o = $('#omni'); o.focus(); o.select(); return; }
    case 'palette': return palette.open ? closePalette() : openPalette();
    case 'toggle-sidebar': return toggleSidebar();
    case 'home': return goHome();
    case 'theme': return toggleTheme();
    case 'next-tab': return tabs.length && activate(tabs[(i + 1) % tabs.length].id);
    case 'prev-tab': return tabs.length && activate(tabs[(i - 1 + tabs.length) % tabs.length].id);
    case 'open-external': return $('#external').click();
    case 'tab-devtools': return viewAction((v) => v.openDevTools());
    default: {
      const m = id.match(/^tab-(\d)$/);
      if (m) { const t = tabs[Number(m[1]) - 1]; if (t) activate(t.id); }
    }
  }
}
if (isApp) {
  window.season.onShortcut(shortcut);
  window.season.onOpenTab(({ url }) => openTab(url, { next: true }));
}
document.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (!mod) return;
  const map = { t: 'new-tab', w: 'close-tab', l: 'focus-url', k: 'palette', r: 'reload', '[': 'back', ']': 'forward', '\\': 'toggle-sidebar' };
  const id = e.shiftKey && e.key.toLowerCase() === 't' ? 'reopen-tab' : e.shiftKey && e.key.toLowerCase() === 'h' ? 'home' : e.shiftKey && e.key.toLowerCase() === 'd' ? 'theme' : map[e.key.toLowerCase()];
  if (!id) return;
  if (isApp && id !== 'palette') return; // the app menu already dispatched it
  e.preventDefault();
  shortcut(id);
});

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

function loadCanvas(cv) {
  S.canvas = cv;
  renderSidebar();
  if (!activeTab()?.url) renderQuick();
}

async function boot() {
  try { if (localStorage.getItem('season:sidebar') === 'hidden') { S.sidebarHidden = true; $('#app').classList.add('side-hidden'); } } catch {}
  const [config, state] = await Promise.all([api('/api/config'), api('/api/state')]);
  S.config = config;
  renderWeek();
  if (state.shell?.folders?.length) {
    S.shell = { folders: state.shell.folders.map((f) => ({ ...f, tabs: f.tabs || [] })), today: state.shell.today || [], activeId: state.shell.activeId };
    for (const t of allTabs()) if (t.lastUrl && !homeOf(t.id)) S.runtime.set(t.id, { view: null, url: t.lastUrl, title: t.title, favicon: t.favicon, loading: false });
  } else seedShell();
  renderSidebar();
  const first = findTab(S.shell.activeId) || allTabs()[0];
  if (first) activate(first.id); else openTab(BOARD_URL, { title: 'Season' });
  api('/api/canvas').then(loadCanvas).catch(() => {});
  api('/api/projects').then((p) => { S.projects = p; }).catch(() => {});
  if (isApp) { const t = document.documentElement.dataset.theme; if (t) window.season.setTheme(t); }
}

boot();
