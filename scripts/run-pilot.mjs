#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const repo = path.resolve(new URL('..', import.meta.url).pathname);
const configPath = path.join(repo, 'config', 'pilot.json');
const config = JSON.parse(await readFile(configPath, 'utf8'));
const dryRun = process.argv.includes('--dry-run');
const timeoutMs = Number(process.env.BENCHMARK_TIMEOUT_MS || 15 * 60 * 1000);
const modelsTest = path.resolve(config.models_test);
const expandHome = (value) => value.replace(/^~(?=$|\/)/, os.homedir());
const cleanWorkspace = path.resolve(expandHome(config.clean_room.workspace));
const agentHome = path.resolve(expandHome(config.clean_room.agent_home));
const candidateUser = config.clean_room.user;
const cleanRoomHome = path.resolve(config.clean_room.home);
const resetScript = path.resolve(config.clean_room.reset_script);
const archiveRoot = path.join(cleanRoomHome, 'task-archive');
const resultsDir = path.resolve(modelsTest, config.results_dir);
const privateDir = path.resolve(expandHome(config.private_artifacts_dir), config.release);

function emit(event, data = {}) {
  process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), event, ...data })}\n`);
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function git(args, cwd) {
  return runAsCandidate('git', ['-C', cwd, ...args], { cwd });
}

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true
    });
    const stdout = [], stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        status: result.status ?? null,
        signal: result.signal ?? null,
        stdout: Buffer.concat(stdout).toString(),
        stderr: Buffer.concat(stderr).toString(),
        timed_out: Boolean(options.timedOut)
      });
    };
    const timer = setTimeout(() => {
      options.timedOut = true;
      try { process.kill(-child.pid, 'SIGTERM'); } catch {}
      setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 2000).unref();
    }, options.timeoutMs ?? timeoutMs);
    child.once('error', (error) => finish({ status: null, signal: null, error: error.message }));
    child.once('close', (status, signal) => finish({ status, signal }));
  });
}

function commandFor(candidate, prompt) {
  if (candidate.agent === 'codex') {
    return { command: 'codex', args: ['exec', '--model', candidate.model, '--cd', cleanWorkspace, '--approve-for-me', prompt] };
  }
  return { command: 'opencode', args: ['run', '--model', candidate.model, '--dir', cleanWorkspace, '--dangerously-skip-permissions', '--format', 'json', prompt] };
}

async function installArchive(task) {
  const sourceFixture = path.join(modelsTest, task.fixture);
  const sourcePrompt = path.join(modelsTest, task.prompt);
  const targetFixture = path.join(archiveRoot, task.fixture);
  const targetPrompt = path.join(archiveRoot, task.prompt);
  const directory = await run('sudo', ['install', '-d', '-o', candidateUser, '-g', candidateUser, '-m', '0755', path.dirname(targetFixture), path.dirname(targetPrompt)], { timeoutMs: 30000 });
  if (directory.status !== 0) throw new Error(`cannot prepare task archive: ${directory.stderr}`);
  const fixture = await run('sudo', ['cp', '-a', sourceFixture, targetFixture], { timeoutMs: 30000 });
  if (fixture.status !== 0) throw new Error(`cannot copy task fixture: ${fixture.stderr}`);
  const prompt = await run('sudo', ['cp', sourcePrompt, targetPrompt], { timeoutMs: 30000 });
  if (prompt.status !== 0) throw new Error(`cannot copy task prompt: ${prompt.stderr}`);
  const owner = await run('sudo', ['chown', '-R', `${candidateUser}:${candidateUser}`, cleanRoomHome], { timeoutMs: 30000 });
  if (owner.status !== 0) throw new Error(`cannot set task archive owner: ${owner.stderr}`);
}

async function installResetScript() {
  const directory = await run('sudo', ['install', '-d', '-o', candidateUser, '-g', candidateUser, '-m', '0755', cleanRoomHome], { timeoutMs: 30000 });
  if (directory.status !== 0) throw new Error(`cannot prepare clean-room home: ${directory.stderr}`);
  const installed = await run('sudo', ['install', '-o', candidateUser, '-g', candidateUser, '-m', '0755', path.join(repo, 'scripts/reset-room.mjs'), resetScript], { timeoutMs: 30000 });
  if (installed.status !== 0) throw new Error(`cannot install reset script: ${installed.stderr}`);
}

function runAsCandidate(command, args, options = {}) {
  const env = {
    HOME: agentHome,
    PATH: `/home/test/.opencode/bin:/usr/local/bin:/usr/bin:/bin`,
    XDG_CONFIG_HOME: path.join(agentHome, '.config'),
    XDG_DATA_HOME: path.join(agentHome, '.local', 'share')
  };
  const envArgs = Object.entries(env).map(([key, value]) => `${key}=${value}`);
  const targetCwd = options.cwd || cleanRoomHome;
  const commandArgs = command === 'npm' && args[0] === 'test'
    ? ['--prefix', targetCwd, ...args]
    : args;
  return run('sudo', ['-u', candidateUser, '--', 'env', ...envArgs, command, ...commandArgs], { ...options, cwd: '/tmp' });
}

async function resetRoom(task) {
  emit('reset_started', { task: task.id, workspace: cleanWorkspace });
  await installResetScript();
  await installArchive(task);
  const reset = await runAsCandidate('/usr/bin/node', [resetScript, '--archive-root', archiveRoot, '--fixture', task.fixture, '--prompt', task.prompt, '--workspace', cleanWorkspace, '--agent-home', agentHome, '--sandbox-root', cleanRoomHome], { timeoutMs: 30000 });
  if (reset.status !== 0) throw new Error(`reset failed: ${reset.stderr}`);
  emit('reset_completed', { task: task.id });
}

async function runCandidate(candidate, task) {
  const candidateDir = path.join(resultsDir, config.release, candidate.id, task.id);
  const privateCandidateDir = path.join(privateDir, candidate.id, task.id);
  await mkdir(candidateDir, { recursive: true });
  await mkdir(privateCandidateDir, { recursive: true, mode: 0o700 });
  await resetRoom(task);
  const prompt = await readFile(path.join(modelsTest, task.prompt), 'utf8');
  const command = commandFor(candidate, prompt);
  emit('candidate_started', { candidate: candidate.id, agent: candidate.agent, model: candidate.model, task: task.id });
  const agent = await runAsCandidate(command.command, command.args, { cwd: cleanWorkspace, timeoutMs });
  await writeFile(path.join(privateCandidateDir, 'agent.stdout.txt'), agent.stdout);
  await writeFile(path.join(privateCandidateDir, 'agent.stderr.txt'), agent.stderr);
  const tests = await runAsCandidate(task.test_command[0], task.test_command.slice(1), { cwd: path.join(cleanWorkspace, task.fixture), timeoutMs });
  await writeJson(path.join(candidateDir, 'test-result.json'), { status: tests.status, timed_out: tests.timed_out, stdout: tests.stdout, stderr: tests.stderr });
  const diff = await git(['diff', '--binary'], cleanWorkspace);
  const status = await git(['status', '--porcelain'], cleanWorkspace);
  await writeFile(path.join(candidateDir, 'candidate.diff'), diff.stdout);
  const record = {
    schema_version: 1,
    release: config.release,
    task: task.id,
    candidate,
    agent: { status: agent.status, signal: agent.signal, timed_out: agent.timed_out },
    tests: { status: tests.status, timed_out: tests.timed_out },
    changed_files: status.stdout.split('\n').filter(Boolean).map((line) => line.slice(3)),
    artifacts: { public_dir: path.relative(modelsTest, candidateDir), private_dir: privateCandidateDir },
    completed_at: new Date().toISOString()
  };
  await writeJson(path.join(candidateDir, 'run.json'), record);
  emit('candidate_completed', { candidate: candidate.id, task: task.id, agent_status: agent.status, test_status: tests.status, result_dir: candidateDir });
}

if (!existsSync(modelsTest)) throw new Error(`models-test checkout not found: ${modelsTest}`);
if (dryRun) {
  emit('dry_run', { release: config.release, task_count: config.tasks.length, candidates: config.candidates.map((candidate) => ({ id: candidate.id, agent: candidate.agent, model: candidate.model })) });
  process.exit(0);
}

const account = await run('getent', ['passwd', candidateUser], { timeoutMs: 5000 });
if (account.status !== 0) throw new Error(`clean-room account not found: ${candidateUser}`);
const opencode = await runAsCandidate('opencode', ['--version'], { timeoutMs: 10000 });
if (opencode.status !== 0) throw new Error(`OpenCode is unavailable for ${candidateUser}: ${opencode.stderr}`);
emit('preflight_ok', { candidate_user: candidateUser, opencode_version: opencode.stdout.trim() });

await mkdir(resultsDir, { recursive: true });
for (const candidate of config.candidates) {
  for (const task of config.tasks) await runCandidate(candidate, task);
}
emit('pilot_completed', { results_dir: resultsDir, publication: 'manual' });
