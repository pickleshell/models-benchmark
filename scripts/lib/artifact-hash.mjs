import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export async function computeFileHash(filePath) {
  const content = await readFile(filePath);
  const hash = createHash('sha256');
  hash.update(content);
  return hash.digest('hex');
}

export async function computeHash(content) {
  const hash = createHash('sha256');
  hash.update(content);
  return hash.digest('hex');
}

export async function verifyFileHash(filePath, expectedHash) {
  const actualHash = await computeFileHash(filePath);
  return actualHash === expectedHash;
}

/**
 * Compute hash of artifact content excluding artifact_hash field.
 * This allows the hash to be embedded in the artifact itself.
 */
export function computeArtifactHash(artifact) {
  const { artifact_hash, ...content } = artifact;
  const serialized = JSON.stringify(content, null, 2) + '\n';
  const hash = createHash('sha256');
  hash.update(serialized);
  return hash.digest('hex');
}

/**
 * Add file hash reference to artifact's artifacts object.
 * Used for candidate.diff, test-result.json, judge/*.json files.
 */
export function addFileHash(artifact, filePath, hash) {
  return {
    ...artifact,
    artifacts: {
      ...artifact.artifacts,
      [filePath]: { path: filePath, sha256: hash }
    }
  };
}