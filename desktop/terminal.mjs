/**
 * Terminal sessions for the app.
 *
 * These run in the Electron main process and are reached over IPC, deliberately
 * not over the HTTP server: anything that can reach localhost:4747 would otherwise
 * be one request away from a shell. IPC is also ordered, so keystrokes cannot
 * arrive out of sequence.
 *
 * Each session is a real pseudo-terminal, so interactive programs — an editor, a
 * pager, a prompt that asks a question, anything that draws a full screen — behave
 * the way they do in a normal terminal.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let pty = null;
let ptyError = null;
try {
  pty = require('@lydell/node-pty');
} catch (err) {
  ptyError = err.message.split('\n')[0];
}

const IS_WIN = process.platform === 'win32';
const MAX_SESSIONS = 12;
const FLUSH_MS = 4; // coalesce bursts so a noisy command is not one IPC message per byte

/** The shell a person expects when they open a terminal on this machine. */
function defaultShell() {
  if (IS_WIN) return process.env.COMSPEC || 'powershell.exe';
  if (process.env.SHELL && fs.existsSync(process.env.SHELL)) return process.env.SHELL;
  for (const s of ['/bin/zsh', '/bin/bash', '/bin/sh']) if (fs.existsSync(s)) return s;
  return '/bin/sh';
}

/** Login shells read the profile, which is where PATH, nvm and aliases come from. */
function shellArgs(shell) {
  if (IS_WIN) return [];
  return /(^|\/)(zsh|bash)$/.test(shell) ? ['-l'] : [];
}

function safeCwd(requested) {
  const home = os.homedir();
  if (!requested) return home;
  const resolved = path.resolve(requested);
  // A terminal may go anywhere once it is open; this only decides where it starts.
  if (resolved !== home && !resolved.startsWith(home + path.sep)) return home;
  try {
    return fs.statSync(resolved).isDirectory() ? resolved : home;
  } catch {
    return home;
  }
}

export class Terminals {
  /**
   * @param {(channel: string, payload: any) => void} send delivers events to the window
   */
  constructor(send) {
    this.send = send;
    this.sessions = new Map();
    this.nextId = 1;
  }

  get available() {
    return !!pty;
  }
  get unavailableReason() {
    return ptyError || 'Terminals are only available in the Season app.';
  }

  create({ cwd, cols = 80, rows = 24 } = {}) {
    if (!pty) throw new Error(this.unavailableReason);
    if (this.sessions.size >= MAX_SESSIONS) throw new Error(`That is already ${MAX_SESSIONS} terminals. Close one first.`);

    const id = `t${this.nextId++}`;
    const dir = safeCwd(cwd);
    const shell = defaultShell();
    const proc = pty.spawn(shell, shellArgs(shell), {
      name: 'xterm-256color',
      cols: Math.max(2, Math.min(500, cols | 0)),
      rows: Math.max(1, Math.min(200, rows | 0)),
      cwd: dir,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        TERM_PROGRAM: 'Season',
        // Electron sets these for its own child processes; a shell should not inherit them.
        ELECTRON_RUN_AS_NODE: undefined,
        ELECTRON_NO_ATTACH_CONSOLE: undefined,
      },
    });

    const session = { id, proc, cwd: dir, buffer: '', timer: null, alive: true };
    this.sessions.set(id, session);

    proc.onData((chunk) => {
      session.buffer += chunk;
      if (session.timer) return;
      session.timer = setTimeout(() => {
        const data = session.buffer;
        session.buffer = '';
        session.timer = null;
        if (data) this.send('term:data', { id, data });
      }, FLUSH_MS);
    });

    proc.onExit(({ exitCode, signal }) => {
      if (session.timer) clearTimeout(session.timer);
      if (session.buffer) this.send('term:data', { id, data: session.buffer });
      session.alive = false;
      this.sessions.delete(id);
      this.send('term:exit', { id, exitCode, signal });
    });

    return { id, cwd: dir, shell: path.basename(shell) };
  }

  write(id, data) {
    const s = this.sessions.get(id);
    if (s?.alive && typeof data === 'string') s.proc.write(data);
  }

  resize(id, cols, rows) {
    const s = this.sessions.get(id);
    if (!s?.alive) return;
    try {
      s.proc.resize(Math.max(2, Math.min(500, cols | 0)), Math.max(1, Math.min(200, rows | 0)));
    } catch {
      // The process can exit between the check and the call; nothing to do.
    }
  }

  kill(id) {
    const s = this.sessions.get(id);
    if (!s?.alive) return;
    s.alive = false;
    try { s.proc.kill(); } catch {}
    this.sessions.delete(id);
  }

  killAll() {
    for (const id of [...this.sessions.keys()]) this.kill(id);
  }
}
