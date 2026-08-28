import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const script = path.resolve('scripts/log-assistant-commentary.mjs');

function logCommentary(annotationsDir, args) {
  return spawnSync(process.execPath, [script, ...args, '--annotations-dir', annotationsDir], {
    encoding: 'utf8'
  });
}

test('assistant commentary logger rejects missing required fields', async () => {
  const annotationsDir = await mkdtemp(path.join(os.tmpdir(), 'assistant-commentary-'));
  try {
    const result = logCommentary(annotationsDir, [
      '--release', 'r11', '--candidate', 'mini', '--stage', 'preflight'
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--text is required and must be non-empty/);
  } finally {
    await rm(annotationsDir, { recursive: true, force: true });
  }
});

test('assistant commentary logger appends and preserves records in call order', async () => {
  const annotationsDir = await mkdtemp(path.join(os.tmpdir(), 'assistant-commentary-'));
  try {
    const base = ['--release', 'r11', '--candidate', 'mini'];
    const first = logCommentary(annotationsDir, [...base, '--stage', 'preflight', '--text', 'first visible update']);
    const second = logCommentary(annotationsDir, [...base, '--stage', 'summary', '--text', 'second visible update']);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(second.status, 0, second.stderr);

    const destination = path.join(annotationsDir, 'r11', 'mini', 'assistant-commentary.jsonl');
    const records = (await readFile(destination, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(records.length, 2);
    assert.deepEqual(records.map(({ stage, text }) => ({ stage, text })), [
      { stage: 'preflight', text: 'first visible update' },
      { stage: 'summary', text: 'second visible update' }
    ]);
    for (const record of records) {
      assert.deepEqual(Object.keys(record), [
        'schema_version', 'kind', 'recorded_at', 'release', 'candidate', 'stage', 'text', 'source'
      ]);
      assert.equal(record.schema_version, 1);
      assert.equal(record.kind, 'assistant_commentary');
      assert.equal(record.release, 'r11');
      assert.equal(record.candidate, 'mini');
      assert.equal(record.source, 'chatgpt_visible_message');
      assert.match(record.recorded_at, /^\d{4}-\d{2}-\d{2}T/);
    }
  } finally {
    await rm(annotationsDir, { recursive: true, force: true });
  }
});

test('assistant commentary logger appends global history records in call order', async () => {
  const annotationsDir = await mkdtemp(path.join(os.tmpdir(), 'assistant-commentary-'));
  try {
    const first = logCommentary(annotationsDir, [
      '--global', '--stage', 'history_design', '--text', 'first global update'
    ]);
    const second = logCommentary(annotationsDir, [
      '--global', '--stage', 'status', '--text', 'second global update'
    ]);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(second.status, 0, second.stderr);

    const destination = path.join(annotationsDir, 'assistant-history.jsonl');
    const records = (await readFile(destination, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(records.length, 2);
    assert.deepEqual(records.map(({ stage, text }) => ({ stage, text })), [
      { stage: 'history_design', text: 'first global update' },
      { stage: 'status', text: 'second global update' }
    ]);
    for (const record of records) {
      assert.deepEqual(Object.keys(record), [
        'schema_version', 'kind', 'recorded_at', 'stage', 'text', 'source', 'scope'
      ]);
      assert.equal(record.schema_version, 1);
      assert.equal(record.kind, 'assistant_commentary');
      assert.equal(record.source, 'chatgpt_visible_message');
      assert.equal(record.scope, 'benchmark_global');
      assert.match(record.recorded_at, /^\d{4}-\d{2}-\d{2}T/);
    }
  } finally {
    await rm(annotationsDir, { recursive: true, force: true });
  }
});
