#!/usr/bin/env node
/**
 * One-time sync setup. Safe to run on both machines: the first creates the private
 * repository, the second finds it and joins.
 *
 *   npm run sync:setup                 # owner/season-sync
 *   npm run sync:setup -- my-repo      # owner/my-repo
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { currentUser, ensureRepo, syncOnce, deviceInfo, SyncError } from '../lib/sync.mjs';
import { Store } from '../lib/store.mjs';
import { loadConfig } from '../lib/env.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CONFIG = path.join(ROOT, 'config.json');
const DATA = path.join(ROOT, 'data');

const say = (msg = '') => console.log(msg);
const fail = (msg, hint) => {
  console.error(`\n✗ ${msg}`);
  if (hint) console.error(`  ${hint}`);
  process.exit(1);
};

try {
  const name = (process.argv[2] || 'season-sync').replace(/^.*\//, '');
  say('Setting up sync…\n');

  const login = await currentUser().catch((err) => fail(err.message, err.hint));
  const repo = `${login}/${name}`;
  say(`  GitHub account   ${login}`);

  const { created } = await ensureRepo(repo);
  say(`  Repository       ${repo} ${created ? '(created, private)' : '(already there)'}`);

  const cfg = loadConfig(ROOT);
  const raw = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  raw.sync = { repo, auto: true };
  fs.writeFileSync(CONFIG, JSON.stringify(raw, null, 2) + '\n');
  cfg.sync = raw.sync;
  say(`  Saved to         config.json`);

  const store = new Store(DATA);
  const device = deviceInfo(DATA);
  store.noteSemester(cfg.semester);
  say(`  This machine     ${device.name}\n`);

  const res = await syncOnce({ repo, store, device, semester: cfg.semester });
  const others = Object.entries(res.devices || {}).filter(([id]) => id !== device.id);
  say(res.pushed ? '✓ Synced. This machine\'s tasks and spaces are now in the repo.' : '✓ Synced. Nothing needed sending.');
  if (others.length) say(`  Also syncing: ${others.map(([, d]) => d.name).join(', ')}`);

  say('\nOn your other computer:');
  say('  1. git clone https://github.com/ChickenPeep/season.git   (or git pull if you have it)');
  say('  2. npm install');
  say('  3. gh auth login          (GitHub CLI, from https://cli.github.com)');
  say(`  4. npm run sync:setup`);
  say('\nAfter that both machines sync on their own. The Sync button on Home forces it.');
} catch (err) {
  if (err instanceof SyncError) fail(err.message, err.hint);
  fail(err.message);
}
