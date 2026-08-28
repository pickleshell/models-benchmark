import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const sourceIndex = process.argv.indexOf('--source');
if (sourceIndex < 0 || !process.argv[sourceIndex + 1]) throw new Error('missing --source');
const api = await import(`${pathToFileURL(process.argv[sourceIndex + 1]).href}?v=${Date.now()}`);
const now = Date.parse('2026-08-26T20:00:00Z');

assert.equal(api.parseRetryAfter(' 0 ', now), 0);
assert.equal(api.parseRetryAfter('0012', now), 12000);
for (const value of ['+1', '-1', '1.5', '1e3', '0x10', '', '   ']) {
  assert.equal(api.parseRetryAfter(value, now), null, `must reject ${JSON.stringify(value)}`);
}
assert.equal(api.parseRetryAfter(5, now), null);
assert.equal(api.parseRetryAfter('Wed, 26 Aug 2026 20:00:30 GMT', now), 30000);
assert.equal(api.parseRetryAfter('Wed, 26 Aug 2026 19:59:30 GMT', now), 0);
assert.equal(api.parseRetryAfter('definitely-not-a-date', now), null);
assert.equal(api.parseRetryAfter('Wed, 26 Aug 2026 20:00:30 GMT', Number.NaN), null);

assert.equal(api.computeRetryDelay({ attempt: 1, retryAfter: null, nowMs: now }), 1000);
assert.equal(api.computeRetryDelay({ attempt: 2, retryAfter: undefined, nowMs: now }), 2000);
assert.equal(api.computeRetryDelay({ attempt: 4, retryAfter: '3', nowMs: now }), 3000);
assert.equal(api.computeRetryDelay({ attempt: 4, retryAfter: 'Wed, 26 Aug 2026 20:00:07 GMT', nowMs: now }), 7000);
assert.equal(api.computeRetryDelay({ attempt: 2, retryAfter: 'Wed, 26 Aug 2026 19:59:30 GMT', nowMs: now }), 0);
assert.equal(api.computeRetryDelay({ attempt: 20, retryAfter: null, nowMs: now }), 300000);
assert.equal(api.computeRetryDelay({ attempt: Number.MAX_SAFE_INTEGER, retryAfter: null, nowMs: now }), 300000);
assert.equal(api.computeRetryDelay({ attempt: 2, retryAfter: '999999999', nowMs: now }), 300000);

for (const attempt of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
  assert.throws(() => api.computeRetryDelay({ attempt, retryAfter: null, nowMs: now }));
}
for (const badNow of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
  assert.throws(() => api.computeRetryDelay({ attempt: 1, retryAfter: null, nowMs: badNow }));
}
const huge = api.computeRetryDelay({ attempt: Number.MAX_SAFE_INTEGER, retryAfter: null, nowMs: now });
assert.equal(Number.isFinite(huge), true);
assert.equal(huge, 300000);
