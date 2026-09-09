/* Season desktop shell: a window that owns real browser tabs, with the board served by the local server. */
import { app, BrowserWindow, Menu, session, shell, ipcMain, nativeTheme } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4747);
const SHELL_URL = `http://localhost:${PORT}/shell.html`;
const PARTITION = 'persist:season';

app.setName('Season');

let win = null;

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
        key('Close tab', 'CmdOrCtrl+W', { id: 'close-tab' }),
        key('Reopen closed tab', 'CmdOrCtrl+Shift+T', { id: 'reopen-tab' }),
        { type: 'separator' },
        key('Open in default browser', 'CmdOrCtrl+Shift+O', { id: 'open-external' }),
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
    // Any page that tries to open a new window becomes a new tab instead.
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https?:|^about:blank/.test(url)) send('open-tab', { url });
      else if (/^mailto:|^tel:/.test(url)) shell.openExternal(url);
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
  win.on('closed', () => (win = null));
  await win.loadURL(SHELL_URL);
}

ipcMain.handle('open-external', (_e, url) => {
  if (/^https?:/.test(String(url))) shell.openExternal(url);
});
ipcMain.handle('theme', (_e, mode) => {
  nativeTheme.themeSource = mode === 'dark' || mode === 'light' ? mode : 'system';
});

app.whenReady().then(async () => {
  hardenSessions();
  buildMenu();
  await startServer();
  await createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
