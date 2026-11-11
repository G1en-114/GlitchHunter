import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

export async function fingerprintDirectory(root) {
  const files = {};
  async function visit(relative = '') {
    for (const entry of (await readdir(join(root, relative), { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (name === 'manifest.json') continue;
      if (entry.isDirectory()) await visit(name);
      else if (entry.isFile()) files[name] = createHash('sha256').update(await readFile(join(root, name))).digest('hex');
      else throw new Error('Build fingerprint does not support symlinks');
    }
  }
  await visit();
  return { buildId: createHash('sha256').update(JSON.stringify(files)).digest('hex'), files };
}
