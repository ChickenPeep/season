/* Season desktop shell: a window that owns real browser tabs, with the board served by the local server. */
import { app, BrowserWindow, Menu, session, shell, ipcMain, nativeTheme, safeStorage, dialog } from 'electron';
import { Terminals } from './terminal.mjs';
import { saveSessionCookies, restoreSessionCookies, clearSavedSessions } from './sessions.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4747);
const SHELL_URL = `http://localhost:${PORT}/shell.html`;
const PARTITION = 'persist:season';

app.setName('Season');

let win = null;
const terminals = new Terminals((channel, payload) => send(channel, payload));

async function serverUp() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/config`);
    return res.ok;
  } catch {
    return false;
  }
}

/** Reuse a board server that is already running (npm start); otherwise boot one in this process. */
async function startServer() {
  if (await serverUp()) return;
  await import('../server.mjs');
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/config`);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('board server did not start');
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function buildMenu() {
  const key = (name, accelerator, extra = {}) => ({ label: name, accelerator, click: () => send('shortcut', extra.id || name), ...extra });
  const template = [
    { role: 'appMenu' },
    {
      label: 'File',
      submenu: [
        key('New tab', 'CmdOrCtrl+T', { id: 'new-tab' }),
        key('New terminal', 'CmdOrCtrl+Alt+T', { id: 'new-terminal' }),
        key('Close tab', 'CmdOrCtrl+W', { id: 'close-tab' }),
        key('Reopen closed tab', 'CmdOrCtrl+Shift+T', { id: 'reopen-tab' }),
        { type: 'separator' },
        key('Open in default browser', 'CmdOrCtrl+Shift+O', { id: 'open-external' }),
        { type: 'separator' },
        {
          label: 'Sign out of all sites…',
          click: async () => {
            const { response } = await dialog.showMessageBox(win, {
              type: 'warning',
              buttons: ['Sign out', 'Cancel'],
              defaultId: 1,
              cancelId: 1,
              message: 'Sign out of every site in Season?',
              detail: 'Clears the saved sign-ins for every tab, including Canvas. Other browsers are not affected.',
            });
            if (response !== 0) return;
            await clearSavedSessions({ app, session, partition: PARTITION });
            send('shortcut', 'reload');
          },
        },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        key('Reload tab', 'CmdOrCtrl+R', { id: 'reload' }),
        key('Back', 'CmdOrCtrl+[', { id: 'back' }),
        key('Forward', 'CmdOrCtrl+]', { id: 'forward' }),
        { type: 'separator' },
        key('Focus address bar', 'CmdOrCtrl+L', { id: 'focus-url' }),
        key('Jump anywhere', 'CmdOrCtrl+K', { id: 'palette' }),
        key('Toggle sidebar', 'CmdOrCtrl+\\', { id: 'toggle-sidebar' }),
        key('Go to board', 'CmdOrCtrl+Shift+H', { id: 'home' }),
        { type: 'separator' },
        key('Next tab', 'Ctrl+Tab', { id: 'next-tab' }),
        key('Previous tab', 'Ctrl+Shift+Tab', { id: 'prev-tab' }),
        ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => key(`Tab ${n}`, `CmdOrCtrl+${n}`, { id: `tab-${n}`, visible: false })),
        { type: 'separator' },
        key('Whiteboard / chalkboard', 'CmdOrCtrl+Shift+D', { id: 'theme' }),
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools', accelerator: 'CmdOrCtrl+Alt+I' },
        key('Open tab devtools', 'CmdOrCtrl+Alt+J', { id: 'tab-devtools' }),
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function hardenSessions() {
  const s = session.fromPartition(PARTITION);
  const ALLOW = new Set(['notifications', 'fullscreen', 'clipboard-sanitized-write', 'media', 'clipboard-read', 'display-capture']);
  s.setPermissionRequestHandler((_wc, permission, cb) => cb(ALLOW.has(permission)));
  s.setPermissionCheckHandler((_wc, permission) => ALLOW.has(permission));
  // Downloads go to the system Downloads folder with the save dialog; nothing custom needed.

  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-attach-webview', (_e, prefs, params) => {
      delete prefs.preload;
      delete prefs.preloadURL;
      prefs.nodeIntegration = false;
      prefs.contextIsolation = true;
      prefs.sandbox = true;
      params.partition = PARTITION;
    });
    // A page asking for a new window gets a tab instead.
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) {
        send('open-tab', { url });
        return { action: 'deny' };
      }
      if (/^(mailto|tel):/i.test(url)) {
        shell.openExternal(url);
        return { action: 'deny' };
      }
      // A blank popup is a placeholder the opener writes into afterwards. Denying it
      // hands the caller null and the flow dies with no error, so let it be a window.
      if (!url || url === 'about:blank') {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: { width: 980, height: 760, autoHideMenuBar: true, backgroundColor: '#ffffff' },
        };
      }
      return { action: 'deny' };
    });
    // Block navigation of the shell window itself away from the local board.
    contents.on('will-navigate', (e, url) => {
      if (contents === win?.webContents && !url.startsWith(`http://localhost:${PORT}`)) {
        e.preventDefault();
        send('open-tab', { url });
      }
    });
  });
}

async function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 900,
    minHeight: 600,
    title: 'Season',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 14, y: 16 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1b2420' : '#f8f9f7',
    webPreferences: {
      preload: path.join(HERE, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      spellcheck: true,
    },
  });
  win.on('closed', () => {
    terminals.killAll();
    win = null;
  });
  await win.loadURL(SHELL_URL);
}

/* Terminals. Only the app's own window may drive them. */
const fromWindow = (e) => win && !win.isDestroyed() && e.sender === win.webContents;

ipcMain.handle('term:create', (e, opts) => {
  if (!fromWindow(e)) throw new Error('refused');
  return terminals.create(opts || {});
});
ipcMain.handle('term:available', (e) => (fromWindow(e) ? { ok: terminals.available, reason: terminals.available ? '' : terminals.unavailableReason } : { ok: false, reason: 'refused' }));
ipcMain.on('term:write', (e, id, data) => { if (fromWindow(e)) terminals.write(String(id), String(data)); });
ipcMain.on('term:resize', (e, id, cols, rows) => { if (fromWindow(e)) terminals.resize(String(id), cols, rows); });
ipcMain.on('term:kill', (e, id) => { if (fromWindow(e)) terminals.kill(String(id)); });

ipcMain.handle('open-external', (_e, url) => {
  if (/^https?:/.test(String(url))) shell.openExternal(url);
});
ipcMain.handle('theme', (_e, mode) => {
  nativeTheme.themeSource = mode === 'dark' || mode === 'light' ? mode : 'system';
});

const sessionArgs = () => ({ app, safeStorage, session, partition: PARTITION });

let saving = null;
async function persistSignIns(reason) {
  if (saving) return saving;
  saving = saveSessionCookies(sessionArgs())
    .then((r) => { if (r.saved) console.log(`[sessions] kept ${r.saved} sign-in cookies (${reason})`); return r; })
    .catch((err) => console.error('[sessions]', err.message))
    .finally(() => { saving = null; });
  return saving;
}

app.whenReady().then(async () => {
  hardenSessions();
  buildMenu();
  const restored = await restoreSessionCookies(sessionArgs()).catch((err) => ({ restored: 0, reason: err.message }));
  if (restored.restored) console.log(`[sessions] restored ${restored.restored} sign-in cookies`);
  else if (restored.reason) console.log(`[sessions] starting signed out (${restored.reason})`);
  await startServer();
  await createWindow();
  setInterval(() => persistSignIns('periodic'), 5 * 60000);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

let quitting = false;
app.on('before-quit', async (e) => {
  terminals.killAll();
  if (quitting || !safeStorage.isEncryptionAvailable()) return;
  // Cookies have to be read before the session goes away, so hold the quit briefly.
  e.preventDefault();
  quitting = true;
  // Quitting must never hang on this; a lost sign-in is a nuisance, a stuck app is worse.
  await Promise.race([persistSignIns('quit'), new Promise((r) => setTimeout(r, 3000))]);
  app.quit();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
