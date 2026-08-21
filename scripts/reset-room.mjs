#!/usr/bin/env node
import { cp, mkdir, readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

function arg(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`missing ${name}`);
  return process.argv[index + 1];
}

const archiveRoot = path.resolve(arg('--archive-root'));
const fixture = arg('--fixture');
const prompt = arg('--prompt');
const workspace = path.resolve(arg('--workspace'));
const agentHome = path.resolve(arg('--agent-home'));
const sandboxRoot = path.resolve(arg('--sandbox-root'));

for (const value of [workspace, agentHome]) {
  if (value !== sandboxRoot && !value.startsWith(`${sandboxRoot}${path.sep}`)) {
    throw new Error(`refusing path outside clean-room sandbox: ${value}`);
  }
}

await rm(workspace, { recursive: true, force: true });
await rm(agentHome, { recursive: true, force: true });
await mkdir(path.dirname(workspace), { recursive: true });
await mkdir(agentHome, { recursive: true, mode: 0o700 });
const fixtureTarget = path.join(workspace, fixture);
await rm(fixtureTarget, { recursive: true, force: true });
await mkdir(fixtureTarget, { recursive: true });
await cp(path.join(archiveRoot, fixture), fixtureTarget, { recursive: true });
await mkdir(path.dirname(path.join(workspace, prompt)), { recursive: true });
await cp(path.join(archiveRoot, prompt), path.join(workspace, prompt));

function git(args) {
  const result = spawnSync('git', ['-C', workspace, ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || `git failed: ${args.join(' ')}`);
}

git(['init', '-q']);
git(['config', 'user.name', 'benchmark-baseline']);
git(['config', 'user.email', 'benchmark-baseline@localhost']);
git(['add', '.']);
git(['commit', '-qm', 'benchmark baseline']);
process.stdout.write(JSON.stringify({ ok: true, workspace, agent_home: agentHome }) + '\n');
