import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildJudgeInvocation,
  buildJudgeEnvironment,
  buildJudgePrompt,
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
    XDG_CONFIG_HOME: '/room/agent-home/.config',
    XDG_DATA_HOME: '/room/agent-home/.local/share',
    TMPDIR: '/tmp'
  });
  assert.match(workspace, /^\/tmp\/judge\/submission-[0-9a-f-]{36}$/);
  assert.equal(invocation.cwd, workspace);
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
