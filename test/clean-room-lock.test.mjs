import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { acquireCleanRoomLock, releaseCleanRoomLock, retainCleanRoomLock } from '../scripts/lib/clean-room-lock.mjs';

test('only one runner can acquire a clean-room lock at a time', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'models-benchmark-lock-'));
  const lockPath = path.join(temp, 'clean-room.lock');
  try {
    const first = await acquireCleanRoomLock(lockPath, { release: 'first' });
    await assert.rejects(acquireCleanRoomLock(lockPath, { release: 'second' }), /clean room is already in use/);
    await releaseCleanRoomLock(first);
    const second = await acquireCleanRoomLock(lockPath, { release: 'second' });
    await releaseCleanRoomLock(second);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('cleanup failure retains a stale lock with its reason', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'models-benchmark-lock-'));
  const lockPath = path.join(temp, 'clean-room.lock');
  try {
    const lock = await acquireCleanRoomLock(lockPath, { release: 'failed-release' });
    await retainCleanRoomLock(lock, new Error('final reset failed'));
    const owner = JSON.parse(await readFile(path.join(lockPath, 'owner.json'), 'utf8'));
    assert.equal(owner.stale, true);
    assert.match(owner.cleanup_failure, /final reset failed/);
    await assert.rejects(acquireCleanRoomLock(lockPath, { release: 'next-release' }), /clean room is already in use/);
    await releaseCleanRoomLock(lock);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('stale lock (dead PID) can be acquired by new runner', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'models-benchmark-lock-'));
  const lockPath = path.join(temp, 'clean-room.lock');
  try {
    // Create a lock with a non-existent PID and valid start_time
    await mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
    await mkdir(lockPath, { mode: 0o700 });
    const staleStartTime = Date.now() - 3600000; // 1 hour ago
    await writeFile(`${lockPath}/owner.json`, JSON.stringify({
      pid: 999999, // Non-existent PID
      start_time: staleStartTime,
      release: 'dead-release'
    }, null, 2));

    // Should be able to acquire the lock since PID doesn't exist
    const lock = await acquireCleanRoomLock(lockPath, { release: 'new-release' });
    const owner = JSON.parse(await readFile(`${lockPath}/owner.json`, 'utf8'));
    assert.equal(owner.release, 'new-release');
    await releaseCleanRoomLock(lock);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('malformed owner metadata blocks acquisition (fail-closed)', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'models-benchmark-lock-'));
  const lockPath = path.join(temp, 'clean-room.lock');
  try {
    // Create a lock with malformed owner.json
    await mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
    await mkdir(lockPath, { mode: 0o700 });
    await writeFile(`${lockPath}/owner.json`, 'not valid json');

    // Should fail to acquire lock - missing/invalid owner is not auto-recovered
    await assert.rejects(acquireCleanRoomLock(lockPath, { release: 'new-release' }),
      /owner metadata is missing or invalid/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('missing owner.json blocks acquisition (fail-closed)', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'models-benchmark-lock-'));
  const lockPath = path.join(temp, 'clean-room.lock');
  try {
    // Create lock directory but no owner.json
    await mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
    await mkdir(lockPath, { mode: 0o700 });

    // Should fail to acquire lock - missing owner is not auto-recovered
    await assert.rejects(acquireCleanRoomLock(lockPath, { release: 'new-release' }),
      /owner metadata is missing or invalid/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('lock owner includes start_time to prevent PID reuse', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'models-benchmark-lock-'));
  const lockPath = path.join(temp, 'clean-room.lock');
  try {
    const lock = await acquireCleanRoomLock(lockPath, { release: 'test-release' });
    const owner = JSON.parse(await readFile(`${lockPath}/owner.json`, 'utf8'));
    assert.ok(owner.pid, 'owner should have pid');
    assert.ok(typeof owner.start_time === 'number', 'owner should have start_time as number');
    assert.ok(owner.started_at, 'owner should have started_at');
    await releaseCleanRoomLock(lock);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});