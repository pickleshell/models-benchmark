import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {
  buildJudgeInvocation,
  buildJudgeEnvironment,
  buildJudgePrompt,
  buildJudgeWritablePaths,
  buildBaselineComparisonPlan,
  createAnonymousJudgeWorkspace,
  safeJudgeEvidence
} from '../scripts/lib/blind-judging.mjs';

const candidate = {
  id: 'SECRET-CANDIDATE-ID',
  agent: 'secret-agent',
  runtime: 'secret-runtime',
  model: 'secret/model',
  provider: 'secret-provider',
  subscription: 'secret-subscription'
};

test('judge prompt and invocation contain no candidate identity', () => {
  const candidateResult = {
    candidate,
    outcome: 'completed',
    tests: { status: 0, timed_out: false, output_limited: false },
    private_secret: 'SECRET-PRIVATE-ARTIFACT'
  };
  const prompt = buildJudgePrompt({ taskId: 'feature-implementation', criteria: ['correctness'], candidateResult });
  const workspace = createAnonymousJudgeWorkspace('/tmp/judge');
  const invocation = buildJudgeInvocation({ judge: { model: 'judge/model' }, judgeWorkspace: workspace, prompt });
  const environment = buildJudgeEnvironment({ agentHome: '/room/agent-home', opencodeRoot: '/room/.opencode' });
  const inputs = JSON.stringify({ ...invocation, environment });
  for (const value of Object.values(candidate)) assert.equal(prompt.includes(value), false, value);
  assert.equal(prompt.includes('SECRET-PRIVATE-ARTIFACT'), false);
  for (const value of Object.values(candidate)) assert.equal(inputs.includes(value), false, value);
  assert.deepEqual(environment, {
    HOME: '/room/agent-home',
    PATH: '/room/.opencode/bin:/usr/local/bin:/usr/bin:/bin',
    CODEX_HOME: '/room/agent-home/.codex',
    XDG_CONFIG_HOME: '/room/agent-home/.config',
    XDG_DATA_HOME: '/room/agent-home/.local/share',
    TMPDIR: '/tmp'
  });
  assert.equal(
    buildJudgeEnvironment({ agentHome: '/room/agent-home', opencodeRoot: '/room/.opencode', codexRoot: '/room/.codex-runtime' }).PATH,
    '/room/.opencode/bin:/room/.codex-runtime/bin:/usr/local/bin:/usr/bin:/bin'
  );
  assert.match(workspace, /^\/tmp\/judge\/submission-[0-9a-f-]{36}$/);
  assert.equal(invocation.cwd, workspace);
  assert.deepEqual(buildJudgeWritablePaths({ agentHome: '/room/agent-home', judgeWorkspace: workspace }), [
    '/room/agent-home', workspace
  ]);
  assert.equal(buildJudgeWritablePaths({ agentHome: '/room/agent-home', judgeWorkspace: workspace }).includes('/room/workspace'), false);
});

test('anonymous judge workspaces are unique per invocation', () => {
  const first = createAnonymousJudgeWorkspace('/tmp/judge');
  const second = createAnonymousJudgeWorkspace('/tmp/judge');
  assert.notEqual(first, second);
  assert.match(first, /\/submission-[0-9a-f-]{36}$/);
  assert.match(second, /\/submission-[0-9a-f-]{36}$/);
});

test('safe judge evidence uses an explicit allowlist', () => {
  assert.deepEqual(safeJudgeEvidence({
    outcome: 'tests_failed',
    tests: { status: 1, timed_out: true, output_limited: true },
    candidate,
    stdout: 'secret'
  }), {
    outcome: 'tests_failed',
    public_tests: { status: 1, timed_out: true, output_limited: true }
  });
});

test('baseline comparison ignores candidate git metadata and detects committed-tree changes', () => {
  const plan = buildBaselineComparisonPlan({
    baselineWorkspace: '/room/baseline',
    candidateWorkspace: '/room/candidate',
    comparisonWorkspace: '/room/comparison'
  });
  assert.deepEqual(plan.mirrorCandidateTree, [
    'rsync', '-a', '--checksum', '--delete', '--exclude=.git', '/room/candidate/', '/room/comparison/'
  ]);
  assert.deepEqual(plan.diff, ['git', '-C', '/room/comparison', 'diff', '--binary', 'HEAD', '--']);
  assert.deepEqual(plan.status, ['git', '-C', '/room/comparison', 'status', '--porcelain=v1', '-z']);
  assert.equal(plan.mirrorCandidateTree.includes('/room/baseline'), false);
});

test('baseline comparison still captures a solution committed by the candidate', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'models-benchmark-baseline-'));
  const baseline = path.join(root, 'baseline');
  const candidateWorkspace = path.join(root, 'candidate');
  const comparison = path.join(root, 'comparison');
  try {
    await cp(baseline, candidateWorkspace, { recursive: true }).catch(() => {});
    await writeFile(path.join(root, 'seed.js'), 'export const value = 1;\n');
    execFileSync('git', ['init', '-q', baseline]);
    execFileSync('git', ['-C', baseline, 'config', 'user.name', 'benchmark-baseline']);
    execFileSync('git', ['-C', baseline, 'config', 'user.email', 'benchmark-baseline@localhost']);
    await cp(path.join(root, 'seed.js'), path.join(baseline, 'feature.js'));
    execFileSync('git', ['-C', baseline, 'add', '.']);
    execFileSync('git', ['-C', baseline, 'commit', '-qm', 'baseline']);
    await cp(baseline, candidateWorkspace, { recursive: true });
    await writeFile(path.join(candidateWorkspace, 'feature.js'), 'export const value = 2;\n');
    execFileSync('git', ['-C', candidateWorkspace, 'add', 'feature.js']);
    execFileSync('git', ['-C', candidateWorkspace, 'commit', '-qm', 'candidate commit']);
    await cp(baseline, comparison, { recursive: true });
    execFileSync('rsync', ['-a', '--checksum', '--delete', '--exclude=.git', `${candidateWorkspace}/`, `${comparison}/`]);
    execFileSync('git', ['-C', comparison, 'add', '--intent-to-add', '--', '.']);
    const diff = execFileSync('git', ['-C', comparison, 'diff', '--binary', 'HEAD', '--'], { encoding: 'utf8' });
    assert.match(diff, /feature\.js/);
    assert.match(diff, /value = 2/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
