import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
export const OBJECTIVE_WORKSPACE_ROOT = '/run/models-benchmark-objective';

async function sudo(args) {
  try {
    return await execFileAsync('sudo', ['-n', ...args], { encoding: 'utf8' });
  } catch (error) {
    const detail = error?.stderr || error?.stdout || error?.message || String(error);
    throw new Error(`objective workspace provisioning failed: ${String(detail).trim()}`);
  }
}

export async function createObjectiveWorkspace(prefix = 'models-objective-') {
  if (!/^[A-Za-z0-9._-]+-$/.test(prefix)) throw new Error('invalid objective workspace prefix');
  await sudo(['install', '-d', '-o', 'root', '-g', 'root', '-m', '0755', OBJECTIVE_WORKSPACE_ROOT]);
  const template = path.join(OBJECTIVE_WORKSPACE_ROOT, `${prefix}XXXXXX`);
  const created = await sudo(['mktemp', '-d', template]);
  const workspace = created.stdout.trim();
  if (!workspace.startsWith(`${OBJECTIVE_WORKSPACE_ROOT}/`)) throw new Error('objective workspace escaped runtime root');
  await sudo(['chown', `${process.getuid()}:${process.getgid()}`, workspace]);
  await sudo(['chmod', '0700', workspace]);
  return workspace;
}
