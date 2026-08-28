import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { computeHash } from './artifact-hash.mjs';

// Future Phase2-v2 releases use one blind AI judge after the required expert review.
export const CANONICAL_JUDGE_IDS = ['gemini-3-7-flash'];
export const EXPERT_TEMPLATE = {
  schema_version: 1,
  kind: 'expert_review',
  release: '<release>',
  candidate: '<candidate-id>',
  nomination: 'patch',
  reviewer: { name: 'ChatGPT', model: 'gpt-5.6-sol' },
  scores: {
    functional_correctness: '<1..10>',
    reliability_edge_cases: '<1..10>',
    maintainability_clarity: '<1..10>',
    scope_discipline: '<1..10>'
  },
  notes: ['Operator-supplied review. Do not include private evaluator output in this file.']
};

export function nextReleaseId(releases) {
  const numbers = releases.map((value) => /^phase2-v2-r(\d+)$/.exec(value)?.[1]).filter(Boolean).map(Number);
  return `phase2-v2-r${Math.max(9, ...numbers) + 1}`;
}

export function canonicalReleasePolicy(policy) {
  const judgesById = new Map(policy?.judges?.map((judge) => [judge.id, judge]));
  const judges = CANONICAL_JUDGE_IDS.map((id) => {
    const judge = judgesById.get(id);
    if (!judge) throw new Error(`canonical judge policy is missing: ${id}`);
    return { ...judge };
  });
  const canonicalExpert = policy?.canonical_expert_review;
  if (canonicalExpert?.reviewer?.name !== EXPERT_TEMPLATE.reviewer.name
    || canonicalExpert.reviewer.model !== EXPERT_TEMPLATE.reviewer.model) {
    throw new Error('canonical expert-review policy does not match the required identity');
  }
  return { judges, canonical_expert_review: { ...canonicalExpert, reviewer: { ...canonicalExpert.reviewer } } };
}

export function releaseConfig(base, release, candidate, policy) {
  return {
    ...base,
    ...canonicalReleasePolicy(policy),
    release,
    candidates: [{ ...candidate, reasoning_variant: candidate.reasoning_variant ?? 'provider_default' }]
  };
}

export function planReleaseConfig({ releases, existingConfigs, base, candidate, canonicalPolicy, configDirectory }) {
  const matching = existingConfigs.find(({ config }) => config.candidates?.length === 1 && config.candidates[0]?.id === candidate.id);
  if (matching) {
    assertReleaseMatchesCandidate(matching.config, candidate, matching.release);
    return { ...matching, exists: true };
  }
  const release = nextReleaseId(releases);
  return {
    release,
    file: path.join(configDirectory, `${release}.json`),
    config: releaseConfig(base, release, candidate, canonicalPolicy),
    exists: false
  };
}

export function assertReleaseMatchesCandidate(config, candidate, release = config.release) {
  const [configured] = config.candidates ?? [];
  if (config.candidates?.length !== 1
    || configured?.id !== candidate.id
    || configured?.agent !== candidate.agent
    || configured?.model !== candidate.model
    || configured?.reasoning_variant !== 'provider_default') {
    throw new Error(`existing release config does not match queued candidate: ${release}`);
  }
}

export async function materializeReleaseConfig(planned, write = writeFile) {
  if (planned.exists) return false;
  await write(planned.file, `${JSON.stringify(planned.config, null, 2)}\n`, { flag: 'wx' });
  return true;
}

export function validateQueue(queue) {
  if (queue?.schema_version !== 1 || queue.nomination !== 'patch' || !Array.isArray(queue.candidates) || !queue.candidates.length) throw new Error('invalid Phase2 queue configuration');
  const seen = new Set();
  for (const candidate of queue.candidates) {
    if (!candidate.id || !candidate.model || candidate.agent !== 'opencode' || candidate.reasoning_variant !== 'provider_default' || seen.has(candidate.id)) throw new Error(`invalid queued candidate: ${candidate?.id ?? 'unknown'}`);
    seen.add(candidate.id);
  }
}

export function validateExpertReview(review, { release, candidate, criteria, canonicalExpert = null }) {
  if (review?.schema_version !== 1 || review.kind !== 'expert_review' || review.release !== release || review.candidate !== candidate || review.nomination !== 'patch' || !review.reviewer || typeof review.reviewer.name !== 'string') throw new Error('expert review identity is invalid');
  if (canonicalExpert && (review.reviewer.name !== canonicalExpert.name || review.reviewer.model !== canonicalExpert.model)) throw new Error('expert review reviewer does not match the canonical policy');
  for (const criterion of criteria) {
    if (!Number.isInteger(review.scores?.[criterion]) || review.scores[criterion] < 1 || review.scores[criterion] > 10) throw new Error(`expert review score is invalid: ${criterion}`);
  }
  return review;
}

export function canonicalJudgeNeedsFallback(artifact) {
  return artifact?.status === 'failed' && !artifact?.scores && artifact?.execution?.status !== 0;
}

export function shouldAdvanceQueue({ retryJudges = false, stopAfterCurrent = false } = {}) {
  return !retryJudges && !stopAfterCurrent;
}

export function assertBlindPromptSafe(prompt, forbiddenValues = []) {
  for (const value of forbiddenValues) {
    if (value && prompt.includes(String(value))) throw new Error('blind prompt leakage protection rejected non-public data');
  }
  if (/expert review|hidden evaluator|objective_evaluator|reported_cost_usd/i.test(prompt)) throw new Error('blind prompt leakage protection rejected forbidden prompt content');
}

export function telemetryRecord({ release, candidate, preflight, run, judges, fallbackAttempts }) {
  const usage = (value) => value?.reported_cost_usd ?? null;
  return {
    schema_version: 1,
    kind: 'run_telemetry_annotation',
    release,
    candidate: { id: candidate.id, model: candidate.model, reasoning_variant: candidate.reasoning_variant },
    nomination: 'patch',
    attempt: 1,
    candidate_preflight: { duration_ms: preflight?.duration_ms ?? null, cost_usd: usage(preflight?.usage), tokens: preflight?.usage?.tokens ?? null },
    solution: { duration_ms: run?.agent?.duration_ms ?? null, cost_usd: usage(run?.agent?.usage), tokens: run?.agent?.usage?.tokens ?? null },
    public_tests: { status: run?.tests?.status ?? null, duration_ms: run?.tests?.duration_ms ?? null },
    hidden_objective: { passed: run?.objective_evaluator?.passed ?? null },
    canonical_judge_attempts: judges.map((judge) => ({
      judge: judge.judge?.id ?? null,
      status: judge.status ?? null,
      duration_ms: judge.execution?.duration_ms ?? null,
      cost_usd: usage(judge.execution?.usage),
      tokens: judge.execution?.usage?.tokens ?? null,
      artifact_hash: judge.artifact_hash?.sha256 ?? null,
      notes: judge.status === 'failed' && !judge.scores ? ['Canonical judge failed without a score; fallback eligibility evaluated.'] : []
    })),
    fallback_attempts: fallbackAttempts,
    notes: ['Unknown provider costs are null and are never estimated.']
  };
}

export async function appendTelemetry(file, record) {
  const line = { ...record, recorded_at: new Date().toISOString(), annotation_hash: await computeHash(JSON.stringify(record)) };
  await appendFile(file, `${JSON.stringify(line)}\n`, { encoding: 'utf8' });
  return line;
}

export async function inspectFinalTelemetry(file, { release, candidate }) {
  if (!existsSync(file)) return { complete: false, path: file };
  const content = await readFile(file, 'utf8');
  if (content.length === 0) return { complete: false, path: file };
  if (content.trim().length === 0) throw new Error(`malformed non-empty telemetry: ${file}`);

  const records = content.split(/\r?\n/);
  if (records.at(-1) === '') records.pop();
  let complete = false;
  for (const [index, line] of records.entries()) {
    if (!line.trim()) throw new Error(`malformed non-empty telemetry: ${file}:${index + 1}`);
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      throw new Error(`malformed non-empty telemetry: ${file}:${index + 1}`);
    }
    if (record?.kind === 'run_telemetry_annotation'
      && record.release === release
      && record.candidate?.id === candidate
      && record.nomination === 'patch'
      && record.attempt === 1) complete = true;
  }
  return { complete, path: file };
}

export async function readJsonIfExists(file) {
  return existsSync(file) ? JSON.parse(await readFile(file, 'utf8')) : null;
}

export function expertReviewPath(repo, release, candidate) {
  return path.join(repo, 'expert-reviews', release, 'patch', `${candidate}.json`);
}
