import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { hashTree } from '../scripts/lib/tree-hash.mjs';
test('tree hash is deterministic, content-sensitive, and rejects symlinks', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tree-hash-')); await mkdir(path.join(root, 'nested'));
  await writeFile(path.join(root, 'nested/a'), 'one'); const first = await hashTree(root); const again = await hashTree(root);
  assert.deepEqual(first, again); await writeFile(path.join(root, 'nested/a'), 'two'); assert.notEqual((await hashTree(root)).sha256, first.sha256);
  await symlink('/tmp', path.join(root, 'escape')); await assert.rejects(hashTree(root), /symlink/);
});
