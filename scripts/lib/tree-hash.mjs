import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

// Canonical tree digest: sorted POSIX relative paths, mode, and raw bytes.  A
// symlink is rejected rather than followed, so a frozen public input cannot
// silently reach outside its declared tree.
export async function hashTree(root) {
  const realRoot = await realpath(root); const entries = [];
  async function visit(dir) {
    for (const name of await readdir(dir)) {
      const file = path.join(dir, name); const stat = await lstat(file);
      const relative = path.relative(realRoot, file).split(path.sep).join('/');
      if (stat.isSymbolicLink()) throw new Error(`symlink not permitted in frozen tree: ${relative}`);
      if (stat.isDirectory()) await visit(file);
      else if (stat.isFile()) entries.push({ relative, mode: stat.mode & 0o777, bytes: await readFile(file) });
      else throw new Error(`unsupported frozen-tree entry: ${relative}`);
    }
  }
  await visit(realRoot); entries.sort((a, b) => a.relative.localeCompare(b.relative));
  const hash = createHash('sha256');
  for (const entry of entries) { hash.update(`${entry.relative}\0${entry.mode.toString(8)}\0`); hash.update(entry.bytes); hash.update('\0'); }
  return { algorithm: 'sha256-tree-v1', sha256: hash.digest('hex'), files: entries.length };
}
