import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const source = process.argv[process.argv.indexOf('--source') + 1];
const { parseRange } = await import(pathToFileURL(source).href);
for (const [input, expected] of [['+1..2', { start: 1, end: 2 }], ['-100000..100000', { start: -100000, end: 100000 }]]) assert.deepEqual(parseRange(input), expected);
for (const bad of ['1.0..2', '1e2..3', '0x1..2', '1...2', '1..2..3', '..2', '1..', '100001..100001', '2..1', null]) assert.equal(parseRange(bad), null);
const tests = await readFile(source.replace(/src[\\/]range\.js$/, 'test/range.test.mjs'), 'utf8');
for (const token of ['100000', '0x', '1e', '+1', '...']) assert.match(tests, new RegExp(token.replace(/[+.*?^${}()|[\]\\]/g, '\\$&')));
