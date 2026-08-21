#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const repo = path.resolve(new URL('..', import.meta.url).pathname);
const configPath = process.env.BENCHMARK_CONFIG
  ? path.resolve(process.env.BENCHMARK_CONFIG)
  : path.join(repo, 'config', 'pilot.json');
const config = JSON.parse(await readFile(configPath, 'utf8'));
const candidateUser = config.clean_room.user;
const opencodeRoot = path.resolve(config.clean_room.opencode_root);
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

function sandbox(command) {
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
    '--', '/bin/sh', '-ceu', command
  ]);
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

function visibleUsers(output) {
  const markerIndex = output.indexOf('__VISIBLE_USERS__\n');
  if (markerIndex < 0) return [];
  return output.slice(markerIndex + '__VISIBLE_USERS__\n'.length).trim().split('\n').filter(Boolean).sort();
}

const first = await sandbox(`printf isolated > /dev/shm/${marker}; readlink /proc/self/ns/ipc; printf '__VISIBLE_USERS__\\n'; ps -eo user= | tr -d ' ' | sort -u`);
if (first.status !== 0) throw new Error(`first sandbox probe failed (status ${first.status}): ${first.stderr || first.stdout}`);
const hostMarker = await run('test', ['-e', `/dev/shm/${marker}`]);
const second = await sandbox(`test ! -e /dev/shm/${marker}; readlink /proc/self/ns/ipc; printf '__VISIBLE_USERS__\\n'; ps -eo user= | tr -d ' ' | sort -u`);
if (second.status !== 0) throw new Error(`second sandbox probe failed (status ${second.status}): ${second.stderr || second.stdout}`);
const opencode = await sandboxOpenCodeVersion();
if (opencode.status !== 0) throw new Error(`OpenCode sandbox probe failed (status ${opencode.status}): ${opencode.stderr || opencode.stdout}`);

const firstUsers = visibleUsers(first.stdout);
const secondUsers = visibleUsers(second.stdout);
const unexpectedUsers = [...new Set([...firstUsers, ...secondUsers])].filter((user) => user !== candidateUser);
if (hostMarker.status === 0) throw new Error('sandbox marker leaked into the host temporary filesystem');
if (unexpectedUsers.length) throw new Error(`host processes are visible in sandbox: ${unexpectedUsers.join(', ')}`);

process.stdout.write(`${JSON.stringify({
  ok: true,
  candidate_user: candidateUser,
  host_temporary_marker_visible: false,
  first_visible_users: firstUsers,
  second_visible_users: secondUsers,
  opencode_version: opencode.stdout.trim()
})}\n`);
