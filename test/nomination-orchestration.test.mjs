import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runner = path.join(root, 'scripts', 'run-pilot.mjs');
const config = path.join(root, 'config', 'phase2-v2.json');
const models = ['54-inkling-openrouter', '55-glm-5-3-go', '56-kimi-k3-opencode'];

function dryRunRecord(stdout) {
  return stdout.trim().split('\n').map(JSON.parse).find((record) => record.event === 'dry_run');
}

test('phase2-v2 plans exactly one nomination times the selected three-model subset without mutating its frozen roster', async () => {
  const before = await readFile(config, 'utf8');
  const { stdout } = await run(process.execPath, [runner, '--dry-run', '--nomination', 'patch', '--candidate', models.join(',')], {
    env: { ...process.env, BENCHMARK_CONFIG: config }
  });
  const record = dryRunRecord(stdout);
  assert.equal(record.Benchmark, 'phase2-v2-r5');
  assert.equal(record.phase, 'candidates');
  assert.deepEqual(record.judges, []);
  assert.deepEqual(record.Nomination, ['patch']);
  assert.equal(record.selected_Models.length, 3);
  assert.equal(record.planned_Runs.length, 3);
  assert.deepEqual(record.planned_Runs.map((item) => item.attempt), [1, 1, 1]);
  assert.deepEqual(record.planned_Runs.map((item) => item.nomination), ['patch', 'patch', 'patch']);
  assert.equal((await readFile(config, 'utf8')), before);
});

test('deprecated --task alias selects the same nomination and an omitted phase2-v2 nomination is rejected', async () => {
  const legacy = await run(process.execPath, [runner, '--dry-run', '--task', 'patch', '--candidate', models[0]], {
    env: { ...process.env, BENCHMARK_CONFIG: config }
  });
  assert.match(legacy.stderr, /--task is deprecated/);
  assert.deepEqual(dryRunRecord(legacy.stdout).Nomination, ['patch']);
  await assert.rejects(
    run(process.execPath, [runner, '--dry-run'], { env: { ...process.env, BENCHMARK_CONFIG: config } }),
    /requires explicit --nomination/
  );
});


test('runner validates prepared workspace before model execution and runs public tests from workspace root', async () => {
  const source = await readFile(runner, 'utf8');
  assert.match(source, /await assertPreparedWorkspace\(task\)/);
  assert.match(source, /prepared workspace fixture differs from frozen source/);
  assert.match(source, /const tests = await runAsCandidate\(task\.test_command\[0\], task\.test_command\.slice\(1\), \{ cwd: cleanWorkspace, timeoutMs \}\)/);
});
