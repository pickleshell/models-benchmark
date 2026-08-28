import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runnerScript = path.join(root, 'scripts/run-pilot.mjs');

const fakeSudo = `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
let args = process.argv.slice(2);
function execute(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, { stdio: 'inherit', ...options });
  process.exit(result.status ?? 1);
}
if (args[0] === 'systemd-run') {
  const separator = args.indexOf('--');
  const properties = args.slice(0, separator);
  const invocation = args.slice(separator + 1);
  const working = properties.find((item) => item.startsWith('--property=WorkingDirectory='));
  const cwd = working ? working.slice('--property=WorkingDirectory='.length) : process.cwd();
  let index = 1;
  const env = { ...process.env };
  while (invocation[index] && invocation[index].includes('=')) {
    const [key, ...rest] = invocation[index++].split('='); env[key] = rest.join('=');
  }
  execute(invocation[index], invocation.slice(index + 1), { cwd, env });
}
if (args[0] === '-u') {
  args = args.slice(3);
  if (args[0] === 'env') {
    const env = { ...process.env }; let index = 1;
    while (args[index] && args[index].includes('=')) {
      const [key, ...rest] = args[index++].split('='); env[key] = rest.join('=');
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
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('fake-opencode 1.0'); process.exit(0); }
console.log(JSON.stringify({ type: 'error', error: { message: 'Model not found' } }));
`;

test('an unavailable required judge stops after the release manifest is frozen but before candidate work', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'models-benchmark-judge-preflight-'));
  try {
    const fakeBin = path.join(temp, 'bin');
    const modelsTest = path.join(temp, 'models-test');
    const cleanHome = path.join(temp, 'clean-room');
    const opencodeRoot = path.join(temp, 'opencode');
    const privateArtifacts = path.join(temp, 'private');
    await mkdir(fakeBin, { recursive: true });
    await mkdir(path.join(opencodeRoot, 'bin'), { recursive: true });
    await mkdir(path.join(cleanHome, 'workspace'), { recursive: true });
    await mkdir(path.join(modelsTest, 'fixture'), { recursive: true });
    await mkdir(path.join(modelsTest, 'prompts'), { recursive: true });
    await writeFile(path.join(modelsTest, 'fixture', 'value.txt'), 'baseline\n');
    await writeFile(path.join(modelsTest, 'prompts', 'task.md'), 'Implement the fixture.\n');
    await writeFile(path.join(fakeBin, 'sudo'), fakeSudo, { mode: 0o755 });
    await writeFile(path.join(opencodeRoot, 'bin', 'opencode'), fakeOpenCode.replace('#!/usr/bin/env node', `#!${process.execPath}`), { mode: 0o755 });
    await chmod(path.join(fakeBin, 'sudo'), 0o755);
    await chmod(path.join(opencodeRoot, 'bin', 'opencode'), 0o755);
    const configPath = path.join(temp, 'pilot.json');
    await writeFile(configPath, JSON.stringify({
      release: 'judge-missing', models_test: modelsTest, results_dir: 'results', private_artifacts_dir: privateArtifacts,
      clean_room: {
        user: 'nobody', home: cleanHome, opencode_root: opencodeRoot,
        workspace: path.join(cleanHome, 'workspace'), agent_home: path.join(cleanHome, 'agent-home'),
        reset_script: path.join(cleanHome, 'reset-room.mjs')
      },
      tasks: [{ id: 'task', fixture: 'fixture', prompt: 'prompts/task.md', test_command: ['node', '-e', ''], allowed_changes: ['fixture/value.txt'] }],
      candidates: [{ id: 'candidate', agent: 'opencode', model: 'candidate/model' }],
      judges: [{ id: 'required-judge', agent: 'opencode', model: 'judge/missing' }], criteria: ['correctness']
    }));
    await assert.rejects(
      run(process.execPath, [runnerScript, '--phase', 'judges'], { env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, BENCHMARK_CONFIG: configPath } }),
      /required judge model is unavailable/
    );
    assert.equal(existsSync(path.join(modelsTest, 'results', 'judge-missing', 'manifest.json')), true);
    assert.equal(existsSync(path.join(modelsTest, 'results', 'judge-missing', 'candidate')), false);
    assert.equal(existsSync(path.join(privateArtifacts, 'judge-missing')), false);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
