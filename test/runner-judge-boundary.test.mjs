import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runnerScript = path.join(root, 'scripts/run-pilot.mjs');

const fakeSudo = `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
let args = process.argv.slice(2);
const capture = process.env.BENCHMARK_FAKE_CAPTURE;
const execute = (command, commandArgs, options = {}) => {
  const result = spawnSync(command, commandArgs, { stdio: 'inherit', ...options });
  if (result.error) console.error(result.error.message);
  process.exit(result.status ?? 1);
};
if (args[0] === 'systemd-run') {
  const separator = args.indexOf('--');
  const properties = args.slice(0, separator);
  const invocation = args.slice(separator + 1);
  appendFileSync(capture, JSON.stringify({ type: 'systemd-run', args }) + '\\n');
  const working = properties.find((item) => item.startsWith('--property=WorkingDirectory='));
  const cwd = working ? working.slice('--property=WorkingDirectory='.length) : process.cwd();
  if (invocation[0] !== '/usr/bin/env') process.exit(70);
  const env = { ...process.env };
  let index = 1;
  while (invocation[index] && invocation[index].includes('=')) {
    const [key, ...rest] = invocation[index++].split('=');
    env[key] = rest.join('=');
  }
  execute(invocation[index], invocation.slice(index + 1), { cwd, env });
}
if (args[0] === '-u') {
  args = args.slice(3);
  if (args[0] === 'env') {
    const env = { ...process.env };
    let index = 1;
    while (args[index] && args[index].includes('=')) {
      const [key, ...rest] = args[index++].split('=');
      env[key] = rest.join('=');
    }
    execute(args[index], args.slice(index + 1), { env });
  }
}
if (args[0] === 'chown') process.exit(0);
if (args[0] === 'install') {
  const cleaned = [];
  for (let index = 1; index < args.length; index += 1) {
    if (['-o', '-g', '-m'].includes(args[index])) { index += 1; continue; }
    cleaned.push(args[index]);
  }
  execute('/usr/bin/install', cleaned);
}
execute(args[0], args.slice(1));
`;

const fakeOpenCode = `#!/usr/bin/env node
const { appendFileSync, writeFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('fake-opencode 1.0'); process.exit(0); }
const directory = args[args.indexOf('--dir') + 1];
const prompt = args.at(-1);
if (prompt.includes('independent code judge')) {
  if (process.env.BENCHMARK_FAKE_PROVIDER_LOG) appendFileSync(process.env.BENCHMARK_FAKE_PROVIDER_LOG, 'judge\\n');
  console.log(JSON.stringify({ type: 'text', part: { text: JSON.stringify({ scores: { correctness: 9 }, confidence: 0.9, explanation: 'ok', concerns: [] }) } }));
  process.exit(0);
}
if (process.env.BENCHMARK_FAKE_PROVIDER_LOG) appendFileSync(process.env.BENCHMARK_FAKE_PROVIDER_LOG, 'candidate\\n');
writeFileSync(path.join(directory, 'fixture', 'value.txt'), 'candidate solution\\n');
spawnSync('git', ['-C', directory, 'add', 'fixture/value.txt'], { stdio: 'inherit' });
spawnSync('git', ['-C', directory, 'commit', '-qm', 'candidate commit'], { stdio: 'inherit' });
console.log(JSON.stringify({ type: 'text', part: { text: 'done' } }));
`;

test('candidate and judge process boundaries prevent cross-run workspace access', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'models-benchmark-judge-boundary-'));
  try {
    const fakeBin = path.join(temp, 'bin');
    const modelsTest = path.join(temp, 'models-test');
    const cleanHome = path.join(temp, 'clean-room');
    const opencodeRoot = path.join(temp, 'opencode');
    const privateArtifacts = path.join(temp, 'private');
    const privateEvaluators = path.join(temp, 'private-evaluators');
    const capture = path.join(temp, 'systemd.jsonl');
    const providerLog = path.join(temp, 'providers.log');
    await mkdir(path.join(fakeBin), { recursive: true });
    await mkdir(path.join(opencodeRoot, 'bin'), { recursive: true });
    await mkdir(path.join(cleanHome, 'workspace'), { recursive: true });
    await mkdir(path.join(modelsTest, 'fixture'), { recursive: true });
    await mkdir(path.join(modelsTest, 'prompts'), { recursive: true });
    await mkdir(privateEvaluators, { recursive: true });
    await writeFile(path.join(modelsTest, 'fixture', 'value.txt'), 'baseline\\n');
    await writeFile(path.join(modelsTest, 'prompts', 'task.md'), 'Implement the fixture.\\n');
    await writeFile(path.join(privateEvaluators, 'evaluator.mjs'), "console.log('private evaluator assertion detail');");
    await writeFile(path.join(fakeBin, 'sudo'), fakeSudo, { mode: 0o755 });
    await writeFile(path.join(opencodeRoot, 'bin', 'opencode'), fakeOpenCode.replace('#!/usr/bin/env node', `#!${process.execPath}`), { mode: 0o755 });
    await chmod(path.join(fakeBin, 'sudo'), 0o755);
    await chmod(path.join(opencodeRoot, 'bin', 'opencode'), 0o755);
    const candidate = {
      id: 'SECRET-CANDIDATE-ID', agent: 'secret-agent', runtime: 'secret-runtime',
      provider: 'secret-provider', model: 'secret/model', subscription: 'secret-subscription'
    };
    const configPath = path.join(temp, 'pilot.json');
    const benchmarkConfig = {
      release: 'boundary-release', models_test: modelsTest, results_dir: 'results', private_artifacts_dir: privateArtifacts, private_evaluators_dir: privateEvaluators,
      clean_room: {
        user: 'nobody', home: cleanHome, opencode_root: opencodeRoot,
        workspace: path.join(cleanHome, 'workspace'), agent_home: path.join(cleanHome, 'agent-home'),
        reset_script: path.join(cleanHome, 'reset-room.mjs')
      },
      tasks: [{ id: 'task', fixture: 'fixture', prompt: 'prompts/task.md', test_command: ['node', '-e', 'console.log("candidate-controlled public test output")'], allowed_changes: ['fixture/value.txt'], objective_evaluator: { id: 'private-objective-v1', path: 'evaluator.mjs', source: 'fixture/value.txt' } }],
      candidates: [candidate], judges: [{ id: 'judge-a', agent: 'opencode', provider: 'opencode', model: 'judge/a', subscription: 'test' }, { id: 'judge-b', agent: 'opencode', provider: 'opencode', model: 'judge/b', subscription: 'test' }],
      criteria: ['correctness']
    };
    await writeFile(configPath, JSON.stringify(benchmarkConfig));
    const env = {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      BENCHMARK_CONFIG: configPath,
      BENCHMARK_FAKE_CAPTURE: capture,
      BENCHMARK_FAKE_PROVIDER_LOG: providerLog,
      BENCHMARK_OBJECTIVE_WORKSPACE_RUNTIME_DIR: path.join(temp, 'objective-runtime')
    };
    const invoke = (...args) => run(process.execPath, [runnerScript, ...args], { env });
    await invoke('--phase', 'candidates');
    const taskRoot = path.join(modelsTest, 'results', 'boundary-release', candidate.id, 'task', 'attempts', 'attempt-1');
    const primary = ['candidate.diff', 'test-result.json', 'objective-evaluator.json', 'run.json'];
    const primaryHashes = Object.fromEntries(await Promise.all(primary.map(async (file) => [file, await readFile(path.join(taskRoot, file), 'utf8')])));
    assert.equal((await readFile(providerLog, 'utf8')).trim().split('\\n').includes('judge'), false);
    await assert.rejects(readFile(path.join(taskRoot, 'judges', 'judge-a.json')));
    await invoke('--phase', 'judges', '--judge', 'judge-a');
    assert.ok(existsSync(path.join(taskRoot, 'judges', 'judge-a.json')));
    await assert.rejects(readFile(path.join(taskRoot, 'judges', 'judge-b.json')));
    assert.equal((await readFile(path.join(modelsTest, 'results', 'boundary-release', 'aggregate.json'), 'utf8')).includes('judge-b'), true);
    for (const file of primary) assert.equal(await readFile(path.join(taskRoot, file), 'utf8'), primaryHashes[file]);
    await invoke('--phase', 'judges', '--judge', 'judge-b', '--resume');
    assert.ok(existsSync(path.join(taskRoot, 'judges', 'judge-b.json')));
    for (const file of primary) assert.equal(await readFile(path.join(taskRoot, file), 'utf8'), primaryHashes[file]);
    const providersBeforeResume = await readFile(providerLog, 'utf8');
    await invoke('--phase', 'candidates', '--resume');
    await invoke('--phase', 'judges', '--resume');
    assert.equal(await readFile(providerLog, 'utf8'), providersBeforeResume);
    // Each evidence file is verified before a judge process can start.
    for (const file of ['candidate.diff', 'test-result.json', 'objective-evaluator.json']) {
      const original = await readFile(path.join(taskRoot, file), 'utf8');
      await writeFile(path.join(taskRoot, file), `${original}tamper`);
      const before = await readFile(providerLog, 'utf8');
      await assert.rejects(invoke('--phase', 'judges', '--judge', 'judge-a', '--resume'), /integrity mismatch/);
      assert.equal(await readFile(providerLog, 'utf8'), before);
      await writeFile(path.join(taskRoot, file), original);
    }
    // A partial primary candidate state is never overwritten or sent to a model.
    const partialConfig = { ...benchmarkConfig, release: 'partial-release' };
    const partialConfigPath = path.join(temp, 'partial.json');
    await writeFile(partialConfigPath, JSON.stringify(partialConfig));
    const partialRoot = path.join(modelsTest, 'results', 'partial-release', candidate.id, 'task', 'attempts', 'attempt-1');
    await mkdir(partialRoot, { recursive: true });
    await writeFile(path.join(partialRoot, 'candidate.diff'), 'partial evidence');
    const beforePartial = await readFile(providerLog, 'utf8');
    await assert.rejects(
      run(process.execPath, [runnerScript, '--phase', 'candidates'], { env: { ...env, BENCHMARK_CONFIG: partialConfigPath } }),
      /partial\/incomplete primary artifact state/
    );
    assert.equal(await readFile(providerLog, 'utf8'), beforePartial);
    const invocations = (await readFile(capture, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    const judge = invocations.find(({ args }) => args.some((value) => value.includes('You are an independent code judge.')));
    assert.ok(judge, 'expected captured judge systemd-run invocation');
    const input = JSON.stringify(judge.args);
    assert.equal(judge.args.some((value) => value.includes('Implement the fixture.')), true);
    for (const value of Object.values(candidate)) assert.equal(input.includes(value), false, value);
    const writable = judge.args.filter((value) => value.startsWith('--property=BindPaths='));
    const judgeWorkspace = judge.args.find((value) => value.startsWith('--property=WorkingDirectory=')).slice('--property=WorkingDirectory='.length);
    assert.match(judgeWorkspace, /\/judge\/submission-[0-9a-f-]{36}$/);
    assert.deepEqual(writable.sort(), [
      `--property=BindPaths=${path.join(cleanHome, 'agent-home')}`,
      `--property=BindPaths=${judgeWorkspace}`
    ].sort());
    assert.equal(input.includes(path.join(cleanHome, 'workspace')), false);
    assert.equal(input.includes(privateEvaluators), false);
    assert.equal(input.includes('private-objective-v1'), false);

    const candidateInvocations = invocations.filter(({ args }) => args.some((value) => value === `--property=WorkingDirectory=${path.join(cleanHome, 'workspace')}`));
    assert.ok(candidateInvocations.length >= 2, 'expected model and public-test candidate invocations');
    for (const invocation of candidateInvocations) {
      const candidateInput = JSON.stringify(invocation.args);
      const candidateWritable = invocation.args.filter((value) => value.startsWith('--property=BindPaths=')).sort();
      assert.deepEqual(candidateWritable, [
        `--property=BindPaths=${path.join(cleanHome, 'agent-home')}`,
        `--property=BindPaths=${path.join(cleanHome, 'workspace')}`
      ].sort());
      assert.equal(candidateInput.includes(privateArtifacts), false);
      assert.equal(candidateInput.includes(path.join(modelsTest, 'results')), false);
      assert.equal(candidateInput.includes(privateEvaluators), false);
      assert.ok(invocation.args.includes('--property=ProtectHome=tmpfs'));
      assert.ok(invocation.args.includes('--property=PrivateIPC=yes'));
      assert.ok(invocation.args.includes('--property=TemporaryFileSystem=/dev/shm:rw,nosuid,nodev,noexec,mode=1777'));
      assert.ok(invocation.args.includes('--property=ProtectProc=invisible'));
    }
    const objectiveInvocation = invocations.find(({ args }) => args.includes('--property=PrivateNetwork=yes'));
    assert.ok(objectiveInvocation, 'objective evaluator must be a network-isolated transient unit');
    assert.ok(objectiveInvocation.args.includes('--uid=nobody'));
    assert.ok(objectiveInvocation.args.includes('--property=ProtectHome=tmpfs'));
    assert.ok(objectiveInvocation.args.includes('--property=PrivateTmp=yes'));
    assert.ok(objectiveInvocation.args.includes('--property=PrivateIPC=yes'));
    assert.ok(objectiveInvocation.args.includes('--property=ProtectSystem=strict'));
    assert.ok(objectiveInvocation.args.includes('--property=NoNewPrivileges=yes'));
    const objectiveWritable = objectiveInvocation.args.filter((value) => value.startsWith('--property=BindPaths='));
    assert.equal(objectiveWritable.length, 1);
    const objectiveInput = JSON.stringify(objectiveInvocation.args);
    assert.equal(objectiveInput.includes(opencodeRoot), false);
    assert.equal(objectiveInput.includes(path.join(cleanHome, 'agent-home')), false);
    assert.equal(objectiveInput.includes(privateArtifacts), false);
    assert.equal(objectiveInput.includes(privateEvaluators), false);
    assert.deepEqual(objectiveInvocation.args.filter((value) => value.startsWith('--property=BindReadOnlyPaths=')), []);
    assert.ok(objectiveInvocation.args.includes('/usr/bin/node'));
    const versionProbe = invocations.find(({ args }) => args.includes('opencode') && args.includes('--version'));
    assert.ok(versionProbe, `expected a runtime version probe: ${JSON.stringify(invocations)}`);
    assert.ok(versionProbe.args.includes('--property=WorkingDirectory=/tmp'));
    assert.deepEqual(versionProbe.args.filter((value) => value.startsWith('--property=BindPaths=')), []);
    const artifact = JSON.parse(await readFile(path.join(modelsTest, 'results', 'boundary-release', candidate.id, 'task', 'attempts', 'attempt-1', 'judges', 'judge-a.json'), 'utf8'));
    assert.equal(artifact.candidate, candidate.id);
    assert.equal(artifact.status, 'completed');
    const objective = JSON.parse(await readFile(path.join(modelsTest, 'results', 'boundary-release', candidate.id, 'task', 'attempts', 'attempt-1', 'objective-evaluator.json'), 'utf8'));
    assert.equal(objective.evaluator.id, 'private-objective-v1');
    assert.equal(objective.passed, true);
    assert.equal(JSON.stringify(objective).includes('hidden/evaluator.mjs'), false);
    assert.equal(JSON.stringify(objective).includes('assertion detail'), false);
    const publicTests = JSON.parse(await readFile(path.join(modelsTest, 'results', 'boundary-release', candidate.id, 'task', 'attempts', 'attempt-1', 'test-result.json'), 'utf8'));
    assert.equal(Object.hasOwn(publicTests, 'stdout'), false);
    assert.equal(Object.hasOwn(publicTests, 'stderr'), false);
    assert.match(publicTests.stdout_sha256, /^[a-f0-9]{64}$/);
    assert.match(await readFile(path.join(privateArtifacts, 'boundary-release', candidate.id, 'task', 'attempts', 'attempt-1', 'public-test.stdout.txt'), 'utf8'), /candidate-controlled public test output/);
    const manifest = JSON.parse(await readFile(path.join(modelsTest, 'results', 'boundary-release', 'manifest.json'), 'utf8'));
    assert.equal(manifest.nominations[0].objective_evaluator.id, 'private-objective-v1');
    assert.equal(Object.hasOwn(manifest.nominations[0].objective_evaluator, 'path'), false);
    assert.equal(Object.hasOwn(manifest.nominations[0].objective_evaluator, 'source'), false);
    assert.equal(JSON.stringify(manifest).includes(privateEvaluators), false);
    assert.match(await readFile(path.join(privateArtifacts, 'boundary-release', candidate.id, 'task', 'attempts', 'attempt-1', 'objective-evaluator', 'stdout.txt'), 'utf8'), /private evaluator assertion detail/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
