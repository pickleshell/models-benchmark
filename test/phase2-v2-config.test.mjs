import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(await readFile(path.join(repo, 'config/phase2-v2.json'), 'utf8'));
test('phase2-v2 canonical configuration is complete and public metadata has no private path leakage', async () => {
  assert.equal(config.release, 'phase2-v2-r5');
  assert.equal(config.nominations.length, 6); assert.equal(new Set(config.nominations.map((nomination) => nomination.id)).size, 6);
  assert.equal(config.nominations.some((nomination) => nomination.id === 'patch'), true);
  assert.equal(config.candidates.length, 34); assert.equal(new Set(config.candidates.map((candidate) => candidate.id)).size, 34);
  assert.deepEqual(config.canonical_expert_review, {
    order: 1,
    reviewer: { name: 'ChatGPT', model: 'gpt-5.6-sol' },
    required_before_blind_judges: true
  });
  assert.deepEqual(config.judges.map((judge) => judge.id), ['gemini-3-7-flash']);
  assert.equal(new Set(config.judges.map((judge) => judge.id)).size, config.judges.length);
  for (const nomination of config.nominations) await access(path.join(config.private_evaluators_dir, nomination.objective_evaluator.path));
  const manifest = JSON.parse(await readFile(path.join(config.models_test, 'benchmarks/phase2-v2/manifest.json'), 'utf8'));
  const publicText = JSON.stringify(manifest);
  assert.equal(publicText.includes('allowed_changes'), false);
  assert.equal(publicText.includes('evaluators/'), false);
  assert.equal(publicText.includes('/home/gpt/models-benchmark'), false);
});
