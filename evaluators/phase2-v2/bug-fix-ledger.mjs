import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const source = process.argv[process.argv.indexOf('--source') + 1];
const api = await import(pathToFileURL(source).href);

for (const value of ['1.005', '-1', '1,20', '12,34.00', '1,234,56', '1.']) assert.throws(() => api.parseAmountToCents(value));
assert.equal(api.parseAmountToCents('$1,200.05'), 120005);
const result = api.reconcileLedger([
  { id: 's', type: 'sale', accountId: 'merchant', currency: 'USD', amount: '5.00', createdAt: '2026-01-02T00:30:00+02:00' },
  { id: 'r', type: 'refund', originalId: 's', accountId: 'other', currency: 'EUR', amount: '2.00', createdAt: '2026-01-02T00:00:00Z' },
  { id: 's', type: 'sale', accountId: 'merchant', currency: 'USD', amount: 'bad', createdAt: '2026-01-01T00:00:00Z' },
  { id: 'bad', type: 'sale', accountId: 'merchant', currency: 'USD', amount: 'bad', createdAt: 'bad' },
  { id: 'bad', type: 'refund', originalId: 's', accountId: 'merchant', currency: 'USD', amount: '1.00', createdAt: '2026-01-02T00:00:00Z' },
  { id: 'orphan', type: 'refund', originalId: 'missing', accountId: 'x', currency: 'EUR', amount: '1.00', createdAt: '2026-01-02T00:00:00Z' }
]);
assert.deepEqual(result.totals, [
  { accountId: 'merchant', currency: 'USD', day: '2026-01-01', netCents: 500, count: 1 },
  { accountId: 'merchant', currency: 'USD', day: '2026-01-02', netCents: -200, count: 1 }
]);
assert.deepEqual(result.metrics, { processed: 2, duplicateCount: 2, invalidCount: 1, orphanRefundCount: 1 });
