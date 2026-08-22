import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  computeFileHash,
  computeHash,
  verifyFileHash,
  computeArtifactHash,
  addFileHash
} from '../scripts/lib/artifact-hash.mjs';

test('computeFileHash returns SHA-256 hex string', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'hash-test-'));
  const file = path.join(temp, 'test.txt');
  try {
    await writeFile(file, 'hello world');
    const hash = await computeFileHash(file);
    assert.equal(hash.length, 64);
    assert.match(hash, /^[a-f0-9]{64}$/);
    
    // Same content = same hash
    const hash2 = await computeFileHash(file);
    assert.equal(hash, hash2);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('computeHash works with string content', async () => {
  const hash = await computeHash('test content');
  assert.equal(hash.length, 64);
  assert.match(hash, /^[a-f0-9]{64}$/);
  
  // Different content = different hash
  const hash2 = await computeHash('different content');
  assert.notEqual(hash, hash2);
});

test('verifyFileHash returns true for matching hash', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'hash-test-'));
  const file = path.join(temp, 'test.txt');
  try {
    await writeFile(file, 'verify me');
    const hash = await computeFileHash(file);
    assert.equal(await verifyFileHash(file, hash), true);
    assert.equal(await verifyFileHash(file, 'wronghash'), false);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('computeArtifactHash excludes artifact_hash field', () => {
  const artifact = { 
    schema_version: 1, 
    data: 'test',
    artifact_hash: { path: 'test.json', sha256: 'shouldbeignored' }
  };
  const hash1 = computeArtifactHash(artifact);
  
  const artifact2 = { 
    schema_version: 1, 
    data: 'test',
    artifact_hash: { path: 'test.json', sha256: 'differentignored' }
  };
  const hash2 = computeArtifactHash(artifact2);
  
  // Hash should be the same regardless of artifact_hash field
  assert.equal(hash1, hash2);
  
  // Hash should be deterministic
  const hash3 = computeArtifactHash(artifact);
  assert.equal(hash1, hash3);
});

test('addFileHash adds file hash to artifact', () => {
  const artifact = { schema_version: 1, data: 'test' };
  const result = addFileHash(artifact, 'candidate.diff', 'abc123');
  
  assert.deepEqual(result, {
    schema_version: 1,
    data: 'test',
    artifacts: {
      'candidate.diff': { path: 'candidate.diff', sha256: 'abc123' }
    }
  });
  
  // Original artifact unchanged
  assert.equal(artifact.artifacts, undefined);
});

test('verifyFileHash detects file modification', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'hash-test-'));
  const file = path.join(temp, 'test.txt');
  try {
    await writeFile(file, 'original content');
    const hash = await computeFileHash(file);
    
    // Modify file
    await writeFile(file, 'modified content');
    
    // Should fail verification
    assert.equal(await verifyFileHash(file, hash), false);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});