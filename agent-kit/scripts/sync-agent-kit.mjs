import { cp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

const root = process.cwd();
const source = join(root, 'agent-kit', 'skills');
const targets = [join(root, '.agents', 'skills'), join(root, '.claude', 'skills')];

for (const target of targets) {
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  await cp(source, target, { recursive: true });
}

console.log('Agent skills synced.');
