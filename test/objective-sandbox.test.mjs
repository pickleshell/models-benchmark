import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildObjectiveSandboxInvocation,
  buildObjectiveSandboxProperties,
  objectiveWorkspaceCreateCommand,
  objectiveWorkspaceCleanupCommand,
  objectiveWorkspaceHandoffCommand,
  objectiveWorkspaceRuntimeDir
} from '../scripts/lib/objective-sandbox.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('objective sandbox contract has one disposable writable bind and no model runtime or private roots', () => {
  const workspace = '/var/tmp/models-objective-disposable';
  const args = buildObjectiveSandboxInvocation({ unit: 'objective-test', user: 'test', workspace, evaluatorFile: `${workspace}/evaluator.mjs`, sourceFile: `${workspace}/fixture/source.mjs`, timeoutMs: 1234 });
  const text = JSON.stringify(args);
  assert.ok(args.includes('--uid=test'));
  for (const property of ['PrivateNetwork=yes', 'ProtectHome=tmpfs', 'PrivateTmp=yes', 'PrivateIPC=yes', 'ProtectProc=invisible', 'ProtectSystem=strict', 'NoNewPrivileges=yes', 'PrivateDevices=yes', 'ProtectKernelTunables=yes', 'ProtectKernelModules=yes', 'ProtectControlGroups=yes', 'RestrictSUIDSGID=yes', 'LockPersonality=yes', 'RestrictNamespaces=yes', 'KillMode=control-group']) assert.ok(args.includes(`--property=${property}`), property);
  assert.deepEqual(args.filter((item) => item.startsWith('--property=BindPaths=')), [`--property=BindPaths=${workspace}`]);
  assert.deepEqual(args.filter((item) => item.startsWith('--property=BindReadOnlyPaths=')), []);
  assert.ok(args.includes('/usr/bin/node'), 'ProtectSystem=strict keeps /usr and system libraries read-only-visible');
  for (const forbidden of ['/home/test/.opencode', '/home/test/.models-benchmark/agent-home', '/home/gpt/.models-benchmark/runs', '/home/gpt/models-benchmark/evaluators']) assert.equal(text.includes(forbidden), false, forbidden);
  assert.equal(buildObjectiveSandboxProperties({ workspace, timeoutMs: 1234 }).at(-1), `--property=BindPaths=${workspace}`);
});

test('objective workspace is created outside PrivateTmp, handed off after trusted setup, and cleaned by the runner', async () => {
  const workspace = '/run/models-objective-0700-regression';
  assert.equal(objectiveWorkspaceRuntimeDir, '/run');
  assert.deepEqual(objectiveWorkspaceCreateCommand({ workspace, uid: 1001, gid: 1001 }), ['install', '-d', '--mode=0700', '--owner=1001', '--group=1001', '--', workspace]);
  assert.deepEqual(objectiveWorkspaceHandoffCommand({ user: 'test', workspace }), ['chown', '-R', 'test:test', workspace]);
  assert.deepEqual(objectiveWorkspaceCleanupCommand(workspace), ['rm', '-rf', '--', workspace]);
  const runner = await readFile(path.join(repo, 'scripts/run-pilot.mjs'), 'utf8');
  assert.match(runner, /path\.join\(objectiveWorkspaceRuntimeDir, `models-objective-\$\{randomUUID\(\)\}`\)/);
  const copied = runner.indexOf('await cp(evaluatorPath, workspaceEvaluator');
  const applied = runner.indexOf("await run('git', ['-C', workspace, 'apply'");
  const handoff = runner.indexOf('const handoff = await run(\'sudo\', objectiveWorkspaceHandoffCommand');
  const invoked = runner.indexOf('runObjectiveInSandbox(workspace, workspaceEvaluator, workspaceSource');
  assert.ok(copied >= 0 && applied > copied && handoff > applied && invoked > handoff, 'trusted evaluator and immutable patch must be copied before ownership handoff and sandbox invocation');
  assert.ok(runner.includes("await run('sudo', objectiveWorkspaceCleanupCommand(workspace)"), 'trusted runner must clean a test-owned 0700 root');
});
