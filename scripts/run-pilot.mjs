#!/usr/bin/env node
import { cp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  classifyOutcome,
  createBoundedCollector,
  findForbiddenChanges,
  hasModelResponse,
  parsePorcelainPaths,
  summarizeModelUsage,
  validateJudgePayload
} from './lib/runner-utils.mjs';
import { validateSchemaVersion, getSchemaVersion, getRegistry, loadSchemaRegistry } from './lib/schema-registry.mjs';
import { computeFileHash, computeArtifactHash, computeHash, verifyFileHash } from './lib/artifact-hash.mjs';
import { assertNoKnownCredentialLeak, collectSecretLikeStrings } from './lib/publication-guard.mjs';
import {
  buildJudgeInvocation,
  buildJudgeEnvironment,
  buildJudgePromptAsync,
  buildJudgePromptWithHash,
  buildJudgeWritablePaths,
  buildBaselineComparisonPlan,
  createAnonymousJudgeWorkspace,
  getJudgePromptMetadata
} from './lib/blind-judging.mjs';
import { acquireCleanRoomLock, releaseCleanRoomLock, retainCleanRoomLock } from './lib/clean-room-lock.mjs';
import { hashTree } from './lib/tree-hash.mjs';
import {
  buildObjectiveSandboxInvocation,
  objectiveWorkspaceCreateCommand,
  objectiveWorkspaceCleanupCommand,
  objectiveWorkspaceHandoffCommand,
  objectiveWorkspaceRuntimeDir
} from './lib/objective-sandbox.mjs';
import { createObjectiveWorkspace } from './lib/objective-workspace.mjs';

const repo = path.resolve(new URL('..', import.meta.url).pathname);
const configPath = process.env.BENCHMARK_CONFIG
  ? path.resolve(process.env.BENCHMARK_CONFIG)
  : path.join(repo, 'config', 'pilot.json');
const config = JSON.parse(await readFile(configPath, 'utf8'));
const schemaRegistry = await loadSchemaRegistry(configPath);
const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const resume = argv.includes('--resume');
function optionValues(name) {
  const values = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === name && argv[i + 1]) values.push(...argv[i + 1].split(',').filter(Boolean));
  }
  return values;
}
// Candidate execution and objective tests are the safe default. Model judging
// is a separate, explicit stage so a normal benchmark run never spends judge
// quota or mixes assessment with candidate evidence collection.
const phase = optionValues('--phase')[0] || 'candidates';
if (!['all', 'candidates', 'judges'].includes(phase)) throw new Error(`invalid --phase: ${phase}`);
const nominations = config.nominations ?? config.tasks ?? [];
const nominationValues = optionValues('--nomination');
const legacyTaskValues = optionValues('--task');
if (nominationValues.length && legacyTaskValues.length) throw new Error('use --nomination; --task is a deprecated compatibility alias and cannot be combined with it');
if (legacyTaskValues.length) process.stderr.write('warning: --task is deprecated; use --nomination instead\n');
if (config.require_nomination_selection === true && !(nominationValues.length || legacyTaskValues.length)) {
  throw new Error('this benchmark requires explicit --nomination <id> selection');
}
const selectedAttempt = Number(optionValues('--attempt')[0] || config.retry_policy?.canonical_attempt || 1);
if (!Number.isInteger(selectedAttempt) || selectedAttempt < 1) throw new Error('--attempt must be a positive integer');
if (selectedAttempt > 1 && config.retry_policy?.allow_retries !== true) {
  throw new Error(`attempt ${selectedAttempt} is not permitted by this benchmark retry policy`);
}
if (selectedAttempt > 1 && !optionValues('--attempt').length) throw new Error('a retry requires an explicit --attempt value');
const timeoutMs = Number(process.env.BENCHMARK_TIMEOUT_MS || 15 * 60 * 1000);
const maxOutputBytes = Number(process.env.BENCHMARK_MAX_OUTPUT_BYTES || 2 * 1024 * 1024);
const modelsTest = path.resolve(config.models_test);
const expandHome = (value) => value.replace(/^~(?=$|\/)/, os.homedir());
const privateEvaluatorsDir = path.resolve(expandHome(config.private_evaluators_dir || path.join(repo, 'evaluators')));
const cleanWorkspace = path.resolve(expandHome(config.clean_room.workspace));
const agentHome = path.resolve(expandHome(config.clean_room.agent_home));
const candidateUser = config.clean_room.user;
const cleanRoomHome = path.resolve(config.clean_room.home);
const cleanRoomAuthFile = path.join(cleanRoomHome, '..', '.local', 'share', 'opencode', 'auth.json');
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
const releaseManifestPath = path.join(publicReleaseDir, 'manifest.json');
const opencodeRoot = path.resolve(config.clean_room.opencode_root);
let sandboxSequence = 0;
let cleanRoomTouched = false;
let knownCredentials = new Set();

function publicAttemptDir(candidate, nomination, attempt = selectedAttempt) {
  return path.join(publicReleaseDir, candidate.id, nomination.id, 'attempts', `attempt-${attempt}`);
}

function privateAttemptDir(candidate, nomination, attempt = selectedAttempt) {
  return path.join(privateDir, candidate.id, nomination.id, 'attempts', `attempt-${attempt}`);
}

function runId(candidate, nomination) {
  return `${config.release}:${candidate.id}:${nomination.id}`;
}

function emit(event, data = {}) {
  process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), event, ...data })}\n`);
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function loadKnownCredentials() {
  if (!existsSync(cleanRoomAuthFile)) return new Set();
  try {
    const auth = JSON.parse(await readFile(cleanRoomAuthFile, 'utf8'));
    return new Set(collectSecretLikeStrings(auth));
  } catch {
    // This guard is deliberately best-effort. Authentication setup retains its
    // existing behavior; a malformed optional auth file must never be echoed.
    return new Set();
  }
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
  const args = ['run', '--model', candidate.model];
  if (candidate.reasoning_variant && candidate.reasoning_variant !== 'provider_default') args.push('--variant', candidate.reasoning_variant);
  args.push('--dir', cleanWorkspace, '--dangerously-skip-permissions', '--format', 'json', prompt);
  return { command: 'opencode', args };
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

function runtimeProbeEnv() {
  return {
    HOME: '/tmp',
    PATH: `${opencodeRoot}/bin:/usr/local/bin:/usr/bin:/bin`,
    XDG_CONFIG_HOME: '/tmp/.config',
    XDG_DATA_HOME: '/tmp/.local/share',
    TMPDIR: '/tmp'
  };
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
  const env = options.sandboxEnv || cleanRoomEnv();
  const { sandboxEnv, ...runOptions } = options;
  const envArgs = Object.entries(env).map(([key, value]) => `${key}=${value}`);
  const targetCwd = options.cwd || cleanWorkspace;
  const unit = `models-benchmark-${process.pid}-${Date.now()}-${sandboxSequence++}`;
  const writablePaths = [...new Set([
    ...(options.includeCleanWorkspace === false ? [] : [cleanWorkspace]),
    ...(options.includeAgentHome === false ? [] : [agentHome]),
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
    ...runOptions,
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

// Objective checks are deliberately *not* trusted-host Node processes.  The
// candidate patch is executable JavaScript, so importing it as gpt would turn
// the evaluator into a credential/private-artifact escape hatch.  This unit
// has only one disposable bind and no provider runtime, agent home, or network.
function runObjectiveInSandbox(workspace, evaluatorFile, sourceFile, options = {}) {
  const unit = `models-objective-${process.pid}-${Date.now()}-${sandboxSequence++}`;
  return run('sudo', buildObjectiveSandboxInvocation({
    unit, user: candidateUser, workspace, evaluatorFile, sourceFile,
    timeoutMs: options.timeoutMs ?? timeoutMs
  }), {
    ...options, timeoutMs: (options.timeoutMs ?? timeoutMs) + 5000, cwd: '/tmp'
  });
}

async function resetRoom(task) {
  cleanRoomTouched = true;
  emit('reset_started', { nomination: task.id, workspace: cleanWorkspace });
  await installResetScript();
  await installArchive(task);
  const reset = await runAsCleanRoomHost('/usr/bin/node', [resetScript, '--archive-root', archiveRoot, '--fixture', task.fixture, '--prompt', task.prompt, '--workspace', cleanWorkspace, '--agent-home', agentHome, '--sandbox-root', cleanRoomHome], { timeoutMs: 30000 });
  if (reset.status !== 0) throw new Error(`reset failed: ${reset.stderr}`);
  if (existsSync(cleanRoomAuthFile)) {
    const authTarget = path.join(agentHome, '.local', 'share', 'opencode', 'auth.json');
    const auth = await runAsCleanRoomHost('install', ['-D', '-m', '0600', cleanRoomAuthFile, authTarget], { timeoutMs: 30000 });
    if (auth.status !== 0) throw new Error(`cannot install clean-room OpenCode credentials: ${auth.stderr}`);
  }
  await assertPreparedWorkspace(task);
  emit('reset_completed', { nomination: task.id });
}

async function assertPreparedWorkspace(task) {
  const sourceFixture = path.join(modelsTest, task.fixture);
  const workspaceFixture = path.join(cleanWorkspace, task.fixture);
  const fixtureCheck = await run('sudo', ['diff', '-qr', '--no-dereference', sourceFixture, workspaceFixture], { timeoutMs: 30000 });
  if (fixtureCheck.status !== 0) {
    throw new Error(`prepared workspace fixture differs from frozen source: ${task.id}: ${fixtureCheck.stdout || fixtureCheck.stderr}`);
  }
  const sourcePrompt = path.join(modelsTest, task.prompt);
  const workspacePrompt = path.join(cleanWorkspace, task.prompt);
  const promptCheck = await run('sudo', ['cmp', '-s', '--', sourcePrompt, workspacePrompt], { timeoutMs: 30000 });
  if (promptCheck.status !== 0) throw new Error(`prepared workspace prompt differs from frozen source: ${task.id}`);
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

async function runJudges(candidate, task, candidateResult, judges) {
  for (const judge of judges) {
    const attemptDir = publicAttemptDir(candidate, task);
    const publicJudgeDir = path.join(attemptDir, 'judges');
    const privateJudgeDir = path.join(privateAttemptDir(candidate, task), 'judges', judge.id);
    await mkdir(publicJudgeDir, { recursive: true });
    await mkdir(privateJudgeDir, { recursive: true, mode: 0o700 });
    if (['agent_failure', 'unavailable', 'forbidden_changes'].includes(candidateResult.outcome)) {
      const judgeArtifact = {
        schema_version: getSchemaVersion('judge', schemaRegistry.artifact_schemas),
        judge: { id: judge.id, agent: judge.agent, model: judge.model, subscription: judge.subscription, reasoning_variant: judge.reasoning_variant ?? 'provider_default' },
        status: 'skipped',
        reason: candidateResult.outcome,
        candidate: candidate.id,
        nomination: task.id,
        run_id: runId(candidate, task),
        attempt: selectedAttempt
      };
      const judgeHash = computeArtifactHash(judgeArtifact);
      judgeArtifact.artifact_hash = { path: `${judge.id}.json`, sha256: judgeHash };
      await writeJson(path.join(publicJudgeDir, `${judge.id}.json`), judgeArtifact);
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
    const candidateDiff = path.join(attemptDir, 'candidate.diff');
    const judgePatch = path.join(judgeRoot, `.${path.basename(judgeWorkspace)}.diff`);
    const installedPatch = await run('sudo', ['install', '-o', candidateUser, '-g', candidateUser, '-m', '0600', candidateDiff, judgePatch], { timeoutMs: 30000 });
    if (installedPatch.status !== 0) throw new Error(`cannot stage candidate submission: ${installedPatch.stderr}`);
    const applied = await runAsCleanRoomHost('git', ['-C', judgeWorkspace, 'apply', '--allow-empty', judgePatch], { timeoutMs: 30000 });
    await runAsCleanRoomHost('rm', ['-f', judgePatch], { timeoutMs: 30000 });
    if (applied.status !== 0) throw new Error(`cannot apply candidate submission: ${applied.stderr}`);
    await runAsCleanRoomHost('rm', ['-rf', agentHome], { timeoutMs: 30000 });
    await runAsCleanRoomHost('mkdir', ['-p', agentHome], { timeoutMs: 30000 });
    const taskInstructions = await readFile(path.join(modelsTest, task.prompt), 'utf8');
    const { prompt, prompt_hash } = await buildJudgePromptWithHash({ taskId: task.id, taskInstructions, criteria: config.criteria, candidateResult });
    const promptMeta = await getJudgePromptMetadata();
    const command = buildJudgeInvocation({ judge, judgeWorkspace, prompt });
    const result = await runAsJudge(command.command, command.args, {
      cwd: command.cwd,
      writablePaths: buildJudgeWritablePaths({ agentHome, judgeWorkspace }),
      timeoutMs
    });
    await writeFile(path.join(privateJudgeDir, 'judge.stdout.txt'), result.stdout);
    await writeFile(path.join(privateJudgeDir, 'judge.stderr.txt'), result.stderr);
    const response = extractJudgeText(result.stdout);
    assertNoKnownCredentialLeak(response, knownCredentials);
    const parsed = result.status === 0 ? parseJudgeJson(response) : null;
    const judgeArtifact = {
      schema_version: getSchemaVersion('judge', schemaRegistry.artifact_schemas),
      judge: { id: judge.id, agent: judge.agent, model: judge.model, subscription: judge.subscription, reasoning_variant: judge.reasoning_variant ?? 'provider_default' },
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
        duration_ms: result.duration_ms,
        usage: summarizeModelUsage(result.stdout, judge.agent)
      },
      judge_prompt_version: promptMeta.version,
      judge_prompt_hash: prompt_hash,
      candidate: candidate.id,
      nomination: task.id,
      run_id: runId(candidate, task),
      attempt: selectedAttempt
    };
    const judgeHash = computeArtifactHash(judgeArtifact);
    judgeArtifact.artifact_hash = { path: `${judge.id}.json`, sha256: judgeHash };
    await writeJson(path.join(publicJudgeDir, `${judge.id}.json`), judgeArtifact);
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
  const preflightPath = path.join(candidateRoot, 'preflight.json');
  const preflightArtifact = {
    schema_version: getSchemaVersion('preflight', schemaRegistry.artifact_schemas),
    candidate,
    status: probe.available ? 'available' : 'unavailable',
    reason: probe.reason,
    started_at: probe.result.started_at,
    completed_at: probe.result.completed_at,
    duration_ms: probe.result.duration_ms,
    process_status: probe.result.status,
    timed_out: probe.result.timed_out,
    output_limited: probe.result.output_limited,
    usage: summarizeModelUsage(probe.result.stdout, candidate.agent),
    notes: ['Availability preflight uses an exact hi request; provider/model default reasoning is preserved unless reasoning_variant is explicit.']
  };
  const preflightHash = computeArtifactHash(preflightArtifact);
  preflightArtifact.artifact_hash = { path: 'preflight.json', sha256: preflightHash };
  await writeJson(preflightPath, preflightArtifact);
  const privateRoot = path.join(privateDir, candidate.id);
  await mkdir(privateRoot, { recursive: true, mode: 0o700 });
  await writeFile(path.join(privateRoot, 'preflight.stdout.txt'), probe.result.stdout);
  await writeFile(path.join(privateRoot, 'preflight.stderr.txt'), probe.result.stderr);
  return probe;
}

async function recordUnavailableCandidate(candidate, task, preflight) {
  const candidateDir = publicAttemptDir(candidate, task);
  await mkdir(candidateDir, { recursive: true });
  const startedAt = new Date().toISOString();
  const runArtifact = {
    schema_version: getSchemaVersion('run', schemaRegistry.artifact_schemas),
    release: config.release,
    nomination: task.id,
    run_id: runId(candidate, task),
    attempt: selectedAttempt,
    candidate: { ...candidate, reasoning_variant: candidate.reasoning_variant ?? 'provider_default' },
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
  };
  const runHash = computeArtifactHash(runArtifact);
  runArtifact.artifact_hash = { path: 'run.json', sha256: runHash };
  await writeJson(path.join(candidateDir, 'run.json'), runArtifact);
  emit('candidate_skipped', { candidate: candidate.id, nomination: task.id, attempt: selectedAttempt, outcome: 'unavailable', reason: preflight.reason });
}

async function runCandidate(candidate, task) {
  const candidateDir = publicAttemptDir(candidate, task);
  const privateCandidateDir = privateAttemptDir(candidate, task);
  await mkdir(candidateDir, { recursive: true });
  await mkdir(privateCandidateDir, { recursive: true, mode: 0o700 });
  await resetRoom(task);
  await snapshotBaseline(task);
  const prompt = await readFile(path.join(modelsTest, task.prompt), 'utf8');
  const command = commandFor(candidate, prompt);
  emit('candidate_started', { candidate: candidate.id, agent: candidate.agent, model: candidate.model, nomination: task.id, attempt: selectedAttempt });
  const agent = await runAsCandidate(command.command, command.args, { cwd: cleanWorkspace, timeoutMs });
  await writeFile(path.join(privateCandidateDir, 'agent.stdout.txt'), agent.stdout);
  await writeFile(path.join(privateCandidateDir, 'agent.stderr.txt'), agent.stderr);
  const compared = await compareAgainstBaseline(task);
  const changedFiles = compared.changedFiles;
  const forbiddenChanges = findForbiddenChanges(changedFiles, task.allowed_changes);
  assertNoKnownCredentialLeak(JSON.stringify({ changedFiles, forbiddenChanges }), knownCredentials);
  const diffPath = path.join(candidateDir, 'candidate.diff');
  assertNoKnownCredentialLeak(compared.diff, knownCredentials);
  await writeFile(diffPath, compared.diff);
  const diffHash = await computeFileHash(diffPath);
  const objectiveEvaluator = task.objective_evaluator
    ? await runObjectiveEvaluator(candidate, task, diffPath, privateCandidateDir)
    : null;
  const tests = await runAsCandidate(task.test_command[0], task.test_command.slice(1), { cwd: cleanWorkspace, timeoutMs });
  await writeFile(path.join(privateCandidateDir, 'public-test.stdout.txt'), tests.stdout);
  await writeFile(path.join(privateCandidateDir, 'public-test.stderr.txt'), tests.stderr);
  const testResultArtifact = {
    schema_version: getSchemaVersion('test_result', schemaRegistry.artifact_schemas),
    status: tests.status,
    timed_out: tests.timed_out,
    output_limited: tests.output_limited,
    started_at: tests.started_at,
    completed_at: tests.completed_at,
    duration_ms: tests.duration_ms,
    stdout_sha256: await computeHash(tests.stdout),
    stderr_sha256: await computeHash(tests.stderr)
  };
  const testResultHash = computeArtifactHash(testResultArtifact);
  testResultArtifact.artifact_hash = { path: 'test-result.json', sha256: testResultHash };
  const testResultPath = path.join(candidateDir, 'test-result.json');
  await writeJson(testResultPath, testResultArtifact);
  const testResultFileHash = await computeFileHash(testResultPath);
  const outcome = classifyOutcome({ agent, tests, forbiddenChanges });
  const record = {
    schema_version: getSchemaVersion('run', schemaRegistry.artifact_schemas),
    release: config.release,
    nomination: task.id,
    run_id: runId(candidate, task),
    attempt: selectedAttempt,
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
      duration_ms: agent.duration_ms,
      usage: summarizeModelUsage(agent.stdout, candidate.agent)
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
    notes: [
      `Reasoning variant: ${candidate.reasoning_variant ?? 'provider_default'}.`,
      'Model cost is provider-reported from OpenCode step_finish events when available; it is not estimated.'
    ],
    artifacts: {
      public_dir: path.relative(modelsTest, candidateDir),
      candidate_diff: { path: 'candidate.diff', sha256: diffHash },
      test_result: { path: 'test-result.json', sha256: testResultFileHash },
      ...(objectiveEvaluator ? { objective_evaluator: objectiveEvaluator } : {})
    }
  };
  const runHash = computeArtifactHash(record);
  record.artifact_hash = { path: 'run.json', sha256: runHash };
  await writeJson(path.join(candidateDir, 'run.json'), record);
  emit('candidate_completed', { candidate: candidate.id, nomination: task.id, attempt: selectedAttempt, outcome, agent_status: agent.status, test_status: tests.status, result_dir: candidateDir });
}

function pathIsWithin(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

async function resolveTrustedRelativePath(root, relativePath, label) {
  if (typeof relativePath !== 'string' || !relativePath || path.isAbsolute(relativePath)) {
    throw new Error(`invalid ${label} path`);
  }
  const resolved = path.resolve(root, relativePath);
  if (!pathIsWithin(root, resolved)) throw new Error(`${label} path escapes its trusted root`);
  // Resolve links before use: lexical containment alone permits a symlink to
  // redirect an otherwise safe-looking path outside its trusted root.
  let realRoot;
  let realResolved;
  try {
    [realRoot, realResolved] = await Promise.all([realpath(root), realpath(resolved)]);
  } catch {
    throw new Error(`${label} trusted input is unavailable`);
  }
  if (!pathIsWithin(realRoot, realResolved)) throw new Error(`${label} path escapes its trusted root`);
  return realResolved;
}

async function objectiveEvaluatorPaths(task) {
  const evaluator = task.objective_evaluator;
  if (!evaluator?.id || !evaluator.path || !evaluator.source) {
    throw new Error(`invalid objective evaluator configuration: ${task.id}`);
  }
  const evaluatorPath = await resolveTrustedRelativePath(privateEvaluatorsDir, evaluator.path, 'private evaluator');
  const sourcePath = await resolveTrustedRelativePath(modelsTest, evaluator.source, 'objective evaluator source');
  const fixturePath = await resolveTrustedRelativePath(modelsTest, task.fixture, 'task fixture');
  if (!pathIsWithin(fixturePath, sourcePath)) throw new Error(`objective evaluator source must remain inside task fixture: ${task.id}`);
  return { evaluator, evaluatorPath, sourcePath };
}

async function runObjectiveEvaluator(candidate, task, diffPath, privateCandidateDir) {
  const { evaluator, evaluatorPath, sourcePath } = await objectiveEvaluatorPaths(task);
  if (!existsSync(evaluatorPath) || !existsSync(sourcePath)) {
    throw new Error(`objective evaluator trusted input is unavailable: ${task.id}`);
  }
  const evaluatorHash = await computeFileHash(evaluatorPath);
  // Keep the bound clean-room outside the runner artifact tree: the evaluator
  // sees this one disposable directory, not even the private-artifact parent.
  // This directory itself is the bind root. Do not put it under a runner-owned
  // 0700 parent: test must traverse every component of the mounted path.
  const workspace = path.join(objectiveWorkspaceRuntimeDir, `models-objective-${randomUUID()}`);
  const fixture = await resolveTrustedRelativePath(modelsTest, task.fixture, 'task fixture');
  const workspaceFixture = path.join(workspace, task.fixture);
  const workspaceSource = path.join(workspace, evaluator.source);
  const workspaceEvaluator = path.join(workspace, 'evaluator.mjs');
  let result;
  try {
    const created = await run('sudo', objectiveWorkspaceCreateCommand({
      workspace, uid: process.getuid(), gid: process.getgid()
    }), { timeoutMs: 30000 });
    if (created.status !== 0) throw new Error(`cannot create objective workspace: ${created.stderr}`);
    await mkdir(path.dirname(workspaceFixture), { recursive: true, mode: 0o700 });
    await cp(fixture, workspaceFixture, { recursive: true, force: false, errorOnExist: true });
    await cp(evaluatorPath, workspaceEvaluator, { force: false, errorOnExist: true });
    const initialized = await run('git', ['init', '-q', workspace], { cwd: workspace, timeoutMs: 30000 });
    if (initialized.status !== 0) throw new Error(`cannot initialize objective evaluator baseline: ${initialized.stderr}`);
    const applied = await run('git', ['-C', workspace, 'apply', '--allow-empty', diffPath], { cwd: workspace, timeoutMs: 30000 });
    if (applied.status !== 0) throw new Error(`cannot apply candidate diff for objective evaluator: ${applied.stderr}`);
    // Make the exact mounted root traversable/readable by the evaluator UID
    // only after all runner-trusted preparation is complete.
    const handoff = await run('sudo', objectiveWorkspaceHandoffCommand({ user: candidateUser, workspace }), { timeoutMs: 30000 });
    if (handoff.status !== 0) throw new Error(`cannot hand objective workspace to clean-room user: ${handoff.stderr}`);
    result = await runObjectiveInSandbox(workspace, workspaceEvaluator, workspaceSource, { timeoutMs });
    if (result.status === null) throw new Error(`cannot execute objective evaluator: ${task.id}`);
    await mkdir(path.join(privateCandidateDir, 'objective-evaluator'), { recursive: true, mode: 0o700 });
    await writeFile(path.join(privateCandidateDir, 'objective-evaluator', 'stdout.txt'), result.stdout);
    await writeFile(path.join(privateCandidateDir, 'objective-evaluator', 'stderr.txt'), result.stderr);
  } finally {
    // After ownership handoff the runner may no longer traverse this 0700
    // root; trusted sudo cleanup is therefore required on every exit path.
    const cleanup = await run('sudo', objectiveWorkspaceCleanupCommand(workspace), { timeoutMs: 30000 });
    if (cleanup.status !== 0) throw new Error(`cannot clean objective workspace: ${cleanup.stderr}`);
  }
  const artifact = {
    schema_version: getSchemaVersion('objective_evaluator', schemaRegistry.artifact_schemas),
    evaluator: { id: evaluator.id, sha256: evaluatorHash },
    status: 'completed',
    passed: result.status === 0,
    started_at: result.started_at,
    completed_at: result.completed_at,
    duration_ms: result.duration_ms,
    execution: {
      status: result.status,
      signal: result.signal,
      timed_out: result.timed_out,
      output_limited: result.output_limited,
      started_at: result.started_at,
      completed_at: result.completed_at,
      duration_ms: result.duration_ms
    }
  };
  const artifactHash = computeArtifactHash(artifact);
  artifact.artifact_hash = { path: 'objective-evaluator.json', sha256: artifactHash };
  const publicPath = path.join(publicAttemptDir(candidate, task), 'objective-evaluator.json');
  await writeJson(publicPath, artifact);
  return { path: 'objective-evaluator.json', sha256: await computeFileHash(publicPath) };
}

function select(items, values, label) {
  if (!values.length) return items;
  const selected = [];
  for (const value of values) {
    const item = items.find((entry) => entry.id === value || entry.model === value);
    if (!item) throw new Error(`unknown ${label} filter: ${value}`);
    if (!selected.includes(item)) selected.push(item);
  }
  return selected;
}

const selectedCandidates = select(config.candidates, optionValues('--candidate'), 'candidate');
const selectedTasks = select(nominations, nominationValues.length ? nominationValues : legacyTaskValues, 'nomination');
const selectedJudges = select(config.judges ?? [], optionValues('--judge'), 'judge');

async function getReleaseSpec() {
  const prompt = await getJudgePromptMetadata();
  const frozenNominations = await Promise.all(nominations.map(async ({ objective_evaluator, ...task }) => {
    const paths = objective_evaluator ? await objectiveEvaluatorPaths({ ...task, objective_evaluator }) : null;
    const fixture = await resolveTrustedRelativePath(modelsTest, task.fixture, 'task fixture');
    const promptPath = await resolveTrustedRelativePath(modelsTest, task.prompt, 'task prompt');
    return {
      ...task,
      frozen_inputs: { fixture_tree: await hashTree(fixture), prompt_sha256: await computeFileHash(promptPath) },
      ...(objective_evaluator ? { objective_evaluator: {
        id: objective_evaluator.id,
        sha256: await computeFileHash(paths.evaluatorPath),
        source_sha256: await computeFileHash(paths.sourcePath)
      } } : {})
    };
  }));
  const spec = { schema_version: 3, release: config.release, nominations: frozenNominations, candidates: config.candidates, judges: config.judges ?? [], criteria: config.criteria, retry_policy: { canonical_attempt: config.retry_policy?.canonical_attempt ?? 1, allow_retries: config.retry_policy?.allow_retries === true }, judge_prompt: prompt, config_sha256: await computeFileHash(configPath) };
  return { ...spec, spec_hash: computeArtifactHash(spec) };
}

async function ensureReleaseManifest() {
  const expected = await getReleaseSpec();
  if (existsSync(releaseManifestPath)) {
    const actual = JSON.parse(await readFile(releaseManifestPath, 'utf8'));
    const { spec_hash, ...unsigned } = actual;
    if (!spec_hash || computeArtifactHash(unsigned) !== spec_hash) throw new Error(`release manifest integrity mismatch: ${config.release}`);
    if (actual.spec_hash !== expected.spec_hash) throw new Error(`release manifest is incompatible with current benchmark specification: ${config.release}`);
    return actual;
  }
  await writeJson(releaseManifestPath, expected);
  return expected;
}

async function verifyCandidateArtifacts(candidate, task) {
  const root = publicAttemptDir(candidate, task);
  const runPath = path.join(root, 'run.json');
  if (!existsSync(runPath)) throw new Error(`missing candidate run artifact: ${candidate.id}/${task.id}`);
  const runArtifact = JSON.parse(await readFile(runPath, 'utf8'));
  if (runArtifact.release !== config.release || runArtifact.nomination !== task.id || runArtifact.run_id !== runId(candidate, task) || runArtifact.attempt !== selectedAttempt || runArtifact.candidate?.id !== candidate.id) throw new Error(`incompatible candidate run artifact: ${candidate.id}/${task.id}/attempt-${selectedAttempt}`);
  if (!runArtifact.artifact_hash?.sha256 || computeArtifactHash(runArtifact) !== runArtifact.artifact_hash.sha256) throw new Error(`candidate run integrity mismatch: ${candidate.id}/${task.id}`);
  for (const key of ['candidate_diff', 'test_result', 'objective_evaluator']) {
    const evidence = runArtifact.artifacts?.[key];
    if (!evidence) continue;
    const file = path.join(root, evidence.path);
    if (!existsSync(file) || !(await verifyFileHash(file, evidence.sha256))) throw new Error(`candidate ${key} integrity mismatch: ${candidate.id}/${task.id}`);
  }
  if (!['unavailable'].includes(runArtifact.outcome) && !runArtifact.artifacts?.candidate_diff) throw new Error(`missing candidate diff evidence: ${candidate.id}/${task.id}`);
  return runArtifact;
}

async function hasAnyCandidatePrimaryArtifact(candidate, task) {
  const root = publicAttemptDir(candidate, task);
  return ['candidate.diff', 'test-result.json', 'objective-evaluator.json', 'run.json']
    .filter((file) => existsSync(path.join(root, file)));
}

async function verifyCandidatePreflight(candidate) {
  const file = path.join(publicReleaseDir, candidate.id, 'preflight.json');
  if (!existsSync(file)) return null;
  const artifact = JSON.parse(await readFile(file, 'utf8'));
  if (artifact.candidate?.id !== candidate.id || !['available', 'unavailable'].includes(artifact.status) || !artifact.artifact_hash?.sha256 || computeArtifactHash(artifact) !== artifact.artifact_hash.sha256) {
    throw new Error(`candidate preflight artifact is incompatible or corrupt: ${candidate.id}`);
  }
  return artifact;
}

async function hasCompleteJudge(candidate, task, judge) {
  const file = path.join(publicAttemptDir(candidate, task), 'judges', `${judge.id}.json`);
  if (!existsSync(file)) return false;
  const artifact = JSON.parse(await readFile(file, 'utf8'));
  if (artifact.judge?.id !== judge.id || artifact.candidate !== candidate.id || artifact.nomination !== task.id || artifact.run_id !== runId(candidate, task) || artifact.attempt !== selectedAttempt || !artifact.artifact_hash?.sha256 || computeArtifactHash(artifact) !== artifact.artifact_hash.sha256) throw new Error(`existing judge artifact is incompatible or corrupt: ${candidate.id}/${task.id}/attempt-${selectedAttempt}/${judge.id}`);
  return true;
}

if (!existsSync(modelsTest)) throw new Error(`models-test checkout not found: ${modelsTest}`);
// Resolve every hidden evaluator and public source before the first model probe.
await Promise.all(nominations.filter((task) => task.objective_evaluator).map(objectiveEvaluatorPaths));
knownCredentials = await loadKnownCredentials();
if (dryRun) {
  const plannedRuns = selectedCandidates.flatMap((candidate) => selectedTasks.map((nomination) => ({ run_id: runId(candidate, nomination), nomination: nomination.id, model: candidate.id, attempt: selectedAttempt })));
  emit('dry_run', {
    Benchmark: config.release,
    Nomination: selectedTasks.map(({ id }) => id),
    selected_Models: selectedCandidates.map(({ id, model }) => ({ id, model })),
    planned_Runs: plannedRuns,
    Attempts: [selectedAttempt],
    phase,
    resume,
    judges: phase === 'judges' || phase === 'all'
      ? selectedJudges.map(({ id, model }) => ({ id, model }))
      : []
  });
  process.exit(0);
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
  const opencode = await runAsCandidate('opencode', ['--version'], {
    cwd: '/tmp',
    sandboxEnv: runtimeProbeEnv(),
    includeCleanWorkspace: false,
    includeAgentHome: false,
    timeoutMs: 10000
  });
  if (opencode.status !== 0) throw new Error(`OpenCode is unavailable for ${candidateUser}: ${opencode.stderr}`);
  emit('preflight_ok', { candidate_user: candidateUser, opencode_version: opencode.stdout.trim() });

  await mkdir(resultsDir, { recursive: true });
  await ensureReleaseManifest();
  // Preserve the all-in-one safety gate: unlike an explicitly staged
  // candidate pass, `all` never spends candidate execution before every
  // requested judge has proved available.
  const judgeAvailability = new Map();
  if (phase === 'all' && !resume) {
    for (const judge of selectedJudges) {
      const probe = await probeModel(judge, selectedTasks[0], 'judge');
      if (!probe.available) throw new Error(`required judge model is unavailable: ${judge.id}`);
      judgeAvailability.set(judge.id, true);
    }
  }
  if (phase === 'candidates' || phase === 'all') {
    for (const candidate of selectedCandidates) {
      const pending = [];
      for (const task of selectedTasks) {
        const primaryArtifacts = await hasAnyCandidatePrimaryArtifact(candidate, task);
        if (primaryArtifacts.includes('run.json')) {
          if (!resume) throw new Error(`candidate attempt artifact already exists: ${candidate.id}/${task.id}/attempt-${selectedAttempt}; use --resume to verify and skip it`);
          await verifyCandidateArtifacts(candidate, task);
        } else if (primaryArtifacts.length) {
          throw new Error(`candidate partial/incomplete primary artifact state exists: ${candidate.id}/${task.id} (${primaryArtifacts.join(', ')})`);
        } else pending.push(task);
      }
      if (!pending.length) continue;
      const existingPreflight = await verifyCandidatePreflight(candidate);
      const preflight = existingPreflight
        ? { available: existingPreflight.status === 'available', reason: existingPreflight.reason, result: existingPreflight }
        : await preflightCandidate(candidate, pending[0]);
      if (!preflight.available) {
        for (const task of pending) await recordUnavailableCandidate(candidate, task, preflight);
        continue;
      }
      for (const task of pending) await runCandidate(candidate, task);
    }
  }
  if (phase === 'judges' || phase === 'all') {
    if (!resume) {
      for (const judge of selectedJudges) {
        const probe = await probeModel(judge, selectedTasks[0], 'judge');
        if (!probe.available) throw new Error(`required judge model is unavailable: ${judge.id}`);
        judgeAvailability.set(judge.id, true);
      }
    }
    for (const candidate of selectedCandidates) {
      for (const task of selectedTasks) {
        const candidateResult = await verifyCandidateArtifacts(candidate, task);
        const pending = [];
        for (const judge of selectedJudges) {
          if (await hasCompleteJudge(candidate, task, judge)) {
            if (!resume) throw new Error(`judge artifact already exists: ${candidate.id}/${task.id}/${judge.id}; use --resume to skip it`);
          } else pending.push(judge);
        }
        if (pending.length) {
          for (const judge of pending) {
            if (!judgeAvailability.has(judge.id)) {
              const probe = await probeModel(judge, task, 'judge');
              if (!probe.available) throw new Error(`required judge model is unavailable: ${judge.id}`);
              judgeAvailability.set(judge.id, true);
            }
          }
          await runJudges(candidate, task, candidateResult, pending);
        }
      }
    }
    const aggregate = await run(process.execPath, [path.join(repo, 'scripts', 'aggregate-results.mjs'), config.release], { cwd: repo, timeoutMs: 30000 });
    if (aggregate.status !== 0) throw new Error(`cannot regenerate aggregate: ${aggregate.stderr}`);
  }
  await resetRoom(nominations[nominations.length - 1]);
  await runAsCleanRoomHost('rm', ['-rf', baselineRoot, comparisonRoot], { timeoutMs: 30000 });
  cleanRoomSafe = true;
  emit('clean_room_final_reset', { workspace: cleanWorkspace, agent_home: agentHome });
  emit('pilot_completed', { phase, results_dir: resultsDir, publication: 'manual' });
} finally {
  try {
    if (cleanRoomTouched && !cleanRoomSafe) {
      await resetRoom(nominations[nominations.length - 1]);
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
