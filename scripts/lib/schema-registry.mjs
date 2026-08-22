import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_ARTIFACT_SCHEMAS = {
  run: 1,
  judge: 1,
  preflight: 1,
  aggregate: 2,
  test_result: 1,
  candidate_diff: 1
};

export const SCHEMA_REGISTRY_VERSION = 1;

const registryCache = new Map();

function validateArtifactSchemas(artifactSchemas) {
  if (!artifactSchemas || typeof artifactSchemas !== 'object') {
    throw new Error('artifact_schemas must be an object');
  }
  for (const [artifactType, version] of Object.entries(artifactSchemas)) {
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
      throw new Error(`Invalid schema version for ${artifactType}: must be positive integer, got ${version}`);
    }
  }
  // Ensure all required artifact types are present
  for (const requiredType of Object.keys(DEFAULT_ARTIFACT_SCHEMAS)) {
    if (!(requiredType in artifactSchemas)) {
      throw new Error(`Missing required artifact type in artifact_schemas: ${requiredType}`);
    }
  }
  // Warn about unknown artifact types (but don't fail)
  for (const type of Object.keys(artifactSchemas)) {
    if (!(type in DEFAULT_ARTIFACT_SCHEMAS)) {
      console.warn(`Warning: Unknown artifact type in artifact_schemas: ${type}`);
    }
  }
}

export async function loadSchemaRegistry(configPath) {
  const resolvedPath = path.resolve(configPath);
  
  if (registryCache.has(resolvedPath)) {
    return registryCache.get(resolvedPath);
  }
  
  const config = JSON.parse(await readFile(resolvedPath, 'utf8'));
  const artifactSchemas = config.artifact_schemas || DEFAULT_ARTIFACT_SCHEMAS;
  
  // Fail-closed validation
  validateArtifactSchemas(artifactSchemas);
  
  const registry = {
    schema_registry_version: SCHEMA_REGISTRY_VERSION,
    artifact_schemas: { ...artifactSchemas }
  };
  
  registryCache.set(resolvedPath, registry);
  return registry;
}

export function getSchemaVersion(artifactType, registry = DEFAULT_ARTIFACT_SCHEMAS) {
  const version = registry[artifactType];
  if (version === undefined) {
    throw new Error(`Unknown artifact type: ${artifactType}`);
  }
  return version;
}

export function validateSchemaVersion(artifactType, actualVersion, registry = DEFAULT_ARTIFACT_SCHEMAS) {
  const expectedVersion = getSchemaVersion(artifactType, registry);
  if (actualVersion !== expectedVersion) {
    throw new Error(
      `Schema version mismatch for ${artifactType}: expected ${expectedVersion}, got ${actualVersion}`
    );
  }
}

export function readArtifactWithValidation(artifact, artifactType, registry = DEFAULT_ARTIFACT_SCHEMAS) {
  validateSchemaVersion(artifactType, artifact.schema_version, registry);
  return artifact;
}

export async function readArtifactFile(filePath, artifactType, registry = DEFAULT_ARTIFACT_SCHEMAS) {
  const content = JSON.parse(await readFile(filePath, 'utf8'));
  validateSchemaVersion(artifactType, content.schema_version, registry);
  return content;
}

export function getRegistry(registry = DEFAULT_ARTIFACT_SCHEMAS) {
  return {
    schema_registry_version: SCHEMA_REGISTRY_VERSION,
    artifact_schemas: { ...registry }
  };
}

export function clearSchemaRegistryCache() {
  registryCache.clear();
}