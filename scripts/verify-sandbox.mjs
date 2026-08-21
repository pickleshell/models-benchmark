#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { acquireCleanRoomLock, releaseCleanRoomLock } from './lib/clean-room-lock.mjs';

const repo = path.resolve(new URL('..', import.meta.url).pathname);
const configPath = process.env.BENCHMARK_CONFIG
  ? path.resolve(process.env.BENCHMARK_CONFIG)
  : path.join(repo, 'config', 'pilot.json');
const config = JSON.parse(await readFile(configPath, 'utf8'));
const candidateUser = config.clean_room.user;
const opencodeRoot = path.resolve(config.clean_room.opencode_root);
const expandHome = (value) => value.replace(/^~(?=$|\/)/, os.homedir());
const privateDir = path.resolve(expandHome(config.private_artifacts_dir), config.release);
const cleanRoomLockPath = config.clean_room.lock_path
  ? path.resolve(expandHome(config.clean_room.lock_path))
  : path.join(path.dirname(privateDir), 'clean-room.lock');
const marker = `models-benchmark-ipc-${randomUUID()}`;

function run(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => resolve({ status: null, stdout, stderr: error.message }));
    child.once('close', (status) => resolve({ status, stdout, stderr }));
  });
}

function sandboxArgs(command) {
  return [
    'systemd-run', '--quiet', '--pipe', '--wait', '--collect', `--uid=${candidateUser}`,
    '--property=ProtectHome=tmpfs',
    '--property=PrivateTmp=yes',
    '--property=PrivateIPC=yes',
    '--property=TemporaryFileSystem=/dev/shm:rw,nosuid,nodev,noexec,mode=1777',
    '--property=ProtectProc=invisible',
    '--property=ProtectSystem=strict',
    '--property=NoNewPrivileges=yes',
    '--property=PrivateDevices=yes',
    '--', '/bin/sh', '-ceu', command
  ];
}

function sandbox(command) {
  return run('sudo', sandboxArgs(command));
}

function startSandbox(command) {
  const child = spawn('sudo', sandboxArgs(command), { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  let ready = false;
  let resolveReady;
  let rejectReady;
  const readiness = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    if (!ready && stdout.includes('IPC_NS=')) {
      ready = true;
      resolveReady();
    }
  });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const result = new Promise((resolve) => {
    child.once('error', (error) => {
      if (!ready) rejectReady(error);
      resolve({ status: null, stdout, stderr: error.message });
    });
    child.once('close', (status) => {
      if (!ready) rejectReady(new Error(`sandbox exited before readiness (status ${status})`));
      resolve({ status, stdout, stderr });
    });
  });
  return { readiness, result };
}

function sandboxOpenCodeVersion() {
  return run('sudo', [
    'systemd-run', '--quiet', '--pipe', '--wait', '--collect', `--uid=${candidateUser}`,
    '--property=ProtectHome=tmpfs',
    '--property=PrivateTmp=yes',
    '--property=PrivateIPC=yes',
    '--property=TemporaryFileSystem=/dev/shm:rw,nosuid,nodev,noexec,mode=1777',
    '--property=ProtectProc=invisible',
    '--property=ProtectSystem=strict',
    '--property=NoNewPrivileges=yes',
    '--property=PrivateDevices=yes',
    `--property=BindReadOnlyPaths=${opencodeRoot}`,
    '--', '/usr/bin/env', `HOME=/tmp`, `PATH=${opencodeRoot}/bin:/usr/local/bin:/usr/bin:/bin`, 'opencode', '--version'
  ]);
}

function probeValue(output, label) {
  const match = output.match(new RegExp(`^${label}=(.+)$`, 'm'));
  return match?.[1]?.trim() || null;
}

async function assertCleanRoomUserIsIdle() {
  const listed = await run('pgrep', ['-u', candidateUser, '-a']);
  if (listed.status === 1) return;
  if (listed.status !== 0) throw new Error(`cannot inspect clean-room account processes for ${candidateUser}: ${listed.stderr || listed.stdout}`);
  throw new Error(`clean-room account ${candidateUser} is active; stop its processes before verifying the sandbox:\n${listed.stdout.trim()}`);
}

const probeCommand = (expectMarkerAbsent) => [
  expectMarkerAbsent ? `test ! -e /dev/shm/${marker}` : `printf isolated > /dev/shm/${marker}`,
  'ipcns=$(readlink /proc/self/ns/ipc)',
  'ipc_id=$(ipcmk -Q | sed -n "s/.*id: //p")',
  'test -n "$ipc_id"',
  'ipcrm -q "$ipc_id"',
  `same_uid_visible=false; ps -p ${sentinelPid} -o pid= >/dev/null && same_uid_visible=true || true`,
  'printf "IPC_NS=%s\\nSAME_UID_VISIBLE=%s\\n" "$ipcns" "$same_uid_visible"'
].join('; ');
let first;
let second;
let sentinelPid = '';
const cleanRoomLock = await acquireCleanRoomLock(cleanRoomLockPath, { purpose: 'verify-sandbox' });
try {
  await assertCleanRoomUserIsIdle();
  const sameUserSentinel = await run('sudo', ['-u', candidateUser, '--', '/bin/sh', '-c', 'sleep 30 >/dev/null 2>&1 & echo $!']);
  if (sameUserSentinel.status !== 0) throw new Error(`cannot start same-user process sentinel: ${sameUserSentinel.stderr || sameUserSentinel.stdout}`);
  sentinelPid = sameUserSentinel.stdout.trim();
  // Keep the first unit alive while the second starts. Namespace inode numbers
  // can be reused after teardown, so sequential probes cannot prove separation.
  const firstRun = startSandbox(`${probeCommand(false)}; sleep 3`);
  await firstRun.readiness;
  const hostMarker = await run('test', ['-e', `/dev/shm/${marker}`]);
  second = await sandbox(probeCommand(true));
  first = await firstRun.result;
if (first.status !== 0) throw new Error(`first sandbox probe failed (status ${first.status}): ${first.stderr || first.stdout}`);
if (second.status !== 0) throw new Error(`second sandbox probe failed (status ${second.status}): ${second.stderr || second.stdout}`);
  const hostNamespace = await run('readlink', ['/proc/self/ns/ipc']);
const opencode = await sandboxOpenCodeVersion();
if (opencode.status !== 0) throw new Error(`OpenCode sandbox probe failed (status ${opencode.status}): ${opencode.stderr || opencode.stdout}`);
if (hostMarker.status === 0) throw new Error('sandbox marker leaked into the host temporary filesystem');
  const firstNamespace = probeValue(first.stdout, 'IPC_NS');
  const secondNamespace = probeValue(second.stdout, 'IPC_NS');
  if (!firstNamespace || !secondNamespace || hostNamespace.status !== 0) throw new Error('cannot read IPC namespace identifiers');
  if (firstNamespace === secondNamespace || firstNamespace === hostNamespace.stdout.trim() || secondNamespace === hostNamespace.stdout.trim()) {
    throw new Error('IPC namespace is shared across sandbox boundaries');
  }
  if (probeValue(first.stdout, 'SAME_UID_VISIBLE') !== 'true' || probeValue(second.stdout, 'SAME_UID_VISIBLE') !== 'true') {
    throw new Error('same-user process sentinel was unexpectedly hidden; verify clean-room idle guard assumptions');
  }

process.stdout.write(`${JSON.stringify({
  ok: true,
  candidate_user: candidateUser,
  host_temporary_marker_visible: false,
  ipc_namespaces: { host: hostNamespace.stdout.trim(), first: firstNamespace, second: secondNamespace },
  same_uid_processes_visible: true,
  opencode_version: opencode.stdout.trim()
})}\n`);
} finally {
  if (sentinelPid) await run('sudo', ['-u', candidateUser, '--', 'kill', sentinelPid]);
  await releaseCleanRoomLock(cleanRoomLock);
}
