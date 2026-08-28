import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildJudgePrompt,
  buildJudgePromptWithHash,
  getJudgePromptMetadata,
  safeJudgeEvidence,
  createAnonymousJudgeWorkspace
} from '../scripts/lib/blind-judging.mjs';

test('buildJudgePrompt uses versioned template from config', async () => {
  const candidateResult = {
    outcome: 'completed',
    tests: { status: 0, timed_out: false, output_limited: false }
  };
  const prompt = await buildJudgePrompt({ taskId: 'feature-implementation', taskInstructions: 'Add the named helper and candidate-authored tests.', criteria: ['correctness', 'scope'], candidateResult });
  
  assert.match(prompt, /You are an independent code judge/);
  assert.match(prompt, /feature-implementation/);
  assert.match(prompt, /correctness, scope/);
  assert.match(prompt, /Safe execution evidence/);
  assert.match(prompt, /Add the named helper and candidate-authored tests\./);
});

test('rendered prompt includes exact public instructions and excludes private data', async () => {
  const instructions = 'Implement helper named normalizeRecord. Add candidate-authored tests.';
  const { prompt, prompt_hash } = await buildJudgePromptWithHash({
    taskId: 'public-task', taskInstructions: instructions,
    criteria: ['functional_correctness', 'reliability_edge_cases', 'maintainability_clarity', 'scope_discipline'],
    candidateResult: { outcome: 'completed', tests: { status: 0 } }
  });
  assert.match(prompt, new RegExp(instructions));
  assert.match(prompt, /how fully and correctly the requested behavior is implemented/);
  assert.match(prompt, /README and any public contracts/);
  for (const privateValue of ['private/evaluators/hidden.mjs', 'SECRET-CANDIDATE-ID']) {
    assert.equal(prompt.includes(privateValue), false, privateValue);
  }
  assert.match(prompt_hash, /^[a-f0-9]{64}$/);
});

test('judge prompt metadata returns version and template hash', async () => {
  const meta = await getJudgePromptMetadata();
  assert.equal(meta.version, 3);
  assert.equal(meta.template_hash.length, 64);
  assert.match(meta.template_hash, /^[a-f0-9]{64}$/);
});

test('judge prompt template hash is deterministic', async () => {
  const meta1 = await getJudgePromptMetadata();
  const meta2 = await getJudgePromptMetadata();
  assert.equal(meta1.template_hash, meta2.template_hash);
});

test('safeJudgeEvidence excludes candidate identity', () => {
  const candidate = {
    id: 'SECRET-CANDIDATE-ID',
    agent: 'secret-agent',
    runtime: 'secret-runtime',
    model: 'secret/model',
    provider: 'secret-provider',
    subscription: 'secret-subscription'
  };
  
  const candidateResult = {
    candidate,
    outcome: 'completed',
    tests: { status: 0, timed_out: false, output_limited: false },
    private_secret: 'SECRET-PRIVATE-ARTIFACT'
  };
  
  const evidence = safeJudgeEvidence(candidateResult);
  
  assert.deepEqual(evidence, {
    outcome: 'completed',
    public_tests: { status: 0, timed_out: false, output_limited: false }
  });
  
  // No candidate identity in evidence
  const evidenceStr = JSON.stringify(evidence);
  for (const value of Object.values(candidate)) {
    assert.equal(evidenceStr.includes(value), false, `Candidate value ${value} leaked into evidence`);
  }
});

test('anonymous judge workspaces are unique per invocation', () => {
  const first = createAnonymousJudgeWorkspace('/tmp/judge');
  const second = createAnonymousJudgeWorkspace('/tmp/judge');
  assert.notEqual(first, second);
  assert.match(first, /\/submission-[0-9a-f-]{36}$/);
  assert.match(second, /\/submission-[0-9a-f-]{36}$/);
});
