import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { getCurrentProcessStartTime } from './helpers/lock-helpers.js';

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runnerScript = path.join(root, 'scripts/run-pilot.mjs');

test('runner permits an existing release directory for staged invocation', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'models-benchmark-release-'));
  const modelsTest = path.join(temp, 'models-test');
  const results = path.join(modelsTest, 'results', 'immutable');
  const privateArtifacts = path.join(temp, 'private');
  await mkdir(results, { recursive: true });
  await mkdir(modelsTest, { recursive: true });
  const configPath = path.join(temp, 'pilot.json');
  await writeFile(configPath, JSON.stringify({
    release: 'immutable', models_test: modelsTest, results_dir: 'results', private_artifacts_dir: privateArtifacts,
    clean_room: {
      user: 'missing-user', home: path.join(temp, 'home'), opencode_root: path.join(temp, 'missing-runtime'),
      workspace: path.join(temp, 'workspace'), agent_home: path.join(temp, 'agent-home'), reset_script: path.join(temp, 'reset.mjs')
    },
    tasks: [], candidates: [], judges: [], criteria: []
  }));
  await assert.rejects(
    run(process.execPath, [runnerScript], { env: { ...process.env, BENCHMARK_CONFIG: configPath } }),
    /clean-room account not found/
  );
});

test('runner lock rejects a second release when live lock exists', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'models-benchmark-lock-boundary-'));
  const modelsTest = path.join(temp, 'models-test');
  const privateArtifacts = path.join(temp, 'private');
  const lockPath = path.join(privateArtifacts, 'clean-room.lock');
  const touched = path.join(temp, 'sudo-was-called');
  const fakeBin = path.join(temp, 'bin');
  await mkdir(modelsTest, { recursive: true });
  await mkdir(lockPath, { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  // Use current process PID and actual start time to simulate a live lock
  const currentStartTime = getCurrentProcessStartTime();
  await writeFile(path.join(lockPath, 'owner.json'), JSON.stringify({
    pid: process.pid,
    start_time: currentStartTime,
    release: 'first'
  }));
  await writeFile(path.join(fakeBin, 'sudo'), `#!/bin/sh\ntouch ${touched}\nexit 99\n`, { mode: 0o755 });
  const configPath = path.join(temp, 'pilot.json');
  await writeFile(configPath, JSON.stringify({
    release: 'second', models_test: modelsTest, results_dir: 'results', private_artifacts_dir: privateArtifacts,
    clean_room: {
      user: 'test', home: path.join(temp, 'home'), opencode_root: path.join(temp, 'runtime'),
      workspace: path.join(temp, 'workspace'), agent_home: path.join(temp, 'agent-home'), reset_script: path.join(temp, 'reset.mjs')
    },
    tasks: [{ id: 'task' }], candidates: [], judges: [], criteria: []
  }));
  await assert.rejects(
    run(process.execPath, [runnerScript], { env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, BENCHMARK_CONFIG: configPath } }),
    /clean room is already in use/
  );
  assert.equal(existsSync(touched), false);
  assert.equal(existsSync(path.join(modelsTest, 'results', 'second')), false);
});

test('runner can acquire stale lock (dead PID)', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'models-benchmark-stale-lock-'));
  const modelsTest = path.join(temp, 'models-test');
  const privateArtifacts = path.join(temp, 'private');
  const lockPath = path.join(privateArtifacts, 'clean-room.lock');
  const touched = path.join(temp, 'sudo-was-called');
  const fakeBin = path.join(temp, 'bin');
  await mkdir(modelsTest, { recursive: true });
  await mkdir(lockPath, { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  // Use a non-existent PID with valid start_time to simulate a stale lock
  const staleStartTime = Date.now() - 3600000; // 1 hour ago
  await writeFile(path.join(lockPath, 'owner.json'), JSON.stringify({ pid: 999999, start_time: staleStartTime, release: 'dead-release' }));
  await writeFile(path.join(fakeBin, 'sudo'), `#!/bin/sh\ntouch ${touched}\nexit 99\n`, { mode: 0o755 });
  const configPath = path.join(temp, 'pilot.json');
  await writeFile(configPath, JSON.stringify({
    release: 'stale-acquire', models_test: modelsTest, results_dir: 'results', private_artifacts_dir: privateArtifacts,
    clean_room: {
      user: 'test', home: path.join(temp, 'home'), opencode_root: path.join(temp, 'runtime'),
      workspace: path.join(temp, 'workspace'), agent_home: path.join(temp, 'agent-home'), reset_script: path.join(temp, 'reset.mjs')
    },
    tasks: [{ id: 'task' }], candidates: [], judges: [], criteria: []
  }));
  // With stale lock, runner should acquire lock and proceed (then fail at OpenCode runtime check)
  await assert.rejects(
    run(process.execPath, [runnerScript], { env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, BENCHMARK_CONFIG: configPath } }),
    /OpenCode runtime root not found/
  );
  // Lock was acquired (runner proceeded past lock acquisition)
  // Note: sudo may or may not have been called depending on when preflight checks run
});

test('runner refuses to start while the clean-room account has a process', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'models-benchmark-active-user-'));
  const modelsTest = path.join(temp, 'models-test');
  const privateArtifacts = path.join(temp, 'private');
  const fakeBin = path.join(temp, 'bin');
  const touched = path.join(temp, 'sudo-was-called');
  await mkdir(modelsTest, { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  await writeFile(path.join(fakeBin, 'pgrep'), '#!/bin/sh\necho "4242 sleep 60"\nexit 0\n', { mode: 0o755 });
  await writeFile(path.join(fakeBin, 'sudo'), `#!/bin/sh\ntouch ${touched}\nexit 99\n`, { mode: 0o755 });
  const configPath = path.join(temp, 'pilot.json');
  await writeFile(configPath, JSON.stringify({
    release: 'active-user', models_test: modelsTest, results_dir: 'results', private_artifacts_dir: privateArtifacts,
    clean_room: {
      user: 'test', home: path.join(temp, 'home'), opencode_root: path.join(temp, 'runtime'),
      workspace: path.join(temp, 'workspace'), agent_home: path.join(temp, 'agent-home'), reset_script: path.join(temp, 'reset.mjs')
    },
    tasks: [{ id: 'task' }], candidates: [], judges: [], criteria: []
  }));
  await assert.rejects(
    run(process.execPath, [runnerScript], { env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, BENCHMARK_CONFIG: configPath } }),
    /clean-room account test is active/
  );
  assert.equal(existsSync(touched), false);
  assert.equal(existsSync(path.join(modelsTest, 'results', 'active-user')), false);
  assert.equal(existsSync(path.join(privateArtifacts, 'clean-room.lock')), false);
});

test('intent-to-add makes an untracked solution file part of the binary diff', async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'models-benchmark-diff-'));
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.name', 'test');
  git('config', 'user.email', 'test@example.invalid');
  await writeFile(path.join(repo, 'tracked.txt'), 'baseline\n');
  git('add', '.');
  git('commit', '-qm', 'baseline');
  await writeFile(path.join(repo, 'new-module.js'), 'export const value = 1;\n');
  git('add', '--intent-to-add', '--', '.');
  const diff = git('diff', '--binary', 'HEAD', '--');
  assert.match(diff, /new-module\.js/);
  assert.match(diff, /export const value = 1/);
});
