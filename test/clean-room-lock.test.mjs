import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
