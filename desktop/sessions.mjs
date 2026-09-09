/**
 * Keeping you signed in.
 *
 * Canvas, campus SSO and most other sites hand out *session* cookies: cookies with
 * no expiry date, which a browser is expected to forget when it closes. Chromium
 * writes the dated ones to disk and drops the rest, so every launch started signed
 * out. This is the same thing a browser's "continue where you left off" does: hold
 * the undated cookies over a restart and put them back as they were.
 *
 * They are login credentials, so they are encrypted with the OS keychain through
 * Electron's safeStorage. If that is unavailable this saves nothing at all rather
 * than leaving auth cookies in a readable file.
 */
import fs from 'node:fs';
import path from 'node:path';

const FILE = 'saved-sessions.bin';

const fileFor = (app) => path.join(app.getPath('userData'), FILE);

/** Rebuild the address a cookie belongs to, which is what cookies.set works from. */
function urlFor(c) {
  const host = c.domain.replace(/^\./, '');
  return `${c.secure ? 'https' : 'http'}://${host}${c.path || '/'}`;
}

export async function saveSessionCookies({ app, safeStorage, session, partition }) {
  if (!safeStorage.isEncryptionAvailable()) return { saved: 0, reason: 'no keychain' };
  const cookies = await session.fromPartition(partition).cookies.get({});
  // Only the undated ones need help; Chromium already persists the rest.
  const transient = cookies
    .filter((c) => c.session === true || c.expirationDate === undefined)
    .map((c) => ({
      url: urlFor(c),
      name: c.name,
      value: c.value,
      path: c.path,
      secure: !!c.secure,
      httpOnly: !!c.httpOnly,
      sameSite: c.sameSite || 'unspecified',
      // A leading dot means the cookie covers subdomains; without it it is host-only,
      // and passing a domain would silently widen it.
      domain: c.domain.startsWith('.') ? c.domain : undefined,
    }));
  if (!transient.length) {
    fs.rmSync(fileFor(app), { force: true });
    return { saved: 0 };
  }
  const blob = safeStorage.encryptString(JSON.stringify({ v: 1, at: Date.now(), cookies: transient }));
  fs.writeFileSync(fileFor(app), blob, { mode: 0o600 });
  return { saved: transient.length };
}

export async function restoreSessionCookies({ app, safeStorage, session, partition, maxAgeDays = 30 }) {
  const file = fileFor(app);
  if (!fs.existsSync(file) || !safeStorage.isEncryptionAvailable()) return { restored: 0 };
  let payload;
  try {
    payload = JSON.parse(safeStorage.decryptString(fs.readFileSync(file)));
  } catch {
    fs.rmSync(file, { force: true }); // unreadable, e.g. a different machine or keychain
    return { restored: 0, reason: 'could not decrypt' };
  }
  // A sign-in left alone for a month should be asked for again.
  if (!payload?.cookies || Date.now() - (payload.at || 0) > maxAgeDays * 86400000) {
    fs.rmSync(file, { force: true });
    return { restored: 0, reason: 'too old' };
  }
  const jar = session.fromPartition(partition).cookies;
  let restored = 0;
  for (const c of payload.cookies) {
    try {
      // No expirationDate, so these go back as session cookies — exactly what they were.
      await jar.set({ ...c, domain: c.domain || undefined });
      restored += 1;
    } catch {
      // A cookie the browser now rejects (a changed policy, a bad domain) is simply skipped.
    }
  }
  return { restored };
}

export function clearSavedSessions({ app, session, partition }) {
  fs.rmSync(fileFor(app), { force: true });
  return session.fromPartition(partition).clearStorageData({ storages: ['cookies'] });
}
