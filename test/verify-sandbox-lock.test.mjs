import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const verifierScript = path.join(root, 'scripts', 'verify-sandbox.mjs');

test('sandbox verification uses the pilot clean-room lock', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'models-benchmark-verify-lock-'));
  try {
    const privateArtifacts = path.join(temp, 'private');
    const lockPath = path.join(privateArtifacts, 'clean-room.lock');
    await mkdir(lockPath, { recursive: true });
    // Use current process PID to simulate a live lock
    await writeFile(path.join(lockPath, 'owner.json'), JSON.stringify({
      pid: process.pid,
      start_time: Date.now(),
      release: 'active-pilot'
    }));
    const configPath = path.join(temp, 'pilot.json');
    await writeFile(configPath, JSON.stringify({
      release: 'verification',
      private_artifacts_dir: privateArtifacts,
      clean_room: { user: 'test', opencode_root: '/missing-runtime' }
    }));
    await assert.rejects(
      run(process.execPath, [verifierScript], { env: { ...process.env, BENCHMARK_CONFIG: configPath } }),
      /clean room is already in use/
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
