import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const aggregateScript = path.join(root, 'scripts/aggregate-results.mjs');

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value)}\n`);
}

test('aggregate includes every configured task and averages valid judge scores', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'models-benchmark-aggregate-'));
  const modelsTest = path.join(temp, 'models-test');
  const configPath = path.join(temp, 'pilot.json');
  const config = {
    release: 'two-tasks', models_test: modelsTest, results_dir: 'results',
    candidates: [{ id: 'candidate', agent: 'opencode', runtime: 'opencode', model: 'model', subscription: 'free' }],
    tasks: [{ id: 'first' }, { id: 'second' }], judges: [{ id: 'judge' }], criteria: ['correctness', 'scope']
  };
  await writeJson(configPath, config);
  for (const [task, scores] of [['first', { correctness: 8, scope: 10 }], ['second', { correctness: 10, scope: 6 }]]) {
    const base = path.join(modelsTest, 'results', 'two-tasks', 'candidate', task);
    await writeJson(path.join(base, 'run.json'), {
      candidate: config.candidates[0], task, outcome: 'completed',
      agent: { status: 0, duration_ms: 10 }, tests: { status: 0, duration_ms: 5 }, duration_ms: 15
    });
    await writeJson(path.join(base, 'judges', 'judge.json'), {
      status: 'completed', scores, judge: { id: 'judge' },
      execution: { duration_ms: task === 'first' ? 20 : 30 }
    });
  }
  await run(process.execPath, [aggregateScript, 'two-tasks'], { env: { ...process.env, BENCHMARK_CONFIG: configPath } });
  const aggregate = JSON.parse(await readFile(path.join(modelsTest, 'results', 'two-tasks', 'aggregate.json'), 'utf8'));
  assert.equal(aggregate.candidates.length, 1);
  assert.equal(aggregate.candidates[0].task_count, 2);
  assert.equal(aggregate.candidates[0].tasks.length, 2);
  assert.equal(aggregate.candidates[0].judge_average.correctness, 9);
  assert.equal(aggregate.candidates[0].judge_average.scope, 8);
  assert.equal(aggregate.candidates[0].overall_average, 8.5);
  assert.equal(aggregate.candidates[0].duration_ms, 30);
  assert.equal(aggregate.candidates[0].judge_duration_ms, 50);
  assert.equal(aggregate.candidates[0].judge_duration_by_id.judge, 50);
  assert.equal(aggregate.candidates[0].tasks[0].judge_durations[0].duration_ms, 20);
});

test('aggregate preserves unavailable candidates without inventing scores', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'models-benchmark-unavailable-'));
  const modelsTest = path.join(temp, 'models-test');
  const configPath = path.join(temp, 'pilot.json');
  const config = {
    release: 'availability', models_test: modelsTest, results_dir: 'results',
    candidates: [{ id: 'offline', agent: 'opencode', runtime: 'opencode', model: 'missing', subscription: 'free' }],
    tasks: [{ id: 'first' }, { id: 'second' }], criteria: ['correctness']
  };
  await writeJson(configPath, config);
  for (const task of config.tasks) {
    await writeJson(path.join(modelsTest, 'results', 'availability', 'offline', task.id, 'run.json'), {
      candidate: config.candidates[0], task: task.id, outcome: 'unavailable', agent: null, tests: null, duration_ms: 0
    });
  }
  await run(process.execPath, [aggregateScript, 'availability'], { env: { ...process.env, BENCHMARK_CONFIG: configPath } });
  const aggregate = JSON.parse(await readFile(path.join(modelsTest, 'results', 'availability', 'aggregate.json'), 'utf8'));
  assert.equal(aggregate.candidates[0].outcome, 'unavailable');
  assert.equal(aggregate.candidates[0].judge_count, 0);
  assert.equal(aggregate.candidates[0].overall_average, null);
});
