import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { computeArtifactHash, computeFileHash } from '../scripts/lib/artifact-hash.mjs';

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
      agent: { status: 0, duration_ms: 10, usage: { source: 'opencode_step_finish', reported_cost_usd: task === 'first' ? 0.01 : 0.02 } }, tests: { status: 0, duration_ms: 5 }, duration_ms: 15
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
  assert.equal(aggregate.candidates[0].cost_usd, 0.03);
  assert.equal(aggregate.candidates[0].tasks[0].cost_usd, 0.01);
  assert.equal(aggregate.candidates[0].judge_duration_ms, 50);
  assert.equal(aggregate.candidates[0].judge_duration_by_id.judge, 50);
  assert.equal(aggregate.candidates[0].tasks[0].judge_durations[0].duration_ms, 20);
  const markdown = await readFile(path.join(modelsTest, 'results', 'two-tasks', 'aggregate.md'), 'utf8');
  assert.match(markdown, /Test time \| Test price \(USD\)/);
  assert.match(markdown, /0\.030000/);
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
  const markdown = await readFile(path.join(modelsTest, 'results', 'availability', 'aggregate.md'), 'utf8');
  assert.doesNotMatch(markdown, /Objective \|\s+\| Combined average/);
});

test('aggregate ignores stale judge files and reports partial configured coverage', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'models-benchmark-partial-'));
  const modelsTest = path.join(temp, 'models-test');
  const configPath = path.join(temp, 'pilot.json');
  const config = {
    release: 'partial', models_test: modelsTest, results_dir: 'results',
    candidates: [{ id: 'candidate', agent: 'opencode', model: 'model' }], tasks: [{ id: 'task' }],
    judges: [{ id: 'judge-a' }, { id: 'judge-b' }], criteria: ['correctness']
  };
  await writeJson(configPath, config);
  const base = path.join(modelsTest, 'results', 'partial', 'candidate', 'task');
  await writeJson(path.join(base, 'run.json'), { candidate: config.candidates[0], task: 'task', outcome: 'completed', agent: { status: 0 }, tests: { status: 0 } });
  await writeJson(path.join(base, 'judges', 'judge-a.json'), { status: 'completed', scores: { correctness: 8 }, judge: { id: 'judge-a' }, execution: { duration_ms: 20 } });
  await writeJson(path.join(base, 'judges', 'stale.json'), { status: 'completed', scores: { correctness: 1 }, judge: { id: 'stale' }, execution: { duration_ms: 20 } });
  await run(process.execPath, [aggregateScript, 'partial'], { env: { ...process.env, BENCHMARK_CONFIG: configPath } });
  const aggregate = JSON.parse(await readFile(path.join(modelsTest, 'results', 'partial', 'aggregate.json'), 'utf8'));
  assert.equal(aggregate.candidates[0].judge_average_by_id['judge-a'], 8);
  assert.equal(aggregate.candidates[0].judge_average_by_id['judge-b'], null);
  assert.equal(aggregate.candidates[0].overall_average, 8);
  const markdown = await readFile(path.join(modelsTest, 'results', 'partial', 'aggregate.md'), 'utf8');
  assert.match(markdown, /Judge: judge-a/);
  assert.match(markdown, /Judge: judge-b/);
  assert.match(markdown, /\| 8\.00 \| N\/A \| 8\.00 \|/);
});

test('aggregate reports verified objective results independently from judge averages', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'models-benchmark-objective-'));
  const modelsTest = path.join(temp, 'models-test');
  const configPath = path.join(temp, 'pilot.json');
  const config = { release: 'objective', models_test: modelsTest, results_dir: 'results', candidates: [{ id: 'candidate', agent: 'opencode', model: 'model' }], tasks: [{ id: 'task' }], judges: [], criteria: ['correctness'] };
  await writeJson(configPath, config);
  const base = path.join(modelsTest, 'results', 'objective', 'candidate', 'task');
  const objective = { schema_version: 1, evaluator: { id: 'private-evaluator', sha256: 'abc' }, status: 'completed', passed: true };
  objective.artifact_hash = { path: 'objective-evaluator.json', sha256: computeArtifactHash(objective) };
  await writeJson(path.join(base, 'objective-evaluator.json'), objective);
  const objectiveHash = await computeFileHash(path.join(base, 'objective-evaluator.json'));
  await writeJson(path.join(base, 'run.json'), { candidate: config.candidates[0], task: 'task', outcome: 'completed', agent: { status: 0 }, tests: { status: 0 }, artifacts: { objective_evaluator: { path: 'objective-evaluator.json', sha256: objectiveHash } } });
  await run(process.execPath, [aggregateScript, 'objective'], { env: { ...process.env, BENCHMARK_CONFIG: configPath } });
  const aggregate = JSON.parse(await readFile(path.join(modelsTest, 'results', 'objective', 'aggregate.json'), 'utf8'));
  assert.equal(aggregate.candidates[0].objective_pass_count, 1);
  assert.equal(aggregate.candidates[0].objective_total, 1);
  assert.equal(aggregate.candidates[0].objective_pass_rate, 1);
  assert.equal(aggregate.candidates[0].overall_average, null);
  assert.match(await readFile(path.join(modelsTest, 'results', 'objective', 'aggregate.md'), 'utf8'), /1\/1 \(100%\)/);
});

test('aggregate selects only the release canonical attempt and rejects a judge artifact from another attempt', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'models-benchmark-attempt-aggregate-'));
  const modelsTest = path.join(temp, 'models-test'); const configPath = path.join(temp, 'benchmark.json');
  const config = {
    release: 'attempt-release', models_test: modelsTest, results_dir: 'results', strict_artifacts: true,
    retry_policy: { canonical_attempt: 1, allow_retries: true },
    artifact_schemas: { run: 1, judge: 1, preflight: 1, aggregate: 2, test_result: 1, candidate_diff: 1, objective_evaluator: 1 },
    candidates: [{ id: 'model-a', agent: 'test', model: 'test/a' }], nominations: [{ id: 'nomination-a' }], judges: [{ id: 'judge-a' }], criteria: ['correctness']
  };
  const base = path.join(modelsTest, 'results', config.release, 'model-a', 'nomination-a', 'attempts');
  const signed = (artifact, artifactPath) => ({ ...artifact, artifact_hash: { path: artifactPath, sha256: computeArtifactHash(artifact) } });
  for (const [attempt, score] of [[1, 2], [2, 10]]) {
    const runArtifact = signed({ schema_version: 1, release: config.release, nomination: 'nomination-a', run_id: 'attempt-release:model-a:nomination-a', attempt, candidate: config.candidates[0], outcome: 'completed', agent: { status: 0 }, tests: { status: 0 } }, 'run.json');
    const judgeArtifact = signed({ schema_version: 1, judge: { id: 'judge-a' }, status: 'completed', candidate: 'model-a', nomination: 'nomination-a', run_id: 'attempt-release:model-a:nomination-a', attempt, scores: { correctness: score }, execution: { duration_ms: 1 } }, 'judge-a.json');
    await writeJson(path.join(base, `attempt-${attempt}`, 'run.json'), runArtifact);
    await writeJson(path.join(base, `attempt-${attempt}`, 'judges', 'judge-a.json'), judgeArtifact);
  }
  await writeJson(configPath, config);
  await run(process.execPath, [aggregateScript, config.release], { env: { ...process.env, BENCHMARK_CONFIG: configPath } });
  const aggregate = JSON.parse(await readFile(path.join(modelsTest, 'results', config.release, 'aggregate.json'), 'utf8'));
  assert.equal(aggregate.candidates[0].overall_average, 2);
  assert.equal(aggregate.candidates[0].nominations[0].attempt, 1);
  const mixed = signed({ schema_version: 1, judge: { id: 'judge-a' }, status: 'completed', candidate: 'model-a', nomination: 'nomination-a', run_id: 'attempt-release:model-a:nomination-a', attempt: 2, scores: { correctness: 10 }, execution: { duration_ms: 1 } }, 'judge-a.json');
  await writeJson(path.join(base, 'attempt-1', 'judges', 'judge-a.json'), mixed);
  await assert.rejects(run(process.execPath, [aggregateScript, config.release], { env: { ...process.env, BENCHMARK_CONFIG: configPath } }), /judge artifact identity mismatch/);
});
