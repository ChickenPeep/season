import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { Terminals } from '../desktop/terminal.mjs';

// A plain shell keeps these tests quick and independent of a personal profile.
process.env.SHELL = '/bin/sh';

/**
 * Collect output for one session until `match` appears, or time out.
 * A terminal echoes what you type, so a matcher must be something the command's
 * OUTPUT contains and its text does not — otherwise it fires on the echo.
 */
function waitFor(events, id, match, ms = 8000) {
  const test = match instanceof RegExp ? (s) => match.test(s) : (s) => s.includes(match);
  return new Promise((resolve, reject) => {
    let seen = '';
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${match}; saw: ${JSON.stringify(seen.slice(-300))}`)), ms);
    events.on = (channel, payload) => {
      if (channel !== 'term:data' || payload.id !== id) return;
      seen += payload.data;
      if (test(seen)) {
        clearTimeout(timer);
        resolve(seen);
      }
    };
  });
}

function harness() {
  const events = { on: () => {} };
  const terms = new Terminals((channel, payload) => events.on(channel, payload));
  return { terms, events };
}

test('a session starts a real shell and streams its output', async (t) => {
  const { terms, events } = harness();
  if (!terms.available) return t.skip(terms.unavailableReason);
  const { id, cwd, shell } = terms.create({ cols: 80, rows: 24 });
  t.after(() => terms.killAll());

  assert.ok(id);
  assert.equal(cwd, os.homedir());
  assert.equal(shell, 'sh');

  const done = waitFor(events, id, 'HELLO-FROM-PTY');
  terms.write(id, 'echo HELLO-FROM-PTY\n');
  const out = await done;
  assert.match(out, /HELLO-FROM-PTY/);
});

test('it is a terminal, not a pipe, so programs behave interactively', async (t) => {
  const { terms, events } = harness();
  if (!terms.available) return t.skip(terms.unavailableReason);
  const { id } = terms.create({ cols: 80, rows: 24 });
  t.after(() => terms.killAll());

  const done = waitFor(events, id, 'ISATTY=');
  terms.write(id, 'if [ -t 0 ]; then echo ISATTY=yes; else echo ISATTY=no; fi\n');
  const out = await done;
  assert.match(out, /ISATTY=yes/, 'stdin must be a tty or interactive programs break');
});

test('resizing tells the shell how wide it is', async (t) => {
  const { terms, events } = harness();
  if (!terms.available) return t.skip(terms.unavailableReason);
  const { id } = terms.create({ cols: 80, rows: 24 });
  t.after(() => terms.killAll());

  terms.resize(id, 132, 42);
  // The literal "%s" in the command means the echo cannot be mistaken for the answer.
  const done = waitFor(events, id, /SIZE=\d+x\d+/);
  terms.write(id, 'printf "SIZE=%sx%s\\n" "$(tput cols)" "$(tput lines)"\n');
  const out = await done;
  assert.match(out, /SIZE=132x42/);
});

test('a session starts in a requested folder inside home', async (t) => {
  const { terms } = harness();
  if (!terms.available) return t.skip(terms.unavailableReason);
  t.after(() => terms.killAll());
  const { cwd } = terms.create({ cwd: path.join(os.homedir(), 'Developer') });
  assert.equal(cwd, path.join(os.homedir(), 'Developer'));
});

test('a starting folder outside home, or one that does not exist, falls back to home', async (t) => {
  const { terms } = harness();
  if (!terms.available) return t.skip(terms.unavailableReason);
  t.after(() => terms.killAll());
  assert.equal(terms.create({ cwd: '/etc' }).cwd, os.homedir());
  assert.equal(terms.create({ cwd: path.join(os.homedir(), 'no-such-folder-here') }).cwd, os.homedir());
  assert.equal(terms.create({ cwd: '../../..' }).cwd, os.homedir());
});

test('closing a session ends its process and reports the exit', async (t) => {
  const { terms, events } = harness();
  if (!terms.available) return t.skip(terms.unavailableReason);
  const { id } = terms.create({});
  const exited = new Promise((resolve) => {
    const prev = events.on;
    events.on = (channel, payload) => {
      prev?.(channel, payload);
      if (channel === 'term:exit' && payload.id === id) resolve(payload);
    };
  });
  terms.write(id, 'exit\n');
  const payload = await exited;
  assert.equal(payload.id, id);
  assert.equal(terms.sessions.size, 0, 'the session is forgotten once it exits');
});

test('killAll leaves nothing running', async (t) => {
  const { terms } = harness();
  if (!terms.available) return t.skip(terms.unavailableReason);
  terms.create({});
  terms.create({});
  assert.equal(terms.sessions.size, 2);
  terms.killAll();
  assert.equal(terms.sessions.size, 0);
});

test('there is a ceiling on how many shells can be open at once', async (t) => {
  const { terms } = harness();
  if (!terms.available) return t.skip(terms.unavailableReason);
  t.after(() => terms.killAll());
  for (let i = 0; i < 12; i++) terms.create({});
  assert.throws(() => terms.create({}), /already 12 terminals/);
});

test('writing to a session that has gone is ignored rather than throwing', async (t) => {
  const { terms } = harness();
  if (!terms.available) return t.skip(terms.unavailableReason);
  terms.write('nope', 'echo hi\n');
  terms.resize('nope', 80, 24);
  terms.kill('nope');
});
