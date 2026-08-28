import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const source = process.argv[process.argv.indexOf('--source') + 1];
const text = await readFile(source, 'utf8');
const helpers = [...text.matchAll(/(?:^|\n)\s*function\s+matchingValidEvents\s*\(/g)];
assert.equal(helpers.length, 1, 'exactly one non-exported helper is required');
assert.doesNotMatch(text, /export\s+(?:function\s+matchingValidEvents|const\s+matchingValidEvents|\{[^}]*matchingValidEvents)/);
const exported = [...text.matchAll(/export\s+function\s+(\w+)/g)].map((m) => m[1]).sort();
assert.deepEqual(exported, ['countByType', 'latestByType']);
for (const name of exported) { const body = text.slice(text.indexOf(`export function ${name}`)); assert.match(body, /matchingValidEvents\s*\(/); }
const { countByType, latestByType } = await import(pathToFileURL(source).href);
const first = { type: 'x', timestamp: 2 }; const events = [first, { type: 'x', timestamp: 2 }, { type: 'x', timestamp: 1 }, null, { type: '', timestamp: 3 }];
const before = JSON.stringify(events); assert.equal(countByType(events, 'x'), 3); assert.equal(latestByType(events, 'x'), first); assert.equal(latestByType(events, 'missing'), null); assert.equal(countByType({}, 'x'), 0); assert.equal(JSON.stringify(events), before);
