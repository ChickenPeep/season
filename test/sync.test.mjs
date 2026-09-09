import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mergeTasks, mergeDoneMarks, mergeStamped, mergeDocs, docFromState, stateFromDoc, emptyDoc } from '../lib/sync.mjs';
import { Store } from '../lib/store.mjs';

const T = (id, extra = {}) => ({ id, title: id, date: '2026-09-10', done: false, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', ...extra });

test('a task edited on one machine beats the older copy on the other', () => {
  const mac = [T('a', { title: 'renamed', updatedAt: '2026-09-08T10:00:00.000Z' })];
  const win = [T('a', { title: 'original', updatedAt: '2026-09-08T09:00:00.000Z' })];
  assert.equal(mergeTasks(mac, win)[0].title, 'renamed');
  assert.equal(mergeTasks(win, mac)[0].title, 'renamed', 'merge order must not change the result');
});

test('tasks added on different machines both survive', () => {
  const merged = mergeTasks([T('mac-only')], [T('win-only')]);
  assert.deepEqual(merged.map((t) => t.id).sort(), ['mac-only', 'win-only']);
});

test('a delete travels, and does not resurrect the older copy', () => {
  const deleted = [T('a', { deletedAt: '2026-09-08T12:00:00.000Z' })];
  const stale = [T('a', { updatedAt: '2026-09-08T11:00:00.000Z' })];
  const merged = mergeTasks(stale, deleted);
  assert.equal(merged.length, 1);
  assert.ok(merged[0].deletedAt, 'the tombstone wins over the older edit');
});

test('an edit made after a delete brings the task back', () => {
  const deleted = [T('a', { deletedAt: '2026-09-08T10:00:00.000Z' })];
  const edited = [T('a', { title: 'back', updatedAt: '2026-09-08T13:00:00.000Z' })];
  const merged = mergeTasks(deleted, edited);
  assert.equal(merged[0].title, 'back');
  assert.ok(!merged[0].deletedAt);
});

test('very old tombstones are forgotten so the file does not grow forever', () => {
  const old = new Date(Date.now() - 200 * 86400000).toISOString();
  assert.equal(mergeTasks([T('a', { deletedAt: old })], []).length, 0);
});

test('the newest click on a deadline wins in both directions', () => {
  const checked = { 'quiz:1': { done: true, at: '2026-09-08T10:00:00.000Z' } };
  const unchecked = { 'quiz:1': { done: false, at: '2026-09-08T11:00:00.000Z' } };
  assert.equal(mergeDoneMarks(checked, unchecked)['quiz:1'].done, false);
  assert.equal(mergeDoneMarks(unchecked, checked)['quiz:1'].done, false);
  const later = { 'quiz:1': { done: true, at: '2026-09-08T12:00:00.000Z' } };
  assert.equal(mergeDoneMarks(unchecked, later)['quiz:1'].done, true);
});

test('single values move as a unit, newest wins', () => {
  const a = { updatedAt: '2026-09-08T10:00:00.000Z', value: 'old' };
  const b = { updatedAt: '2026-09-09T10:00:00.000Z', value: 'new' };
  assert.equal(mergeStamped(a, b).value, 'new');
  assert.equal(mergeStamped(b, a).value, 'new');
  assert.equal(mergeStamped(null, b).value, 'new');
  assert.equal(mergeStamped(a, null).value, 'old');
});

test('merging a document is order-independent', () => {
  const mac = { ...emptyDoc(), tasks: [T('a', { updatedAt: '2026-09-08T10:00:00.000Z' })], doneMarks: { x: { done: true, at: '2026-09-08T10:00:00.000Z' } } };
  const win = { ...emptyDoc(), tasks: [T('b')], doneMarks: { x: { done: false, at: '2026-09-08T11:00:00.000Z' } } };
  const one = mergeDocs(mac, win);
  const two = mergeDocs(win, mac);
  assert.deepEqual(one.tasks.map((t) => t.id).sort(), two.tasks.map((t) => t.id).sort());
  assert.equal(one.doneMarks.x.done, two.doneMarks.x.done);
});

test('spaces sync but this machine keeps where its own tabs were left', () => {
  const local = { shell: { folders: [{ id: 'f', tabs: [{ id: 't1', title: 'Canvas', url: 'https://c.edu', lastUrl: 'https://c.edu/courses/9' }] }], today: [{ id: 'loose' }], activeId: 't1' } };
  const doc = { spaces: { updatedAt: '2026-09-09T00:00:00.000Z', version: 2, folders: [{ id: 'f', tabs: [{ id: 't1', title: 'Canvas', url: 'https://c.edu' }, { id: 't2', title: 'New', url: 'https://x.dev' }] }] } };
  const next = stateFromDoc(local, doc);
  assert.equal(next.shell.folders[0].tabs.length, 2, 'a tab pinned elsewhere arrives');
  assert.equal(next.shell.folders[0].tabs[0].lastUrl, 'https://c.edu/courses/9', 'this machine keeps its own last page');
  assert.equal(next.shell.today.length, 1, 'loose tabs stay local');
  assert.equal(next.shell.activeId, 't1', 'the open tab is not changed by a sync');
});

test('a document built from state carries no per-machine tab state', () => {
  const doc = docFromState({ tasks: [], doneMarks: {}, shell: { version: 2, folders: [{ id: 'f', tabs: [{ id: 't', title: 'A', url: 'https://a.dev', lastUrl: 'https://a.dev/deep' }] }], today: [{ id: 'loose' }], activeId: 't' }, shellUpdatedAt: '2026-09-09T00:00:00.000Z' });
  assert.equal(doc.spaces.folders[0].tabs[0].lastUrl, undefined);
  assert.equal(doc.spaces.today, undefined);
});

/* ---- the store's timestamping, which the merge depends on ---- */

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'season-sync-'));
  return { store: new Store(dir), dir };
}

test('the store stamps new, changed and deleted tasks', async () => {
  const { store, dir } = tmpStore();
  store.patch({ tasks: [{ id: 'a', title: 'write essay', date: '2026-09-10', done: false }] });
  const first = store.read().tasks[0];
  assert.ok(first.updatedAt && first.createdAt);

  await new Promise((r) => setTimeout(r, 5));
  store.patch({ tasks: [{ id: 'a', title: 'write essay', date: '2026-09-10', done: true }] });
  assert.ok(store.read().tasks[0].updatedAt > first.updatedAt, 'checking it off is an edit');

  const unchanged = store.read().tasks[0].updatedAt;
  await new Promise((r) => setTimeout(r, 5));
  store.patch({ tasks: [{ id: 'a', title: 'write essay', date: '2026-09-10', done: true }] });
  assert.equal(store.read().tasks[0].updatedAt, unchanged, 'saving the same thing is not an edit');

  store.patch({ tasks: [] });
  const raw = store.read().tasks;
  assert.equal(raw.length, 1, 'the record stays as a tombstone');
  assert.ok(raw[0].deletedAt);
  assert.equal(store.view().tasks.length, 0, 'but the client never sees it');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the store turns checked deadlines into timestamped marks and back', () => {
  const { store, dir } = tmpStore();
  store.patch({ doneItems: ['quiz:1', 'quiz:2'] });
  assert.equal(store.read().doneMarks['quiz:1'].done, true);
  assert.deepEqual(store.view().doneItems.sort(), ['quiz:1', 'quiz:2']);
  store.patch({ doneItems: ['quiz:2'] });
  assert.equal(store.read().doneMarks['quiz:1'].done, false, 'unchecking is recorded, not erased');
  assert.deepEqual(store.view().doneItems, ['quiz:2']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an older state file with a plain doneItems list is adopted', () => {
  const { store, dir } = tmpStore();
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ tasks: [], doneItems: ['quiz:9'] }));
  assert.equal(store.read().doneMarks['quiz:9'].done, true);
  assert.deepEqual(store.view().doneItems, ['quiz:9']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('opening a tab does not count as a change to shared spaces', () => {
  const { store, dir } = tmpStore();
  const shell = { folders: [{ id: 'f', name: 'School', tabs: [{ id: 't', title: 'Canvas', url: 'https://c.edu' }] }], today: [], activeId: 't' };
  store.patch({ shell });
  const stamp = store.read().shellUpdatedAt;
  store.patch({ shell: { ...shell, activeId: 'other', today: [{ id: 'loose', title: 'x', url: 'https://x.dev' }] } });
  assert.equal(store.read().shellUpdatedAt, stamp, 'browsing is not a shared edit');
  store.patch({ shell: { ...shell, folders: [{ ...shell.folders[0], tabs: [...shell.folders[0].tabs, { id: 't2', title: 'New', url: 'https://n.dev' }] }] } });
  assert.ok(store.read().shellUpdatedAt > stamp, 'pinning a tab is');
  fs.rmSync(dir, { recursive: true, force: true });
});
