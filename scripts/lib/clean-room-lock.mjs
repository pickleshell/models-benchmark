import { mkdir, readFile, rm, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const ownerFile = 'owner.json';
const START_TIME_TOLERANCE_MS = 100; // Allow small clock drift
const MAX_REACQUIRE_RETRIES = 5;

let clkTck = null;

function validateOwner(owner) {
  return (
    owner &&
    typeof owner === 'object' &&
    Number.isInteger(owner.pid) &&
    owner.pid > 0 &&
    Number.isFinite(owner.start_time) &&
    owner.start_time > 0
  );
}

function getClkTck() {
  if (clkTck !== null) return clkTck;
  try {
    // getconf CLK_TCK returns clock ticks per second
    const result = spawnSync('getconf', ['CLK_TCK'], { encoding: 'utf8' });
    if (result.status === 0 && result.stdout.trim()) {
      clkTck = parseInt(result.stdout.trim(), 10);
      if (clkTck > 0) return clkTck;
    }
  } catch {
    // fallback
  }
  clkTck = 100; // Linux default
  return clkTck;
}

function getProcessStartTime(pid) {
  try {
    const statPath = `/proc/${pid}/stat`;
    const stat = readFileSync(statPath, 'utf8');
    // Field 22 is starttime (clock ticks since boot)
    const fields = stat.split(' ');
    const startTimeTicks = parseInt(fields[21], 10);
    // Convert to boot time + start time using actual CLK_TCK
    const bootTime = Date.now() - os.uptime() * 1000;
    const clkTck = getClkTck();
    const startTime = bootTime + (startTimeTicks / clkTck) * 1000;
    return startTime;
  } catch {
    return null;
  }
}

async function isLockOwnerAlive(owner) {
  // Strict validation first
  if (!validateOwner(owner)) return false;

  try {
    // Check if process exists
    process.kill(owner.pid, 0);
  } catch (e) {
    if (e.code === 'ESRCH') return false; // Process doesn't exist
    if (e.code === 'EPERM') return true;  // Process exists but we can't signal it
    return false;
  }

  // Process exists, verify start time matches to prevent PID reuse false positives
  const actualStartTime = getProcessStartTime(owner.pid);
  if (actualStartTime !== null) {
    const diff = Math.abs(owner.start_time - actualStartTime);
    if (diff > START_TIME_TOLERANCE_MS) {
      return false; // PID reused by different process (start time mismatch beyond tolerance)
    }
  }

  return true;
}

export async function acquireCleanRoomLock(lockPath, metadata = {}) {
  await mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });

  // Fast path: try to create lock directory atomically
  try {
    await mkdir(lockPath, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;

    // Lock directory exists - check if stale
    for (let attempt = 0; attempt < MAX_REACQUIRE_RETRIES; attempt++) {
      let owner = null;
      try {
        const ownerContent = await readFile(`${lockPath}/${ownerFile}`, 'utf8');
        owner = JSON.parse(ownerContent);
      } catch {
        // owner.json missing or malformed - FAIL CLOSED
        // Do NOT auto-delete; require manual recovery
        throw new Error(`clean room lock exists but owner metadata is missing or invalid; ` +
          `inspect ${lockPath} before manual recovery`);
      }

      if (!validateOwner(owner)) {
        throw new Error(`clean room lock exists but owner metadata is incomplete; ` +
          `inspect ${lockPath} before manual recovery`);
      }

      const isAlive = await isLockOwnerAlive(owner);
      if (isAlive) {
        const holder = owner?.pid ? ` (pid ${owner.pid}, release ${owner.release ?? 'unknown'})` : '';
        throw new Error(`clean room is already in use${holder}; inspect ${lockPath} before manual recovery`);
      }

      // Stale lock (valid owner, but process dead/start_time mismatch)
      // Atomic reacquire: rename to quarantine, then create new lock
      const quarantinePath = `${lockPath}.stale.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
      try {
        await rename(lockPath, quarantinePath);
      } catch (renameError) {
        // Another process already renamed it - retry
        if (renameError.code === 'ENOENT' || renameError.code === 'ENOTDIR') {
          await new Promise(resolve => setTimeout(resolve, 10 * (attempt + 1)));
          continue;
        }
        throw renameError;
      }

      // We won the rename race - create new lock
      try {
        await mkdir(lockPath, { mode: 0o700 });
        // Clean up quarantine
        await rm(quarantinePath, { recursive: true, force: true }).catch(() => {});
        break; // Successfully reacquired
      } catch (mkdirError) {
        // If we can't create new lock, restore quarantine and retry
        await rename(quarantinePath, lockPath).catch(() => {});
        if (mkdirError?.code !== 'EEXIST') throw mkdirError;
        await new Promise(resolve => setTimeout(resolve, 10 * (attempt + 1)));
      }
    }
  }

  const startTime = getProcessStartTime(process.pid);
  const owner = {
    pid: process.pid,
    start_time: startTime,
    started_at: new Date().toISOString(),
    ...metadata
  };

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
  // Preserve all original owner fields (pid, start_time, started_at, release, etc.)
  await writeFile(ownerPath, `${JSON.stringify({
    ...owner,
    stale: true,
    cleanup_failed_at: new Date().toISOString(),
    cleanup_failure: String(reason?.message || reason || 'unknown cleanup failure')
  }, null, 2)}\n`, { mode: 0o600 });
}