#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {
  classifyOutcome,
  createBoundedCollector,
  findForbiddenChanges,
  hasModelResponse,
  parsePorcelainPaths,
  validateJudgePayload
} from './lib/runner-utils.mjs';
import {
  buildJudgeInvocation,
  buildJudgeEnvironment,
  buildJudgePrompt,
  buildJudgeWritablePaths,
  buildBaselineComparisonPlan,
  createAnonymousJudgeWorkspace
} from './lib/blind-judging.mjs';
import { acquireCleanRoomLock, releaseCleanRoomLock, retainCleanRoomLock } from './lib/clean-room-lock.mjs';

const repo = path.resolve(new URL('..', import.meta.url).pathname);
const configPath = process.env.BENCHMARK_CONFIG
  ? path.resolve(process.env.BENCHMARK_CONFIG)
  : path.join(repo, 'config', 'pilot.json');
const config = JSON.parse(await readFile(configPath, 'utf8'));
const dryRun = process.argv.includes('--dry-run');
const timeoutMs = Number(process.env.BENCHMARK_TIMEOUT_MS || 15 * 60 * 1000);
const maxOutputBytes = Number(process.env.BENCHMARK_MAX_OUTPUT_BYTES || 2 * 1024 * 1024);
const modelsTest = path.resolve(config.models_test);
const expandHome = (value) => value.replace(/^~(?=$|\/)/, os.homedir());
const cleanWorkspace = path.resolve(expandHome(config.clean_room.workspace));
const agentHome = path.resolve(expandHome(config.clean_room.agent_home));
const candidateUser = config.clean_room.user;
const cleanRoomHome = path.resolve(config.clean_room.home);
const resetScript = path.resolve(config.clean_room.reset_script);
const archiveRoot = path.join(cleanRoomHome, 'task-archive');
const judgeRoot = path.join(cleanRoomHome, 'judge');
const baselineRoot = path.join(cleanRoomHome, 'baseline');
const comparisonRoot = path.join(cleanRoomHome, 'comparison');
const resultsDir = path.resolve(modelsTest, config.results_dir);
const privateDir = path.resolve(expandHome(config.private_artifacts_dir), config.release);
const cleanRoomLockPath = config.clean_room.lock_path
  ? path.resolve(expandHome(config.clean_room.lock_path))
  : path.join(path.dirname(privateDir), 'clean-room.lock');
const publicReleaseDir = path.join(resultsDir, config.release);
const opencodeRoot = path.resolve(config.clean_room.opencode_root);
let sandboxSequence = 0;
let cleanRoomTouched = false;

function emit(event, data = {}) {
  process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), event, ...data })}\n`);
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const startedAt = new Date();
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true
    });
    const stdout = createBoundedCollector(maxOutputBytes);
    const stderr = createBoundedCollector(maxOutputBytes);
    let outputLimited = false;
    const terminateForOutputLimit = () => {
      if (outputLimited) return;
      outputLimited = true;
      try { options.onOutputLimit?.(); } catch {}
      try { process.kill(-child.pid, 'SIGTERM'); } catch {}
      setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 2000).unref();
    };
    child.stdout.on('data', (chunk) => { if (!stdout.append(chunk)) terminateForOutputLimit(); });
    child.stderr.on('data', (chunk) => { if (!stderr.append(chunk)) terminateForOutputLimit(); });
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        started_at: startedAt.toISOString(),
        completed_at: new Date().toISOString(),
        duration_ms: Date.now() - startedAt.getTime(),
        status: result.status ?? null,
        signal: result.signal ?? null,
        stdout: stdout.text(),
        stderr: stderr.text(),
        timed_out: Boolean(options.timedOut),
        output_limited: outputLimited
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

function extractJudgeText(output) {
  const texts = [];
  for (const line of output.split('\n')) {
    try {
      const event = JSON.parse(line);
      if (event.type === 'text' && event.part?.text) texts.push(event.part.text);
    } catch {}
  }
  return texts.join('\n').trim() || output.trim();
}

function parseJudgeJson(text) {
  const fenced = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const start = fenced.indexOf('{');
  const end = fenced.lastIndexOf('}');
  const candidate = start >= 0 && end > start ? fenced.slice(start, end + 1) : fenced;
  try {
    const value = JSON.parse(candidate);
    if (!value || typeof value !== 'object') return null;
    if (value.scores && typeof value.scores === 'object') return validateJudgePayload(value, config.criteria);
    const scores = Object.fromEntries(config.criteria.filter((criterion) => Object.hasOwn(value, criterion)).map((criterion) => [criterion, value[criterion]]));
    return Object.keys(scores).length === config.criteria.length
      ? validateJudgePayload({ ...value, scores }, config.criteria)
      : null;
  } catch {
    return null;
  }
}

async function installArchive(task) {
  const sourceFixture = path.join(modelsTest, task.fixture);
  const sourcePrompt = path.join(modelsTest, task.prompt);
  const targetFixture = path.join(archiveRoot, task.fixture);
  const targetPrompt = path.join(archiveRoot, task.prompt);
  const directory = await run('sudo', ['install', '-d', '-o', candidateUser, '-g', candidateUser, '-m', '0755', path.dirname(targetFixture), path.dirname(targetPrompt)], { timeoutMs: 30000 });
  if (directory.status !== 0) throw new Error(`cannot prepare task archive: ${directory.stderr}`);
  const fixture = await run('sudo', ['rm', '-rf', targetFixture], { timeoutMs: 30000 });
  if (fixture.status !== 0) throw new Error(`cannot clear task archive: ${fixture.stderr}`);
  const copiedFixture = await run('sudo', ['cp', '-a', sourceFixture, targetFixture], { timeoutMs: 30000 });
  if (copiedFixture.status !== 0) throw new Error(`cannot copy task fixture: ${copiedFixture.stderr}`);
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

function cleanRoomEnv() {
  return buildJudgeEnvironment({ agentHome, opencodeRoot });
}

function runAsCleanRoomHost(command, args, options = {}) {
  const envArgs = Object.entries(cleanRoomEnv()).map(([key, value]) => `${key}=${value}`);
  return run('sudo', ['-u', candidateUser, '--', 'env', ...envArgs, command, ...args], { ...options, cwd: '/tmp' });
}

async function assertCleanRoomUserIsIdle() {
  const listed = await run('pgrep', ['-u', candidateUser, '-a'], { timeoutMs: 5000 });
  if (listed.status === 1) return;
  if (listed.status !== 0) {
    throw new Error(`cannot inspect clean-room account processes for ${candidateUser}: ${listed.stderr || listed.stdout}`);
  }
  const processes = listed.stdout.trim();
  throw new Error(`clean-room account ${candidateUser} is active; stop its processes before starting a benchmark:\n${processes}`);
}

function runAsCandidate(command, args, options = {}) {
  const env = cleanRoomEnv();
  const envArgs = Object.entries(env).map(([key, value]) => `${key}=${value}`);
  const targetCwd = options.cwd || cleanWorkspace;
  const unit = `models-benchmark-${process.pid}-${Date.now()}-${sandboxSequence++}`;
  const writablePaths = [...new Set([
    ...(options.includeCleanWorkspace === false ? [] : [cleanWorkspace]),
    agentHome,
    ...(options.writablePaths || [])
  ])];
  const properties = [
    '--property=ProtectHome=tmpfs',
    '--property=PrivateTmp=yes',
    '--property=PrivateIPC=yes',
    '--property=TemporaryFileSystem=/dev/shm:rw,nosuid,nodev,noexec,mode=1777',
    '--property=ProtectProc=invisible',
    '--property=ProtectSystem=strict',
    '--property=NoNewPrivileges=yes',
    '--property=PrivateDevices=yes',
    '--property=ProtectKernelTunables=yes',
    '--property=ProtectKernelModules=yes',
    '--property=ProtectControlGroups=yes',
    '--property=RestrictSUIDSGID=yes',
    '--property=LockPersonality=yes',
    '--property=RestrictNamespaces=yes',
    '--property=KillMode=control-group',
    '--property=TimeoutStopSec=2s',
    '--property=SendSIGKILL=yes',
    `--property=BindReadOnlyPaths=${opencodeRoot}`,
    `--property=WorkingDirectory=${targetCwd}`,
    `--property=TimeoutStartSec=${Math.ceil((options.timeoutMs ?? timeoutMs) / 1000)}s`,
    ...writablePaths.map((item) => `--property=BindPaths=${item}`)
  ];
  return run('sudo', [
    'systemd-run', '--quiet', '--pipe', '--wait', '--collect', `--unit=${unit}`, `--uid=${candidateUser}`,
    ...properties, '--', '/usr/bin/env', ...envArgs, command, ...args
  ], {
    ...options,
    timeoutMs: (options.timeoutMs ?? timeoutMs) + 5000,
    onOutputLimit: () => {
      const killer = spawn('sudo', ['systemctl', 'kill', '--kill-whom=all', unit], { stdio: 'ignore' });
      killer.unref();
    },
    cwd: '/tmp'
  });
}

function runAsJudge(command, args, options = {}) {
  return runAsCandidate(command, args, { ...options, includeCleanWorkspace: false });
}

async function resetRoom(task) {
  cleanRoomTouched = true;
  emit('reset_started', { task: task.id, workspace: cleanWorkspace });
  await installResetScript();
  await installArchive(task);
  const reset = await runAsCleanRoomHost('/usr/bin/node', [resetScript, '--archive-root', archiveRoot, '--fixture', task.fixture, '--prompt', task.prompt, '--workspace', cleanWorkspace, '--agent-home', agentHome, '--sandbox-root', cleanRoomHome], { timeoutMs: 30000 });
  if (reset.status !== 0) throw new Error(`reset failed: ${reset.stderr}`);
  emit('reset_completed', { task: task.id });
}

async function snapshotBaseline(task) {
  const baselineWorkspace = path.join(baselineRoot, task.id);
  await runAsCleanRoomHost('rm', ['-rf', baselineWorkspace], { timeoutMs: 30000 });
  await runAsCleanRoomHost('mkdir', ['-p', baselineWorkspace], { timeoutMs: 30000 });
  const copied = await runAsCleanRoomHost('cp', ['-a', `${cleanWorkspace}/.`, baselineWorkspace], { timeoutMs: 30000 });
  if (copied.status !== 0) throw new Error(`cannot snapshot trusted baseline: ${copied.stderr}`);
}

async function compareAgainstBaseline(task) {
  const baselineWorkspace = path.join(baselineRoot, task.id);
  const comparisonWorkspace = path.join(comparisonRoot, task.id);
  const plan = buildBaselineComparisonPlan({ baselineWorkspace, candidateWorkspace: cleanWorkspace, comparisonWorkspace });
  await runAsCleanRoomHost('rm', ['-rf', comparisonWorkspace], { timeoutMs: 30000 });
  await runAsCleanRoomHost('mkdir', ['-p', comparisonWorkspace], { timeoutMs: 30000 });
  const baseline = await runAsCleanRoomHost(plan.copyBaseline[0], plan.copyBaseline.slice(1), { timeoutMs: 30000 });
  if (baseline.status !== 0) throw new Error(`cannot prepare comparison baseline: ${baseline.stderr}`);
  // Mirror only the candidate's working tree. The candidate-controlled .git is
  // deliberately excluded, so candidate commits cannot hide file changes.
  const mirrored = await runAsCleanRoomHost(plan.mirrorCandidateTree[0], plan.mirrorCandidateTree.slice(1), { timeoutMs: 30000 });
  if (mirrored.status !== 0) throw new Error(`cannot mirror candidate tree: ${mirrored.stderr}`);
  const intentToAdd = await runAsCleanRoomHost(plan.addIntent[0], plan.addIntent.slice(1), { timeoutMs: 30000 });
  if (intentToAdd.status !== 0) throw new Error(`cannot include untracked files in diff: ${intentToAdd.stderr}`);
  const diff = await runAsCleanRoomHost(plan.diff[0], plan.diff.slice(1), { timeoutMs: 30000 });
  const status = await runAsCleanRoomHost(plan.status[0], plan.status.slice(1), { timeoutMs: 30000 });
  if (diff.status !== 0 || status.status !== 0) throw new Error(`cannot inspect candidate tree: ${diff.stderr || status.stderr}`);
  await runAsCleanRoomHost('rm', ['-rf', comparisonWorkspace], { timeoutMs: 30000 });
  return { diff: diff.stdout, changedFiles: parsePorcelainPaths(status.stdout) };
}

async function runJudges(candidate, task, candidateResult) {
  for (const judge of config.judges) {
    const publicJudgeDir = path.join(resultsDir, config.release, candidate.id, task.id, 'judges');
    const privateJudgeDir = path.join(privateDir, candidate.id, task.id, 'judges', judge.id);
    await mkdir(publicJudgeDir, { recursive: true });
    await mkdir(privateJudgeDir, { recursive: true, mode: 0o700 });
    if (['agent_failure', 'unavailable', 'forbidden_changes'].includes(candidateResult.outcome)) {
      await writeJson(path.join(publicJudgeDir, `${judge.id}.json`), {
        schema_version: 1,
        judge: { id: judge.id, agent: judge.agent, model: judge.model, subscription: judge.subscription },
        status: 'skipped',
        reason: candidateResult.outcome,
        candidate: candidate.id,
        task: task.id
      });
      continue;
    }
    const judgeWorkspace = createAnonymousJudgeWorkspace(judgeRoot);
    // Rebuild from the trusted archive for every judge. Never copy the
    // candidate's .git or any candidate-controlled metadata into judging.
    await resetRoom(task);
    await runAsCleanRoomHost('rm', ['-rf', judgeWorkspace], { timeoutMs: 30000 });
    await runAsCleanRoomHost('mkdir', ['-p', judgeWorkspace], { timeoutMs: 30000 });
    const copied = await runAsCleanRoomHost('cp', ['-a', `${cleanWorkspace}/.`, judgeWorkspace], { timeoutMs: 30000 });
    if (copied.status !== 0) throw new Error(`cannot prepare judge workspace: ${copied.stderr}`);
    const candidateDiff = path.join(resultsDir, config.release, candidate.id, task.id, 'candidate.diff');
    const judgePatch = path.join(judgeRoot, `.${path.basename(judgeWorkspace)}.diff`);
    const installedPatch = await run('sudo', ['install', '-o', candidateUser, '-g', candidateUser, '-m', '0600', candidateDiff, judgePatch], { timeoutMs: 30000 });
    if (installedPatch.status !== 0) throw new Error(`cannot stage candidate submission: ${installedPatch.stderr}`);
    const applied = await runAsCleanRoomHost('git', ['-C', judgeWorkspace, 'apply', '--allow-empty', judgePatch], { timeoutMs: 30000 });
    await runAsCleanRoomHost('rm', ['-f', judgePatch], { timeoutMs: 30000 });
    if (applied.status !== 0) throw new Error(`cannot apply candidate submission: ${applied.stderr}`);
    await runAsCleanRoomHost('rm', ['-rf', agentHome], { timeoutMs: 30000 });
    await runAsCleanRoomHost('mkdir', ['-p', agentHome], { timeoutMs: 30000 });
    const prompt = buildJudgePrompt({ taskId: task.id, criteria: config.criteria, candidateResult });
    const command = buildJudgeInvocation({ judge, judgeWorkspace, prompt });
    const result = await runAsJudge(command.command, command.args, {
      cwd: command.cwd,
      writablePaths: buildJudgeWritablePaths({ agentHome, judgeWorkspace }),
      timeoutMs
    });
    await writeFile(path.join(privateJudgeDir, 'judge.stdout.txt'), result.stdout);
    await writeFile(path.join(privateJudgeDir, 'judge.stderr.txt'), result.stderr);
    const response = extractJudgeText(result.stdout);
    const parsed = result.status === 0 ? parseJudgeJson(response) : null;
    await writeJson(path.join(publicJudgeDir, `${judge.id}.json`), {
      schema_version: 1,
      judge: { id: judge.id, agent: judge.agent, model: judge.model, subscription: judge.subscription },
      status: result.status !== 0 ? 'failed' : parsed ? 'completed' : 'invalid_output',
      response,
      scores: parsed?.scores ?? null,
      confidence: parsed?.confidence ?? null,
      explanation: parsed?.explanation ?? null,
      concerns: parsed?.concerns ?? [],
      execution: {
        status: result.status,
        signal: result.signal,
        timed_out: result.timed_out,
        started_at: result.started_at,
        completed_at: result.completed_at,
        duration_ms: result.duration_ms
      },
      candidate: candidate.id,
      task: task.id
    });
    await runAsCleanRoomHost('rm', ['-rf', judgeWorkspace], { timeoutMs: 30000 });
  }
}

async function probeModel(model, task, role) {
  await resetRoom(task);
  const command = commandFor(model, 'Reply with exactly: hi. Do not modify files.');
  emit('model_preflight_started', { role, id: model.id, agent: model.agent, model: model.model });
  const result = await runAsCandidate(command.command, command.args, { cwd: cleanWorkspace, timeoutMs: Math.min(timeoutMs, 60000) });
  const available = result.status === 0 && !result.timed_out && !result.output_limited && hasModelResponse(result.stdout, model.agent);
  const reason = available ? null : result.timed_out ? 'timeout' : result.output_limited ? 'output_limited' : result.status !== 0 ? 'process_failure' : 'no_model_response';
  emit('model_preflight_completed', { role, id: model.id, status: available ? 'available' : 'unavailable', reason });
  return { available, reason, result };
}

async function preflightCandidate(candidate, task) {
  const probe = await probeModel(candidate, task, 'candidate');
  const candidateRoot = path.join(resultsDir, config.release, candidate.id);
  await writeJson(path.join(candidateRoot, 'preflight.json'), {
    schema_version: 1,
    candidate,
    status: probe.available ? 'available' : 'unavailable',
    reason: probe.reason,
    started_at: probe.result.started_at,
    completed_at: probe.result.completed_at,
    duration_ms: probe.result.duration_ms,
    process_status: probe.result.status,
    timed_out: probe.result.timed_out,
    output_limited: probe.result.output_limited
  });
  const privateRoot = path.join(privateDir, candidate.id);
  await mkdir(privateRoot, { recursive: true, mode: 0o700 });
  await writeFile(path.join(privateRoot, 'preflight.stdout.txt'), probe.result.stdout);
  await writeFile(path.join(privateRoot, 'preflight.stderr.txt'), probe.result.stderr);
  return probe;
}

async function recordUnavailableCandidate(candidate, task, preflight) {
  const candidateDir = path.join(resultsDir, config.release, candidate.id, task.id);
  await mkdir(candidateDir, { recursive: true });
  const startedAt = new Date().toISOString();
  await writeJson(path.join(candidateDir, 'run.json'), {
    schema_version: 1,
    release: config.release,
    task: task.id,
    candidate,
    started_at: startedAt,
    completed_at: startedAt,
    duration_ms: 0,
    agent: null,
    tests: null,
    outcome: 'unavailable',
    availability: {
      reason: preflight.reason,
      preflight: 'model_preflight',
      started_at: preflight.result.started_at,
      completed_at: preflight.result.completed_at,
      duration_ms: preflight.result.duration_ms
    },
    changed_files: [],
    forbidden_changes: [],
    artifacts: { public_dir: path.relative(modelsTest, candidateDir) }
  });
  emit('candidate_skipped', { candidate: candidate.id, task: task.id, outcome: 'unavailable', reason: preflight.reason });
}

async function runCandidate(candidate, task) {
  const candidateDir = path.join(resultsDir, config.release, candidate.id, task.id);
  const privateCandidateDir = path.join(privateDir, candidate.id, task.id);
  await mkdir(candidateDir, { recursive: true });
  await mkdir(privateCandidateDir, { recursive: true, mode: 0o700 });
  await resetRoom(task);
  await snapshotBaseline(task);
  const prompt = await readFile(path.join(modelsTest, task.prompt), 'utf8');
  const command = commandFor(candidate, prompt);
  emit('candidate_started', { candidate: candidate.id, agent: candidate.agent, model: candidate.model, task: task.id });
  const agent = await runAsCandidate(command.command, command.args, { cwd: cleanWorkspace, timeoutMs });
  await writeFile(path.join(privateCandidateDir, 'agent.stdout.txt'), agent.stdout);
  await writeFile(path.join(privateCandidateDir, 'agent.stderr.txt'), agent.stderr);
  const tests = await runAsCandidate(task.test_command[0], task.test_command.slice(1), { cwd: path.join(cleanWorkspace, task.fixture), timeoutMs });
  await writeJson(path.join(candidateDir, 'test-result.json'), {
    status: tests.status,
    timed_out: tests.timed_out,
    output_limited: tests.output_limited,
    started_at: tests.started_at,
    completed_at: tests.completed_at,
    duration_ms: tests.duration_ms,
    stdout: tests.stdout,
    stderr: tests.stderr
  });
  const compared = await compareAgainstBaseline(task);
  const changedFiles = compared.changedFiles;
  const forbiddenChanges = findForbiddenChanges(changedFiles, task.allowed_changes);
  const outcome = classifyOutcome({ agent, tests, forbiddenChanges });
  await writeFile(path.join(candidateDir, 'candidate.diff'), compared.diff);
  const record = {
    schema_version: 1,
    release: config.release,
    task: task.id,
    candidate,
    started_at: agent.started_at,
    completed_at: tests.completed_at,
    duration_ms: tests.completed_at && agent.started_at ? new Date(tests.completed_at).getTime() - new Date(agent.started_at).getTime() : null,
    agent: {
      status: agent.status,
      signal: agent.signal,
      timed_out: agent.timed_out,
      output_limited: agent.output_limited,
      started_at: agent.started_at,
      completed_at: agent.completed_at,
      duration_ms: agent.duration_ms
    },
    tests: {
      status: tests.status,
      timed_out: tests.timed_out,
      output_limited: tests.output_limited,
      started_at: tests.started_at,
      completed_at: tests.completed_at,
      duration_ms: tests.duration_ms
    },
    outcome,
    changed_files: changedFiles,
    forbidden_changes: forbiddenChanges,
    artifacts: { public_dir: path.relative(modelsTest, candidateDir) },
  };
  await writeJson(path.join(candidateDir, 'run.json'), record);
  await runJudges(candidate, task, record);
  emit('candidate_completed', { candidate: candidate.id, task: task.id, outcome, agent_status: agent.status, test_status: tests.status, result_dir: candidateDir });
}

if (!existsSync(modelsTest)) throw new Error(`models-test checkout not found: ${modelsTest}`);
if (dryRun) {
  emit('dry_run', { release: config.release, task_count: config.tasks.length, candidates: config.candidates.map((candidate) => ({ id: candidate.id, agent: candidate.agent, model: candidate.model })) });
  process.exit(0);
}

if (existsSync(publicReleaseDir) || existsSync(privateDir)) {
  throw new Error(`benchmark release already exists: ${config.release}; choose a new immutable release identifier`);
}

const cleanRoomLock = await acquireCleanRoomLock(cleanRoomLockPath, {
  release: config.release,
  workspace: cleanWorkspace
});
let cleanRoomSafe = false;
try {
  const rsync = await run('rsync', ['--version'], { timeoutMs: 5000 });
  if (rsync.status !== 0) throw new Error(`rsync is required for trusted baseline comparison: ${rsync.stderr}`);
  const account = await run('getent', ['passwd', candidateUser], { timeoutMs: 5000 });
  if (account.status !== 0) throw new Error(`clean-room account not found: ${candidateUser}`);
  await assertCleanRoomUserIsIdle();
  if (!existsSync(opencodeRoot)) throw new Error(`OpenCode runtime root not found: ${opencodeRoot}`);
  const opencode = await runAsCandidate('opencode', ['--version'], { timeoutMs: 10000 });
  if (opencode.status !== 0) throw new Error(`OpenCode is unavailable for ${candidateUser}: ${opencode.stderr}`);
  emit('preflight_ok', { candidate_user: candidateUser, opencode_version: opencode.stdout.trim() });

  for (const judge of config.judges) {
    const probe = await probeModel(judge, config.tasks[0], 'judge');
    if (!probe.available) throw new Error(`required judge model is unavailable: ${judge.id}; no release directory was created`);
  }

  await mkdir(resultsDir, { recursive: true });
  for (const candidate of config.candidates) {
    const preflight = await preflightCandidate(candidate, config.tasks[0]);
    if (!preflight.available) {
      for (const task of config.tasks) await recordUnavailableCandidate(candidate, task, preflight);
      continue;
    }
    for (const task of config.tasks) await runCandidate(candidate, task);
  }
  await resetRoom(config.tasks[config.tasks.length - 1]);
  await runAsCleanRoomHost('rm', ['-rf', baselineRoot, comparisonRoot], { timeoutMs: 30000 });
  cleanRoomSafe = true;
  emit('clean_room_final_reset', { workspace: cleanWorkspace, agent_home: agentHome });
  emit('pilot_completed', { results_dir: resultsDir, publication: 'manual' });
} finally {
  try {
    if (cleanRoomTouched && !cleanRoomSafe) {
      await resetRoom(config.tasks[config.tasks.length - 1]);
      await runAsCleanRoomHost('rm', ['-rf', baselineRoot, comparisonRoot], { timeoutMs: 30000 });
      cleanRoomSafe = true;
      emit('clean_room_final_reset', { workspace: cleanWorkspace, agent_home: agentHome, after_failure: true });
    }
  } catch (cleanupError) {
    await retainCleanRoomLock(cleanRoomLock, cleanupError);
    emit('clean_room_lock_retained', { lock_path: cleanRoomLock.path, reason: String(cleanupError.message || cleanupError) });
    throw cleanupError;
  } finally {
    if (cleanRoomSafe || !cleanRoomTouched) {
      await releaseCleanRoomLock(cleanRoomLock);
    }
  }
}
