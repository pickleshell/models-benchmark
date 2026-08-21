#!/usr/bin/env node
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
  return run('git', ['-C', cwd, ...args], { cwd });
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
  return { command: 'opencode', args: ['run', '--model', candidate.model, '--dir', cleanWorkspace, '--auto', prompt] };
}

async function resetRoom(task) {
  emit('reset_started', { task: task.id, workspace: cleanWorkspace });
  await rm(cleanWorkspace, { recursive: true, force: true });
  await rm(agentHome, { recursive: true, force: true });
  await mkdir(path.dirname(cleanWorkspace), { recursive: true });
  await mkdir(agentHome, { recursive: true, mode: 0o700 });
  await cp(path.join(modelsTest, task.fixture), path.join(cleanWorkspace, task.fixture), { recursive: true });
  await mkdir(path.dirname(path.join(cleanWorkspace, task.prompt)), { recursive: true });
  await cp(path.join(modelsTest, task.prompt), path.join(cleanWorkspace, task.prompt));
  await git(['init', '-q'], cleanWorkspace);
  await git(['config', 'user.name', 'benchmark-baseline'], cleanWorkspace);
  await git(['config', 'user.email', 'benchmark-baseline@localhost'], cleanWorkspace);
  await git(['add', '.'], cleanWorkspace);
  await git(['commit', '-qm', 'benchmark baseline'], cleanWorkspace);
  emit('reset_completed', { task: task.id });
}

async function runCandidate(candidate, task) {
  const candidateDir = path.join(resultsDir, config.release, candidate.id, task.id);
  const privateCandidateDir = path.join(privateDir, candidate.id, task.id);
  await mkdir(candidateDir, { recursive: true });
  await mkdir(privateCandidateDir, { recursive: true, mode: 0o700 });
  await resetRoom(task);
  const prompt = await readFile(path.join(cleanWorkspace, task.prompt), 'utf8');
  const command = commandFor(candidate, prompt);
  emit('candidate_started', { candidate: candidate.id, agent: candidate.agent, model: candidate.model, task: task.id });
  const agent = await run(command.command, command.args, {
    cwd: cleanWorkspace,
    timeoutMs,
    env: { ...process.env, HOME: agentHome, XDG_CONFIG_HOME: path.join(agentHome, '.config'), XDG_DATA_HOME: path.join(agentHome, '.local', 'share') }
  });
  await writeFile(path.join(privateCandidateDir, 'agent.stdout.txt'), agent.stdout);
  await writeFile(path.join(privateCandidateDir, 'agent.stderr.txt'), agent.stderr);
  const tests = await run(task.test_command[0], task.test_command.slice(1), { cwd: path.join(cleanWorkspace, task.fixture), timeoutMs });
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

await mkdir(resultsDir, { recursive: true });
for (const candidate of config.candidates) {
  for (const task of config.tasks) await runCandidate(candidate, task);
}
emit('pilot_completed', { results_dir: resultsDir, publication: 'manual' });
