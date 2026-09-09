#!/usr/bin/env node
/**
 * Build a real macOS application bundle, so the Dock, the menu bar and Force Quit
 * show this app's name instead of "Electron".
 *
 * It copies the Electron runtime, renames it, gives it its own icon, identifier and
 * name, and points it back at this folder with a symlink. The code stays here and
 * stays editable — the bundle is a shell around it, not a copy of it. Change
 * `productName` in package.json and run this again to rename.
 *
 *   npm run install-app
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const NAME = pkg.productName || 'Season';
const ID = pkg.bundleId || `com.${(process.env.USER || 'local').replace(/[^a-z0-9]/gi, '')}.${NAME.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
const APPS = path.join(os.homedir(), 'Applications');
const DEST = path.join(APPS, `${NAME}.app`);
const MARKER = path.join(ROOT, 'data', 'installed-app.txt');

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'pipe', ...opts });
const plist = (file, key, value) => {
  try { sh('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, file]); }
  catch { sh('/usr/libexec/PlistBuddy', ['-c', `Add :${key} string ${value}`, file]); }
};

if (process.platform !== 'darwin') {
  console.log('This builds a macOS app bundle. On Windows and Linux, start the app with:  npm run app');
  process.exit(0);
}

const electronApp = path.join(ROOT, 'node_modules', 'electron', 'dist', 'Electron.app');
if (!fs.existsSync(electronApp)) {
  console.error('✗ Electron is not installed yet. Run: npm install');
  process.exit(1);
}

console.log(`Building ${NAME}.app…`);

// A previous build under a different name should not linger in Applications.
try {
  const old = fs.readFileSync(MARKER, 'utf8').trim();
  if (old && old !== DEST && fs.existsSync(old)) {
    fs.rmSync(old, { recursive: true, force: true });
    console.log(`  Removed  ${path.basename(old)}`);
  }
} catch {}

fs.mkdirSync(APPS, { recursive: true });
fs.rmSync(DEST, { recursive: true, force: true });
sh('cp', ['-R', electronApp, DEST]);
console.log('  Copied   the Electron runtime');

// Rename the executable so the process itself is named after the app.
const macos = path.join(DEST, 'Contents', 'MacOS');
fs.renameSync(path.join(macos, 'Electron'), path.join(macos, NAME));

const info = path.join(DEST, 'Contents', 'Info.plist');
plist(info, 'CFBundleExecutable', NAME);
plist(info, 'CFBundleName', NAME);
plist(info, 'CFBundleDisplayName', NAME);
plist(info, 'CFBundleIdentifier', ID);
plist(info, 'CFBundleIconFile', `${NAME}.icns`);
plist(info, 'CFBundleShortVersionString', pkg.version || '1.0.0');
plist(info, 'CFBundleVersion', pkg.version || '1.0.0');
console.log(`  Named    ${NAME} · ${ID}`);

// Icon: render the SVG once, then step it down to every size macOS asks for.
const iconSvg = path.join(ROOT, 'desktop', 'icon.svg');
const resources = path.join(DEST, 'Contents', 'Resources');
fs.rmSync(path.join(resources, 'electron.icns'), { force: true });
try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'season-icon-'));
  const iconset = path.join(tmp, 'icon.iconset');
  fs.mkdirSync(iconset);
  sh('qlmanage', ['-t', '-s', '1024', '-o', tmp, iconSvg]);
  const rendered = path.join(tmp, path.basename(iconSvg) + '.png');
  if (!fs.existsSync(rendered)) throw new Error('could not render the icon');
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const px = size * scale;
      const name = `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`;
      sh('sips', ['-z', String(px), String(px), rendered, '--out', path.join(iconset, name)]);
    }
  }
  sh('iconutil', ['-c', 'icns', iconset, '-o', path.join(resources, `${NAME}.icns`)]);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('  Icon     built from desktop/icon.svg');
} catch (err) {
  console.log(`  Icon     skipped (${err.message.split('\n')[0]})`);
}

// Point the bundle at this folder rather than copying the code into it, so editing
// the repo changes the app and config.json and data/ stay writable where they are.
const appLink = path.join(resources, 'app');
fs.rmSync(appLink, { recursive: true, force: true });
fs.symlinkSync(ROOT, appLink);
console.log(`  Linked   to ${ROOT}`);

// macOS refuses to launch a modified bundle unless it is signed again.
try {
  sh('codesign', ['--force', '--deep', '--sign', '-', DEST]);
  console.log('  Signed   (ad-hoc, local use)');
} catch (err) {
  console.log(`  Signing  failed: ${String(err.stderr || err).slice(0, 120)}`);
}

fs.mkdirSync(path.dirname(MARKER), { recursive: true });
fs.writeFileSync(MARKER, DEST);

console.log(`\n✓ ${DEST}`);
console.log('  Open it from Applications or Spotlight, and drag it to the Dock to keep it there.');
