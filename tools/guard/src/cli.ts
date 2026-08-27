import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Glob } from 'bun';
import type { SourceFile } from './rules.ts';
import { checkAll } from './rules.ts';

/**
 * Scans the repository source tree and fails the build on any architecture violation.
 * Wired into CI so a violation blocks the merge rather than relying on review vigilance.
 */

/** tools/guard/src -> repository root. Independent of the working directory. */
const REPO_ROOT = resolve(import.meta.dir, '../../..');

const ROOTS = ['apps', 'packages', 'tools', 'systems', 'modules'];
const IGNORED = ['node_modules', 'dist', 'dev-dist', 'build'];

async function collect(): Promise<SourceFile[]> {
  const glob = new Glob('**/*.{ts,tsx}');
  const files: SourceFile[] = [];

  for (const root of ROOTS) {
    const absoluteRoot = join(REPO_ROOT, root);
    // systems/ and modules/ arrive with their owning features. Absent is not a failure.
    if (!existsSync(absoluteRoot)) {
      continue;
    }

    for await (const relative of glob.scan({ cwd: absoluteRoot, onlyFiles: true })) {
      const normalized = relative.replaceAll('\\', '/');
      const path = `${root}/${normalized}`;
      if (IGNORED.some((segment) => path.includes(`/${segment}/`))) {
        continue;
      }
      files.push({ path, content: await Bun.file(join(absoluteRoot, relative)).text() });
    }
  }

  return files;
}

const files = await collect();
const violations = checkAll(files);

if (violations.length === 0) {
  console.log(`architecture guard: ${files.length} files checked, no violations`);
  process.exit(0);
}

console.error(`architecture guard: ${violations.length} violation(s)\n`);
for (const violation of violations) {
  console.error(`  ${violation.path}:${violation.line}  [${violation.rule}]`);
  console.error(`    ${violation.message}`);
  console.error(`    ${violation.remedy}\n`);
}
process.exit(1);
