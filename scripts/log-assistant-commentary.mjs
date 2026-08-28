#!/usr/bin/env node

import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const defaultAnnotationsDir = path.resolve(scriptDir, '..', 'annotations');

function usage(message) {
  if (message) process.stderr.write(`Error: ${message}\n`);
  process.stderr.write(
    'Usage: node scripts/log-assistant-commentary.mjs (--release <id> --candidate <id> | --global) --stage <stage> --text <text> [--annotations-dir <path>]\n'
  );
  process.exitCode = 1;
}

function parseArgs(argv) {
  const values = {};
  const allowed = new Set(['release', 'candidate', 'global', 'stage', 'text', 'annotations-dir']);

  for (let index = 0; index < argv.length;) {
    const flag = argv[index];
    if (!flag?.startsWith('--') || !allowed.has(flag.slice(2))) {
      throw new Error(`unknown argument ${flag ?? ''}`.trim());
    }
    const key = flag.slice(2);
    if (key === 'global') {
      if (Object.hasOwn(values, key)) throw new Error(`duplicate argument ${flag}`);
      values[key] = true;
      index += 1;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`missing value for ${flag}`);
    }
    if (Object.hasOwn(values, key)) throw new Error(`duplicate argument ${flag}`);
    values[key] = value;
    index += 2;
  }

  for (const key of ['stage', 'text']) {
    if (!values[key]?.trim()) throw new Error(`--${key} is required and must be non-empty`);
  }
  if (values.global) {
    if (values.release || values.candidate) {
      throw new Error('--global cannot be combined with --release or --candidate');
    }
  } else {
    for (const key of ['release', 'candidate']) {
      if (!values[key]?.trim()) throw new Error(`--${key} is required and must be non-empty`);
    }
  }
  for (const key of ['release', 'candidate']) {
    if (values[key] === '.' || values[key] === '..' || /[\\/]/.test(values[key])) {
      throw new Error(`--${key} must be a single path segment`);
    }
  }

  return values;
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    usage(error.message);
    return;
  }

  const annotationsDir = path.resolve(args['annotations-dir'] ?? defaultAnnotationsDir);
  const destination = args.global
    ? path.join(annotationsDir, 'assistant-history.jsonl')
    : path.join(annotationsDir, args.release, args.candidate, 'assistant-commentary.jsonl');
  const record = args.global
    ? {
        schema_version: 1,
        kind: 'assistant_commentary',
        recorded_at: new Date().toISOString(),
        stage: args.stage,
        text: args.text,
        source: 'chatgpt_visible_message',
        scope: 'benchmark_global'
      }
    : {
        schema_version: 1,
        kind: 'assistant_commentary',
        recorded_at: new Date().toISOString(),
        release: args.release,
        candidate: args.candidate,
        stage: args.stage,
        text: args.text,
        source: 'chatgpt_visible_message'
      };

  await mkdir(path.dirname(destination), { recursive: true });
  await appendFile(destination, `${JSON.stringify(record)}\n`, { encoding: 'utf8', flag: 'a' });
  process.stdout.write(`${destination}\n`);
}

await main();
