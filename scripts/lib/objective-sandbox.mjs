// The objective evaluator executes candidate-controlled JavaScript. Keep its
// systemd contract here so the real smoke verifier cannot silently drift from
// production.
export const objectiveSandboxStaticProperties = Object.freeze([
  '--property=ProtectHome=tmpfs',
  '--property=PrivateTmp=yes',
  '--property=PrivateIPC=yes',
  '--property=PrivateNetwork=yes',
  '--property=TemporaryFileSystem=/dev/shm:rw,nosuid,nodev,noexec,mode=1777',
  '--property=ProtectProc=invisible',
  '--property=ProtectSystem=strict',
  '--property=NoNewPrivileges=yes',
  '--property=PrivateDevices=yes',
  '--property=ProtectKernelTunables=yes',
  '--property=ProtectKernelModules=yes',
  '--property=ProtectControlGroups=yes',
  '--property=RestrictSUIDSGID=yes',
  '--property=LockPersonality=yes',
  '--property=RestrictNamespaces=yes',
  '--property=KillMode=control-group',
  '--property=TimeoutStopSec=2s',
  '--property=SendSIGKILL=yes'
]);

export const objectiveSandboxEnvironment = Object.freeze([
  'HOME=/tmp', 'TMPDIR=/tmp', 'PATH=/usr/local/bin:/usr/bin:/bin',
  'XDG_CONFIG_HOME=/tmp/.config', 'XDG_DATA_HOME=/tmp/.local/share'
]);

// PrivateTmp hides /tmp and /var/tmp before BindPaths is applied. Objective
// workspaces therefore live as direct, opaque children of /run, which remains
// visible to the unit. The trusted runner creates them mode 0700 and owns them
// until all trusted inputs have been assembled.
export const objectiveWorkspaceRuntimeDir = process.env.BENCHMARK_OBJECTIVE_WORKSPACE_RUNTIME_DIR || '/run';

export function objectiveWorkspaceCreateCommand({ workspace, uid, gid }) {
  return ['install', '-d', '--mode=0700', `--owner=${uid}`, `--group=${gid}`, '--', workspace];
}

export function buildObjectiveSandboxProperties({ workspace, timeoutMs }) {
  return [
    ...objectiveSandboxStaticProperties,
    `--property=WorkingDirectory=${workspace}`,
    `--property=TimeoutStartSec=${Math.ceil(timeoutMs / 1000)}s`,
    // This is intentionally the sole writable host bind. ProtectSystem=strict
    // leaves /usr and the dynamic loader/library tree visible read-only, so
    // /usr/bin/node needs no runtime or provider-specific bind.
    `--property=BindPaths=${workspace}`
  ];
}

export function buildObjectiveSandboxInvocation({ unit, user, workspace, evaluatorFile, sourceFile, timeoutMs }) {
  return [
    'systemd-run', '--quiet', '--pipe', '--wait', '--collect', `--unit=${unit}`, `--uid=${user}`,
    ...buildObjectiveSandboxProperties({ workspace, timeoutMs }),
    '--', '/usr/bin/env', ...objectiveSandboxEnvironment,
    '/usr/bin/node', evaluatorFile, '--source', sourceFile
  ];
}

// The runner prepares candidate-controlled input before it transfers the
// directory to the clean-room account. Recursive ownership is deliberate:
// a 0700 runner-owned mkdtemp root otherwise blocks test from traversing the
// exact directory mounted into the evaluator unit.
export function objectiveWorkspaceHandoffCommand({ user, workspace }) {
  return ['chown', '-R', `${user}:${user}`, workspace];
}

export function objectiveWorkspaceCleanupCommand(workspace) {
  return ['rm', '-rf', '--', workspace];
}
