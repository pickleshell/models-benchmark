#!/usr/bin/env node
// Non-model smoke test for the exact objective-evaluator unit contract.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  buildObjectiveSandboxInvocation,
  objectiveWorkspaceCreateCommand,
  objectiveWorkspaceCleanupCommand,
  objectiveWorkspaceHandoffCommand,
  objectiveWorkspaceRuntimeDir
} from './lib/objective-sandbox.mjs';
import { createObjectiveWorkspace } from './lib/objective-workspace.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configPath = process.env.BENCHMARK_CONFIG ? path.resolve(process.env.BENCHMARK_CONFIG) : path.join(repo, 'config/pilot.json');
const config = JSON.parse(await readFile(configPath, 'utf8'));
const user = config.clean_room.user;
const cleanHome = path.resolve(config.clean_room.home);
const agentHome = path.resolve(config.clean_room.agent_home);
const privateRunnerRoot = path.resolve(config.private_artifacts_dir);
const cleanRoomAuth = path.join(cleanHome, '..', '.local', 'share', 'opencode', 'auth.json');
const run = (command, args) => new Promise((resolve) => {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] }); let stdout = ''; let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('close', (status) => resolve({ status, stdout, stderr }));
  child.on('error', (error) => resolve({ status: null, stdout, stderr: `${stderr}${error.message}` }));
});
const noNewPrivs = (await readFile('/proc/self/status', 'utf8')).match(/^NoNewPrivs:\s+(\d+)$/m)?.[1] === '1';
if (noNewPrivs) {
  process.stdout.write(`${JSON.stringify({ status: 'NOT VERIFIED', reason: 'outer process has NoNewPrivileges; nested sudo cannot create the real transient unit' })}\n`);
  process.exit(0);
}

const workspace = path.join(objectiveWorkspaceRuntimeDir, `models-objective-smoke-${randomUUID()}`);
const privateSentinel = await mkdtemp(path.join(os.tmpdir(), 'models-objective-smoke-private-'));
const candidate = path.join(workspace, 'candidate.mjs');
const evaluator = path.join(workspace, 'evaluator.mjs');
try {
  const created = await run('sudo', objectiveWorkspaceCreateCommand({
    workspace, uid: process.getuid(), gid: process.getgid()
  }));
  if (created.status !== 0) throw new Error(`workspace creation failed: ${created.stderr || created.stdout}`);
  await writeFile(candidate, 'export const answer = 42;\n');
  // These are paths, never secrets. The unit must be unable to read all of
  // them, including the runner-owned sentinel outside its single bind.
  const expectedUid = Number((await run('id', ['-u', user])).stdout.trim());
  if (!Number.isInteger(expectedUid)) throw new Error(`cannot resolve configured clean-room user: ${user}`);
  await writeFile(evaluator, `import { access, writeFile } from 'node:fs/promises';
const source = process.argv[process.argv.indexOf('--source') + 1];
const imported = await import(source);
const blocked = ${JSON.stringify([agentHome, cleanRoomAuth, cleanHome, privateRunnerRoot, privateSentinel])};
const denied = []; for (const target of blocked) { try { await access(target); } catch { denied.push(target); } }
await writeFile('objective-smoke-result.json', JSON.stringify({ uid: process.getuid(), netns: await import('node:fs/promises').then(({readlink}) => readlink('/proc/self/ns/net')), imported: imported.answer === 42, denied }));
if (process.getuid() !== ${expectedUid} || imported.answer !== 42 || denied.length !== blocked.length) process.exit(1);\n`);
  const handoff = await run('sudo', objectiveWorkspaceHandoffCommand({ user, workspace }));
  if (handoff.status !== 0) throw new Error(`workspace handoff failed: ${handoff.stderr || handoff.stdout}`);
  const hostNetns = await run('readlink', ['/proc/self/ns/net']);
  const unit = `models-objective-smoke-${process.pid}-${Date.now()}`;
  const result = await run('sudo', buildObjectiveSandboxInvocation({ unit, user, workspace, evaluatorFile: evaluator, sourceFile: candidate, timeoutMs: 30000 }));
  if (result.status !== 0) throw new Error(`objective unit failed: ${result.stderr || result.stdout}`);
  const collected = await run('systemctl', ['show', unit, '--property=LoadState', '--value']);
  if (collected.stdout.trim() !== 'not-found') throw new Error(`objective unit was not collected: ${collected.stdout || collected.stderr}`);
  // The workspace remains 0700 and test-owned after handoff. Read only the
  // fixed smoke evidence through the same trusted boundary used for cleanup.
  const evidenceRead = await run('sudo', ['cat', '--', path.join(workspace, 'objective-smoke-result.json')]);
  if (evidenceRead.status !== 0) throw new Error(`cannot read objective smoke evidence: ${evidenceRead.stderr || evidenceRead.stdout}`);
  const evidence = JSON.parse(evidenceRead.stdout);
  if (evidence.uid !== expectedUid) throw new Error('objective unit did not use configured clean-room UID');
  if (!evidence.imported || evidence.denied.length !== 5) throw new Error('objective evaluator boundary assertion failed');
  if (!hostNetns.stdout.trim() || evidence.netns === hostNetns.stdout.trim()) throw new Error('PrivateNetwork did not create a separate network namespace');
  process.stdout.write(`${JSON.stringify({ status: 'VERIFIED', user, uid: evidence.uid, network_namespace_isolated: true, candidate_imported: true, workspace_writable: true, protected_paths_unreadable: true })}\n`);
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  if (/no new privileges|not permitted to execute|a terminal is required/i.test(detail)) {
    process.stdout.write(`${JSON.stringify({ status: 'NOT VERIFIED', reason: detail })}\n`);
  } else {
    throw error;
  }
} finally {
  const cleanup = await run('sudo', objectiveWorkspaceCleanupCommand(workspace));
  await rm(privateSentinel, { recursive: true, force: true });
  if (cleanup.status !== 0 && existsSync(workspace)) throw new Error(`objective smoke cleanup failed: ${cleanup.stderr || cleanup.stdout}`);
  if (existsSync(workspace) || existsSync(privateSentinel)) throw new Error('objective smoke workspace remains after cleanup');
}
