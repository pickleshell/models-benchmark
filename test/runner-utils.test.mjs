import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  classifyOutcome,
  createBoundedCollector,
  findForbiddenChanges,
  hasModelResponse,
  parsePorcelainPaths,
  validateJudgePayload
} from '../scripts/lib/runner-utils.mjs';

test('porcelain parser includes tracked, untracked, and rename paths', () => {
  const output = ' M src/a.js\0?? src/new.js\0R  src/new-name.js\0src/old-name.js\0';
  assert.deepEqual(parsePorcelainPaths(output), ['src/a.js', 'src/new-name.js', 'src/new.js', 'src/old-name.js']);
});

test('allowed change policy rejects a changed test file', () => {
  assert.deepEqual(findForbiddenChanges(['src/feature.js', 'test/feature.test.js'], ['src/feature.js']), ['test/feature.test.js']);
});

test('judge validation requires every bounded criterion', () => {
  const criteria = ['correctness', 'scope'];
  assert.deepEqual(validateJudgePayload({ scores: { correctness: 9, scope: 8 } }, criteria).scores, { correctness: 9, scope: 8 });
  assert.equal(validateJudgePayload({ scores: { correctness: 9 } }, criteria), null);
  assert.equal(validateJudgePayload({ scores: { correctness: 11, scope: 8 } }, criteria), null);
});

test('outcome keeps execution, policy, and test failures distinct', () => {
  const ok = { status: 0, timed_out: false, output_limited: false };
  assert.equal(classifyOutcome({ agent: ok, tests: ok, forbiddenChanges: [] }), 'completed');
  assert.equal(classifyOutcome({ agent: ok, tests: ok, forbiddenChanges: ['package.json'] }), 'forbidden_changes');
  assert.equal(classifyOutcome({ agent: ok, tests: { ...ok, status: 1 }, forbiddenChanges: [] }), 'tests_failed');
  assert.equal(classifyOutcome({ agent: { ...ok, timed_out: true }, tests: ok, forbiddenChanges: [] }), 'agent_failure');
});

test('model availability requires a response event, not only exit success', () => {
  assert.equal(hasModelResponse('{"type":"error","message":"Model not found"}'), false);
  assert.equal(hasModelResponse('{"type":"text","part":{"text":"hi"}}'), true);
  assert.equal(hasModelResponse('{"type":"text","part":{"text":"hi"}}\n{"type":"error","message":"Provider failed"}'), false);
  assert.equal(hasModelResponse('hi'), false);
  assert.equal(hasModelResponse('hi', 'codex'), true);
  assert.equal(hasModelResponse(''), false);
});

test('OpenCode ProviderModelNotFoundError diagnostics never pass availability', async () => {
  const output = await readFile(new URL('./fixtures/opencode-provider-model-not-found.stdout', import.meta.url), 'utf8');
  assert.equal(hasModelResponse(output), false);
});

test('bounded collector truncates instead of retaining unlimited output', () => {
  const collector = createBoundedCollector(4);
  assert.equal(collector.append(Buffer.from('abc')), true);
  assert.equal(collector.append(Buffer.from('def')), false);
  assert.equal(collector.limited, true);
  assert.equal(collector.text(), 'abcd');
});
