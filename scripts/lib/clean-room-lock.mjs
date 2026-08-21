import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ownerFile = 'owner.json';

export async function acquireCleanRoomLock(lockPath, metadata = {}) {
  await mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  try {
    await mkdir(lockPath, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    let owner = null;
    try { owner = JSON.parse(await readFile(`${lockPath}/${ownerFile}`, 'utf8')); } catch {}
    const holder = owner?.pid ? ` (pid ${owner.pid}, release ${owner.release ?? 'unknown'})` : '';
    throw new Error(`clean room is already in use${holder}; inspect ${lockPath} before manual recovery`);
  }
  const owner = { pid: process.pid, started_at: new Date().toISOString(), ...metadata };
  try {
    await writeFile(`${lockPath}/${ownerFile}`, `${JSON.stringify(owner, null, 2)}\n`, { mode: 0o600 });
  } catch (error) {
    await rm(lockPath, { recursive: true, force: true });
    throw error;
  }
  return { path: lockPath };
}

export async function releaseCleanRoomLock(lock) {
  if (!lock?.path) return;
  await rm(lock.path, { recursive: true, force: true });
}

export async function retainCleanRoomLock(lock, reason) {
  if (!lock?.path) return;
  const ownerPath = `${lock.path}/${ownerFile}`;
  let owner = {};
  try { owner = JSON.parse(await readFile(ownerPath, 'utf8')); } catch {}
  await writeFile(ownerPath, `${JSON.stringify({
    ...owner,
    stale: true,
    cleanup_failed_at: new Date().toISOString(),
    cleanup_failure: String(reason?.message || reason || 'unknown cleanup failure')
  }, null, 2)}\n`, { mode: 0o600 });
}
