import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CANONICAL_JUDGE_IDS, EXPERT_TEMPLATE, assertBlindPromptSafe, canonicalJudgeNeedsFallback, nextReleaseId,
  canonicalReleasePolicy, inspectFinalTelemetry, materializeReleaseConfig, planReleaseConfig, releaseConfig, shouldAdvanceQueue, telemetryRecord,
  validateExpertReview, validateQueue
} from '../scripts/lib/phase2-queue.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const execFileAsync = promisify(execFile);

test('queue preserves the required sequential order including Big Pickle', async () => {
  const queue = JSON.parse(await readFile(path.join(root, 'config/phase2-v2-queue.json'), 'utf8'));
  validateQueue(queue);
  assert.deepEqual(queue.candidates.map((candidate) => candidate.model), [
    'opencode-go/kimi-k2.7-code', 'opencode-go/minimax-m3', 'opencode-go/mimo-v2.5-pro', 'opencode-go/grok-4.5',
    'opencode-go/deepseek-v4-flash', 'openrouter/x-ai/grok-4.5', 'opencode-go/hy3', 'openrouter/nvidia/nemotron-3-super-120b-a12b:free',
    'opencode-go/glm-5.1', 'opencode/nemotron-3-ultra-free', 'opencode/claude-opus-5', 'opencode/claude-sonnet-5',
    'opencode/big-pickle', 'opencode-go/kimi-k2.6', 'opencode/claude-haiku-4-5', 'opencode-go/gpt-5.6-luna',
    'opencode-go/glm-5.2', 'opencode/gpt-5.6-terra', 'opencode/gpt-5.5', 'opencode/gpt-5.5-pro',
    'opencode/gpt-5.4-pro', 'opencode/gpt-5.3-codex', 'opencode-go/grok-4.6', 'opencode-go/glm-5.3',
    'opencode-go/qwen3.8-max', 'opencode-go/kimi-k3'
  ]);
  assert.deepEqual(queue.candidates.slice(-16).map((candidate) => candidate.id), [
    '53-claude-opus-5', '52-claude-sonnet-5', '19-big-pickle', '16-kimi-k2-6',
    '51-claude-haiku-4-5', '01-gpt-5-6-luna', '05-glm-5-2', '60-gpt-5-6-terra-opencode',
    '61-gpt-5-5-opencode', '62-gpt-5-5-pro-opencode', '63-gpt-5-4-pro-opencode', '64-gpt-5-3-codex-opencode',
    '65-grok-4-6-go', '66-glm-5-3-go', '67-qwen3-8-max-go', '68-kimi-k3-go'
  ]);
});

test('fresh release generation retains the r9 execution baseline but freezes the current canonical judge policy', async () => {
  const candidate = { id: 'kimi', agent: 'opencode', model: 'opencode-go/kimi-k2.7-code', reasoning_variant: 'provider_default' };
  const policy = JSON.parse(await readFile(path.join(root, 'config/phase2-v2.json'), 'utf8'));
  const base = {
    release: 'phase2-v2-r9', candidates: [{ id: 'old' }], execution_baseline: 'r9',
    judges: [{ id: 'gemini-3-7-flash' }, { id: 'claude-opus-4-8' }],
    canonical_expert_review: { reviewer: { name: 'old reviewer', model: 'old-model' } }
  };
  const generated = releaseConfig(base, nextReleaseId(['phase2-v2-r8', 'phase2-v2-r9']), candidate, policy);
  assert.equal(generated.release, 'phase2-v2-r10');
  assert.deepEqual(generated.candidates, [candidate]);
  assert.equal(generated.execution_baseline, 'r9');
  assert.deepEqual(generated.judges.map((judge) => judge.id), CANONICAL_JUDGE_IDS);
  assert.deepEqual(generated.canonical_expert_review, policy.canonical_expert_review);
  assert.throws(() => canonicalReleasePolicy({ judges: [], canonical_expert_review: policy.canonical_expert_review }), /canonical judge policy is missing/);
});

test('future canonical policy requires ChatGPT GPT-5.6 Sol before Gemini-only blind judging', async () => {
  const base = JSON.parse(await readFile(path.join(root, 'config/phase2-v2.json'), 'utf8'));
  assert.deepEqual(CANONICAL_JUDGE_IDS, ['gemini-3-7-flash']);
  assert.deepEqual(base.judges.map((judge) => judge.id), CANONICAL_JUDGE_IDS);
  assert.deepEqual(EXPERT_TEMPLATE.reviewer, { name: 'ChatGPT', model: 'gpt-5.6-sol' });
  assert.throws(
    () => validateExpertReview({ schema_version: 1, kind: 'expert_review', release: 'r', candidate: 'c', nomination: 'patch', reviewer: { name: 'ChatGPT', model: 'other' }, scores: { functional_correctness: 8 } }, { release: 'r', candidate: 'c', criteria: ['functional_correctness'], canonicalExpert: base.canonical_expert_review.reviewer }),
    /canonical policy/
  );
  assert.doesNotThrow(
    () => validateExpertReview({ schema_version: 1, kind: 'expert_review', release: 'r', candidate: 'c', nomination: 'patch', reviewer: EXPERT_TEMPLATE.reviewer, scores: { functional_correctness: 8 } }, { release: 'r', candidate: 'c', criteria: ['functional_correctness'], canonicalExpert: base.canonical_expert_review.reviewer })
  );
  const source = await readFile(path.join(root, 'scripts/run-phase2-queue.mjs'), 'utf8');
  assert.ok(source.indexOf('validateExpertReview(review') < source.indexOf("'--phase', 'judges'"));
});

test('release planning resumes the existing r10 config without rewriting it and creates only new release configs', async () => {
  const candidate = { id: '03-kimi-k2-7-code', label: 'Kimi K2.7 Code', agent: 'opencode', model: 'opencode-go/kimi-k2.7-code', reasoning_variant: 'provider_default' };
  const r10File = path.join(root, 'config', 'phase2-v2-r10.json');
  const r10 = JSON.parse(await readFile(r10File, 'utf8'));
  const existing = planReleaseConfig({
    releases: ['phase2-v2-r9', 'phase2-v2-r10'], existingConfigs: [{ release: 'phase2-v2-r10', file: r10File, config: r10 }],
    base: r10, candidate, canonicalPolicy: JSON.parse(await readFile(path.join(root, 'config/phase2-v2.json'), 'utf8')), configDirectory: path.join(root, 'config')
  });
  assert.equal(existing.exists, true);
  assert.equal(existing.file, r10File);
  assert.equal(existing.config, r10);
  assert.deepEqual(existing.config.judges, r10.judges);
  let writes = 0;
  assert.equal(await materializeReleaseConfig(existing, async () => { writes += 1; }), false);
  assert.equal(writes, 0);

  const fresh = planReleaseConfig({
    releases: ['phase2-v2-r9', 'phase2-v2-r10'], existingConfigs: [], base: r10,
    candidate: { ...candidate, id: 'new-candidate' }, canonicalPolicy: JSON.parse(await readFile(path.join(root, 'config/phase2-v2.json'), 'utf8')), configDirectory: path.join(root, 'config')
  });
  assert.equal(fresh.exists, false);
  assert.equal(fresh.file, path.join(root, 'config', 'phase2-v2-r11.json'));
  assert.deepEqual(fresh.config.judges.map((judge) => judge.id), CANONICAL_JUDGE_IDS);
  assert.deepEqual(fresh.config.canonical_expert_review.reviewer, EXPERT_TEMPLATE.reviewer);
  let created;
  assert.equal(await materializeReleaseConfig(fresh, async (...args) => { created = args; }), true);
  assert.deepEqual(created.slice(0, 2), [fresh.file, `${JSON.stringify(fresh.config, null, 2)}\n`]);
  assert.deepEqual(created[2], { flag: 'wx' });
});

test('legacy multi-candidate configs do not hijack fresh release planning by candidate id', async () => {
  const candidate = { id: '01-gpt-5-6-luna', agent: 'opencode', model: 'opencode-go/gpt-5.6-luna', reasoning_variant: 'provider_default' };
  const base = JSON.parse(await readFile(path.join(root, 'config/phase2-v2-r9.json'), 'utf8'));
  const policy = JSON.parse(await readFile(path.join(root, 'config/phase2-v2.json'), 'utf8'));
  const legacy = { ...base, release: 'phase2-v2-r6', candidates: [candidate, { ...candidate, id: 'other' }] };
  const planned = planReleaseConfig({
    releases: ['phase2-v2-r6', 'phase2-v2-r24'],
    existingConfigs: [{ release: 'phase2-v2-r6', file: path.join(root, 'config/phase2-v2-r6.json'), config: legacy }],
    base, candidate, canonicalPolicy: policy, configDirectory: path.join(root, 'config')
  });
  assert.equal(planned.exists, false);
  assert.equal(planned.release, 'phase2-v2-r25');
  assert.deepEqual(planned.config.candidates, [candidate]);
});

test('expert review gate requires an operator score and never supplies one', () => {
  assert.equal(EXPERT_TEMPLATE.scores.functional_correctness, '<1..10>');
  assert.throws(() => validateExpertReview(null, { release: 'r', candidate: 'c', criteria: ['functional_correctness'] }));
  assert.doesNotThrow(() => validateExpertReview({ schema_version: 1, kind: 'expert_review', release: 'r', candidate: 'c', nomination: 'patch', reviewer: { name: 'operator' }, scores: { functional_correctness: 8 } }, { release: 'r', candidate: 'c', criteria: ['functional_correctness'] }));
});

test('resume logic is candidate-safe and fallback is only for a failed no-score judge attempt', () => {
  assert.equal(canonicalJudgeNeedsFallback({ status: 'failed', scores: null, execution: { status: 1 } }), true);
  assert.equal(canonicalJudgeNeedsFallback({ status: 'invalid_output', scores: null, execution: { status: 0 } }), false);
  assert.equal(canonicalJudgeNeedsFallback({ status: 'completed', scores: { functional_correctness: 8 }, execution: { status: 0 } }), false);
  const source = readFile(path.join(root, 'scripts/run-phase2-queue.mjs'), 'utf8');
  return source.then((text) => {
    assert.match(text, /if \(!runArtifact && !retryJudges\)/);
    assert.match(text, /advancing_queue/);
  });
});

test('queue advances by default but stop-after-current prevents recursion without a model call', async () => {
  assert.equal(shouldAdvanceQueue(), true);
  assert.equal(shouldAdvanceQueue({ stopAfterCurrent: true }), false);
  assert.equal(shouldAdvanceQueue({ retryJudges: true }), false);
  const source = await readFile(path.join(root, 'scripts/run-phase2-queue.mjs'), 'utf8');
  assert.match(source, /const stopAfterCurrent = argv\.includes\('--stop-after-current'\)/);
  assert.match(source, /shouldAdvanceQueue\(\{ retryJudges, stopAfterCurrent \}\)/);
});

test('valid final telemetry detection requires the complete run identity', async () => {
  const telemetry = path.join(root, 'annotations', 'phase2-v2-r10', '03-kimi-k2-7-code', 'patch.attempt-1.telemetry.jsonl');
  const result = await inspectFinalTelemetry(telemetry, { release: 'phase2-v2-r10', candidate: '03-kimi-k2-7-code' });
  assert.equal(result.complete, true);
});

test('malformed non-empty telemetry fails closed', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'phase2-queue-'));
  const file = path.join(directory, 'telemetry.jsonl');
  await writeFile(file, '{not-json}\n');
  try {
    await assert.rejects(
      () => inspectFinalTelemetry(file, { release: 'r', candidate: 'c' }),
      { message: /malformed non-empty telemetry/ }
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  const source = await readFile(path.join(root, 'scripts/lib/phase2-queue.mjs'), 'utf8');
  assert.match(source, /JSON\.parse\(line\)/);
});

test('completed explicit resume emits no judge intent, appends no telemetry, and stops before the next candidate', async () => {
  const telemetry = path.join(root, 'annotations', 'phase2-v2-r10', '03-kimi-k2-7-code', 'patch.attempt-1.telemetry.jsonl');
  const before = await readFile(telemetry, 'utf8');
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    'scripts/run-phase2-queue.mjs', '--candidate', '03-kimi-k2-7-code', '--stop-after-current'
  ], { cwd: root });
  assert.equal(stderr, '');
  assert.equal(await readFile(telemetry, 'utf8'), before);
  assert.match(stdout, /"event":"model_already_complete"/);
  assert.match(stdout, /"event":"queue_stopped_after_current"/);
  assert.doesNotMatch(stdout, /run-pilot|external-blind-review|"event":"model_complete"/);
});

test('waiting for expert review remains after incomplete candidate evidence', async () => {
  const source = await readFile(path.join(root, 'scripts/run-phase2-queue.mjs'), 'utf8');
  assert.match(source, /if \(!review\) \{\s*output\('WAITING_FOR_EXPERT_REVIEW'/);
});

test('unavailable frozen candidate finalizes telemetry without expert or judge intent', async () => {
  const telemetry = path.join(root, 'annotations', 'phase2-v2-r13', '09-grok-4-5', 'patch.attempt-1.telemetry.jsonl');
  const completedBefore = (await inspectFinalTelemetry(telemetry, { release: 'phase2-v2-r13', candidate: '09-grok-4-5' })).complete;
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    'scripts/run-phase2-queue.mjs', '--candidate', '09-grok-4-5', '--stop-after-current'
  ], { cwd: root });
  assert.equal(stderr, '');
  if (completedBefore) assert.match(stdout, /"event":"model_already_complete"/);
  else assert.match(stdout, /"event":"model_unavailable_complete"/);
  assert.match(stdout, /"event":"queue_stopped_after_current"/);
  assert.doesNotMatch(stdout, /WAITING_FOR_EXPERT_REVIEW|run-pilot|external-blind-review/);

  const record = JSON.parse((await readFile(telemetry, 'utf8')).trim());
  assert.equal(record.candidate_preflight.duration_ms, 1596);
  assert.deepEqual(record.solution, { duration_ms: null, cost_usd: null, tokens: null });
  assert.deepEqual(record.public_tests, { status: null, duration_ms: null });
  assert.deepEqual(record.hidden_objective, { passed: null });
  assert.deepEqual(record.canonical_judge_attempts, []);
  assert.deepEqual(record.fallback_attempts, []);

  const source = await readFile(path.join(root, 'scripts/run-phase2-queue.mjs'), 'utf8');
  assert.match(source, /if \(runArtifact\.outcome === 'unavailable'\)/);
  assert.ok(source.indexOf("runArtifact.outcome === 'unavailable'") < source.indexOf("output('WAITING_FOR_EXPERT_REVIEW'"));

  const before = await readFile(telemetry, 'utf8');
  const resume = await execFileAsync(process.execPath, [
    'scripts/run-phase2-queue.mjs', '--candidate', '09-grok-4-5', '--stop-after-current'
  ], { cwd: root });
  assert.equal(resume.stderr, '');
  assert.equal(await readFile(telemetry, 'utf8'), before);
  assert.match(resume.stdout, /"event":"model_already_complete"/);
  assert.doesNotMatch(resume.stdout, /run-pilot|external-blind-review|WAITING_FOR_EXPERT_REVIEW|"event":"model_unavailable_complete"/);
});

test('blind prompt leakage protection rejects non-public values but permits canonical v3 identity-blind instruction', () => {
  const prompt = 'Do not infer candidate identity, model, provider, or prior scores.';
  assert.doesNotThrow(() => assertBlindPromptSafe(prompt, ['other-model']));
  assert.throws(() => assertBlindPromptSafe(`${prompt}\nexpert review: 10`, []));
  assert.throws(() => assertBlindPromptSafe(`${prompt}\nopencode-go/kimi-k2.7-code`, ['opencode-go/kimi-k2.7-code']));
});

test('telemetry retains null for unknown provider costs', () => {
  const telemetry = telemetryRecord({ release: 'r', candidate: { id: 'c', model: 'm', reasoning_variant: 'provider_default' }, preflight: { usage: { tokens: {} } }, run: { agent: { usage: { tokens: {} } } }, judges: [], fallbackAttempts: [] });
  assert.equal(telemetry.candidate_preflight.cost_usd, null);
  assert.equal(telemetry.solution.cost_usd, null);
});
