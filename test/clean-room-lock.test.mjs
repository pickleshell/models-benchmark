import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { acquireCleanRoomLock, releaseCleanRoomLock } from '../scripts/lib/clean-room-lock.mjs';

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
