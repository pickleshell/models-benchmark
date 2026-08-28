import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { computeHash } from './artifact-hash.mjs';

const JUDGE_PROMPT_CONFIG_PATH = path.resolve(
  new URL('..', import.meta.url).pathname,
  '..', 'config', 'judge-prompt.json'
);

let judgePromptConfig = null;

async function loadJudgePromptConfig() {
  if (!judgePromptConfig) {
    judgePromptConfig = JSON.parse(await readFile(JUDGE_PROMPT_CONFIG_PATH, 'utf8'));
  }
  return judgePromptConfig;
}

export const JUDGE_PROMPT_VERSION = 1;

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

// Synchronous version for backward compatibility (default export)
export function buildJudgePrompt({ taskId, taskInstructions = '', criteria, candidateResult }) {
  const evidence = safeJudgeEvidence(candidateResult);
  return [
    'You are an independent code judge. Do not modify files.',
    `Review the submitted solution for task ${taskId}.`,
    `Task instructions:\n${taskInstructions}`,
    `Score each criterion from 1 to 10: ${criteria.join(', ')}.`,
    'Return a concise JSON object with scores, confidence, explanation, and concerns.',
    `Safe execution evidence: ${JSON.stringify(evidence)}`,
    'Inspect the changed files in the workspace and run the public tests before judging.'
  ].join('\n');
}

// Async version that uses versioned template from config
export async function buildJudgePromptAsync({ taskId, taskInstructions = '', criteria, candidateResult }) {
  const config = await loadJudgePromptConfig();
  const evidence = safeJudgeEvidence(candidateResult);
  const prompt = config.template
    .replace('{taskId}', taskId)
    .replace('{taskInstructions}', taskInstructions)
    .replace('{criteria}', criteria.join(', '))
    .replace('{evidence}', JSON.stringify(evidence));
  return prompt;
}

// Build prompt and compute hash of the rendered prompt (what judge actually receives)
export async function buildJudgePromptWithHash({ taskId, taskInstructions = '', criteria, candidateResult }) {
  const prompt = await buildJudgePromptAsync({ taskId, taskInstructions, criteria, candidateResult });
  const promptHash = await computeHash(prompt);
  return { prompt, prompt_hash: promptHash };
}

export async function getJudgePromptMetadata() {
  const config = await loadJudgePromptConfig();
  const templateHash = await computeHash(config.template);
  return {
    version: config.version,
    template_hash: templateHash
  };
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

export function buildJudgeWritablePaths({ agentHome, judgeWorkspace }) {
  return [agentHome, judgeWorkspace];
}

export function buildBaselineComparisonPlan({ baselineWorkspace, candidateWorkspace, comparisonWorkspace }) {
  return {
    copyBaseline: ['cp', '-a', `${baselineWorkspace}/.`, comparisonWorkspace],
    mirrorCandidateTree: ['rsync', '-a', '--checksum', '--delete', '--exclude=.git', `${candidateWorkspace}/`, `${comparisonWorkspace}/`],
    addIntent: ['git', '-C', comparisonWorkspace, 'add', '--intent-to-add', '--', '.'],
    diff: ['git', '-C', comparisonWorkspace, 'diff', '--binary', 'HEAD', '--'],
    status: ['git', '-C', comparisonWorkspace, 'status', '--porcelain=v1', '-z']
  };
}
