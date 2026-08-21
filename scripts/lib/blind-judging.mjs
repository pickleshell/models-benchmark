import { randomUUID } from 'node:crypto';
import path from 'node:path';

// Only these fields are safe execution evidence. Never pass the candidate
// manifest or the complete run record to a judge process.
export function safeJudgeEvidence(candidateResult) {
  return {
    outcome: candidateResult?.outcome ?? null,
    public_tests: {
      status: candidateResult?.tests?.status ?? null,
      timed_out: Boolean(candidateResult?.tests?.timed_out),
      output_limited: Boolean(candidateResult?.tests?.output_limited)
    }
  };
}

export function buildJudgePrompt({ taskId, criteria, candidateResult }) {
  const evidence = safeJudgeEvidence(candidateResult);
  return [
    'You are an independent code judge. Do not modify files.',
    `Review the submitted solution for task ${taskId}.`,
    `Score each criterion from 1 to 10: ${criteria.join(', ')}.`,
    'Return a concise JSON object with scores, confidence, explanation, and concerns.',
    `Safe execution evidence: ${JSON.stringify(evidence)}`,
    'Inspect the changed files in the workspace and run the public tests before judging.'
  ].join('\n');
}

export function createAnonymousJudgeWorkspace(root) {
  return path.join(root, `submission-${randomUUID()}`);
}

export function buildJudgeInvocation({ judge, judgeWorkspace, prompt }) {
  return {
    command: 'opencode',
    args: ['run', '--model', judge.model, '--dir', judgeWorkspace, '--dangerously-skip-permissions', '--format', 'json', prompt],
    cwd: judgeWorkspace
  };
}

export function buildJudgeEnvironment({ agentHome, opencodeRoot }) {
  return {
    HOME: agentHome,
    PATH: `${opencodeRoot}/bin:/usr/local/bin:/usr/bin:/bin`,
    XDG_CONFIG_HOME: path.join(agentHome, '.config'),
    XDG_DATA_HOME: path.join(agentHome, '.local', 'share'),
    TMPDIR: '/tmp'
  };
}
