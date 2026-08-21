import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
const { writeFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('fake-opencode 1.0'); process.exit(0); }
const directory = args[args.indexOf('--dir') + 1];
const prompt = args.at(-1);
if (prompt.includes('independent code judge')) {
  console.log(JSON.stringify({ type: 'text', part: { text: JSON.stringify({ scores: { correctness: 9 }, confidence: 0.9, explanation: 'ok', concerns: [] }) } }));
  process.exit(0);
}
writeFileSync(path.join(directory, 'fixture', 'value.txt'), 'candidate solution\\n');
spawnSync('git', ['-C', directory, 'add', 'fixture/value.txt'], { stdio: 'inherit' });
spawnSync('git', ['-C', directory, 'commit', '-qm', 'candidate commit'], { stdio: 'inherit' });
console.log(JSON.stringify({ type: 'text', part: { text: 'done' } }));
`;

test('judge process boundary is identity-blind and has no candidate workspace bind', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'models-benchmark-judge-boundary-'));
  try {
    const fakeBin = path.join(temp, 'bin');
    const modelsTest = path.join(temp, 'models-test');
    const cleanHome = path.join(temp, 'clean-room');
    const opencodeRoot = path.join(temp, 'opencode');
    const privateArtifacts = path.join(temp, 'private');
    const capture = path.join(temp, 'systemd.jsonl');
    await mkdir(path.join(fakeBin), { recursive: true });
    await mkdir(path.join(opencodeRoot, 'bin'), { recursive: true });
    await mkdir(path.join(cleanHome, 'workspace'), { recursive: true });
    await mkdir(path.join(modelsTest, 'fixture'), { recursive: true });
    await mkdir(path.join(modelsTest, 'prompts'), { recursive: true });
    await writeFile(path.join(modelsTest, 'fixture', 'value.txt'), 'baseline\\n');
    await writeFile(path.join(modelsTest, 'prompts', 'task.md'), 'Implement the fixture.\\n');
    await writeFile(path.join(fakeBin, 'sudo'), fakeSudo, { mode: 0o755 });
    await writeFile(path.join(opencodeRoot, 'bin', 'opencode'), fakeOpenCode.replace('#!/usr/bin/env node', `#!${process.execPath}`), { mode: 0o755 });
    await chmod(path.join(fakeBin, 'sudo'), 0o755);
    await chmod(path.join(opencodeRoot, 'bin', 'opencode'), 0o755);
    const candidate = {
      id: 'SECRET-CANDIDATE-ID', agent: 'secret-agent', runtime: 'secret-runtime',
      provider: 'secret-provider', model: 'secret/model', subscription: 'secret-subscription'
    };
    const configPath = path.join(temp, 'pilot.json');
    await writeFile(configPath, JSON.stringify({
      release: 'boundary-release', models_test: modelsTest, results_dir: 'results', private_artifacts_dir: privateArtifacts,
      clean_room: {
        user: process.env.USER || 'gpt', home: cleanHome, opencode_root: opencodeRoot,
        workspace: path.join(cleanHome, 'workspace'), agent_home: path.join(cleanHome, 'agent-home'),
        reset_script: path.join(cleanHome, 'reset-room.mjs')
      },
      tasks: [{ id: 'task', fixture: 'fixture', prompt: 'prompts/task.md', test_command: ['node', '-e', ''], allowed_changes: ['fixture/value.txt'] }],
      candidates: [candidate], judges: [{ id: 'judge', agent: 'opencode', provider: 'opencode', model: 'judge/model', subscription: 'test' }],
      criteria: ['correctness']
    }));
    await run(process.execPath, [runnerScript], {
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, BENCHMARK_CONFIG: configPath, BENCHMARK_FAKE_CAPTURE: capture }
    });
    const invocations = (await readFile(capture, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    const judge = invocations.find(({ args }) => args.some((value) => value.includes('You are an independent code judge.')));
    assert.ok(judge, 'expected captured judge systemd-run invocation');
    const input = JSON.stringify(judge.args);
    for (const value of Object.values(candidate)) assert.equal(input.includes(value), false, value);
    const writable = judge.args.filter((value) => value.startsWith('--property=BindPaths='));
    const judgeWorkspace = judge.args.find((value) => value.startsWith('--property=WorkingDirectory=')).slice('--property=WorkingDirectory='.length);
    assert.match(judgeWorkspace, /\/judge\/submission-[0-9a-f-]{36}$/);
    assert.deepEqual(writable.sort(), [
      `--property=BindPaths=${path.join(cleanHome, 'agent-home')}`,
      `--property=BindPaths=${judgeWorkspace}`
    ].sort());
    assert.equal(input.includes(path.join(cleanHome, 'workspace')), false);
    const artifact = JSON.parse(await readFile(path.join(modelsTest, 'results', 'boundary-release', candidate.id, 'task', 'judges', 'judge.json'), 'utf8'));
    assert.equal(artifact.candidate, candidate.id);
    assert.equal(artifact.status, 'completed');
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
