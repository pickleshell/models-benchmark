import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicRoot = '/home/gpt/models-test/fixtures/phase2-v2';
const run = (file, source) => new Promise((resolve) => { const child = spawn(process.execPath, [file, '--source', source]); child.on('close', (status) => resolve(status)); });
const sources = { patch: 'src/retryPolicy.js', 'bug-fix-ledger': 'src/reconcile.js', 'feature-implementation': 'src/featureFlags.js', refactoring: 'src/events.js', 'repository-navigation': 'src/labels/statusLabel.js', 'tests-edge-cases': 'src/range.js' };
const fixtureDirs = { patch: 'patch-retry-policy' };
const goodSources = {
  patch: `const MAX=300000;
export function parseRetryAfter(value,nowMs){
  if(typeof value!=='string')return null;
  const s=value.trim();
  if(!s)return null;
  if(/^[0-9]+$/.test(s)){
    const sec=Number(s);
    if(!Number.isFinite(sec))return null;
    return sec*1000;
  }
  if (/^[+-]?(?:[0-9]+(?:[.][0-9]*)?|[.][0-9]+)(?:e[+-]?[0-9]+)?$/i.test(s) || /^[+-]?0x[0-9a-f]+$/i.test(s)) return null;
  const d=Date.parse(s);
  if(!Number.isFinite(d)||!Number.isFinite(nowMs))return null;
  return Math.max(0,d-nowMs);
}
export function computeRetryDelay({attempt,retryAfter,nowMs}){
  if(!Number.isInteger(attempt)||attempt<1)throw new Error('attempt');
  if(!Number.isFinite(nowMs))throw new Error('nowMs');
  const h=parseRetryAfter(retryAfter,nowMs);
  if(h!==null)return Math.min(MAX,h);
  if(attempt>=10)return MAX;
  return Math.min(MAX,1000*(2**(attempt-1)));
}
`,
  'bug-fix-ledger': `export function parseAmountToCents(v){if(typeof v!== 'string')throw Error();const s=v.trim().replace(/^\\$/,'');if(!/^(?:\\d+|\\d{1,3}(?:,\\d{3})+)(?:\\.\\d{1,2})?$/.test(s))throw Error();const [a,b='']=s.replace(/,/g,'').split('.');return Number(a)*100+Number((b+'00').slice(0,2));} export function reconcileLedger(xs){if(!Array.isArray(xs))throw Error();const seen=new Set(),sales=new Map(),totals=new Map(),metrics={processed:0,duplicateCount:0,invalidCount:0,orphanRefundCount:0};for(const e of xs){if(!e||typeof e!=='object'||!e.id){metrics.invalidCount++;continue}if(seen.has(e.id)){metrics.duplicateCount++;continue}seen.add(e.id);try{if(!e.accountId||!e.currency||!['sale','refund'].includes(e.type))throw Error();const cents=parseAmountToCents(e.amount),day=new Date(e.createdAt).toISOString().slice(0,10);let a=e.accountId,c=e.currency,n=cents;if(e.type==='refund'){const o=sales.get(e.originalId);if(!o){metrics.orphanRefundCount++;continue}a=o.accountId;c=o.currency;n=-cents}else sales.set(e.id,e);const k=a+'|'+c+'|'+day,z=totals.get(k)||{accountId:a,currency:c,day,netCents:0,count:0};z.netCents+=n;z.count++;totals.set(k,z);metrics.processed++}catch{metrics.invalidCount++}}return{totals:[...totals.values()].sort((x,y)=>x.accountId.localeCompare(y.accountId)||x.currency.localeCompare(y.currency)||x.day.localeCompare(y.day)),metrics}}`,
  'feature-implementation': `export function resolveFeature(c,x){if(!c||typeof c!=='object'||!x||typeof x!=='object'||typeof x.feature!=='string'||!x.feature)return false;const o=x.overrides?.[x.feature];if(typeof o==='boolean')return o;const f=c[x.feature];if(typeof f==='boolean')return f;if(!f||f.enabled!==true)return false;if(!Object.hasOwn(f,'rollout'))return true;const r=f.rollout;if(!Number.isInteger(r)||r<0||r>100)return false;if(r===0||r===100)return r===100;if(typeof x.userId!=='string'||!x.userId)return false;let h=0;for(const q of x.userId)h=(h*31+q.codePointAt(0))>>>0;return h%100<r}`,
  refactoring: `function matchingValidEvents(events,type){return Array.isArray(events)&&typeof type==='string'&&type?[...events].filter(e=>e&&typeof e==='object'&&typeof e.type==='string'&&e.type&&Number.isFinite(e.timestamp)&&e.type===type):[]} export function countByType(e,t){return matchingValidEvents(e,t).length} export function latestByType(e,t){return matchingValidEvents(e,t).reduce((a,x)=>!a||x.timestamp>a.timestamp?x:a,null)}`,
  'repository-navigation': `export function statusLabel(v){return typeof v==='string'?v.trim().split(/[\\s_-]+/).filter(Boolean).map(w=>w[0].toUpperCase()+w.slice(1).toLowerCase()).join(' '):''}`,
  'tests-edge-cases': `export function parseRange(v){if(typeof v!=='string')return null;const m=/^\\s*([+-]?\\d+)\\.\\.([+-]?\\d+)\\s*$/.exec(v);if(!m)return null;const start=Number(m[1]),end=Number(m[2]);return start>=-100000&&end<=100000&&start<=end?{start,end}:null}`
};
test('private objective evaluators reject seeded cases and accept deterministic known-good temporary patches', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'evaluator-acceptance-'));
  for (const [id, relative] of Object.entries(sources)) {
    const fixture = path.join(temp, id); await cp(path.join(publicRoot, fixtureDirs[id] ?? id), fixture, { recursive: true });
    const evaluator = path.join(repo, 'evaluators/phase2-v2', `${id}.mjs`); const source = path.join(fixture, relative);
    const baseline = await run(evaluator, source);
    // Refactoring is behaviorally green but structurally noncompliant; all
    // other seeded fixtures are intentionally objectively incomplete.
    assert.notEqual(baseline, 0, `${id} seeded baseline must fail objective`);
    await writeFile(source, goodSources[id]);
    if (id === 'tests-edge-cases') await writeFile(path.join(fixture, 'test/range.test.mjs'), `// authored mutation checks: 100000 0x 1e +1 ...\n`);
    assert.equal(await run(evaluator, source), 0, `${id} known-good temporary patch must pass`);
  }
});
