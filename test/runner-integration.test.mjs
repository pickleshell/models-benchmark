import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runnerScript = path.join(root, 'scripts/run-pilot.mjs');

test('runner rejects an existing release before invoking a model', async () => {
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
    /release already exists/
  );
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
