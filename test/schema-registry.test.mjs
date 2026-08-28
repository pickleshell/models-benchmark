import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SCHEMA_REGISTRY_VERSION,
  getSchemaVersion,
  validateSchemaVersion,
  getRegistry,
  DEFAULT_ARTIFACT_SCHEMAS
} from '../scripts/lib/schema-registry.mjs';

test('schema registry has expected artifact types and versions', () => {
  const registry = getRegistry(DEFAULT_ARTIFACT_SCHEMAS);
  assert.equal(registry.schema_registry_version, SCHEMA_REGISTRY_VERSION);
  assert.deepEqual(registry.artifact_schemas, DEFAULT_ARTIFACT_SCHEMAS);
  assert.equal(registry.artifact_schemas.run, 1);
  assert.equal(registry.artifact_schemas.judge, 1);
  assert.equal(registry.artifact_schemas.preflight, 1);
  assert.equal(registry.artifact_schemas.aggregate, 2);
  assert.equal(registry.artifact_schemas.test_result, 1);
  assert.equal(registry.artifact_schemas.candidate_diff, 1);
  assert.equal(registry.artifact_schemas.objective_evaluator, 1);
});

test('getSchemaVersion returns correct version for known artifact types', () => {
  assert.equal(getSchemaVersion('run'), 1);
  assert.equal(getSchemaVersion('judge'), 1);
  assert.equal(getSchemaVersion('preflight'), 1);
  assert.equal(getSchemaVersion('aggregate'), 2);
  assert.equal(getSchemaVersion('test_result'), 1);
  assert.equal(getSchemaVersion('candidate_diff'), 1);
  assert.equal(getSchemaVersion('objective_evaluator'), 1);
});

test('getSchemaVersion throws for unknown artifact type', () => {
  assert.throws(() => getSchemaVersion('unknown'), /Unknown artifact type: unknown/);
});

test('validateSchemaVersion passes for matching version', () => {
  validateSchemaVersion('run', 1);
  validateSchemaVersion('aggregate', 2);
});

test('validateSchemaVersion throws for mismatched version', () => {
  assert.throws(() => validateSchemaVersion('run', 2), /Schema version mismatch for run: expected 1, got 2/);
  assert.throws(() => validateSchemaVersion('aggregate', 1), /Schema version mismatch for aggregate: expected 2, got 1/);
});

test('validateSchemaVersion throws for unknown artifact type', () => {
  assert.throws(() => validateSchemaVersion('unknown', 1), /Unknown artifact type: unknown/);
});
