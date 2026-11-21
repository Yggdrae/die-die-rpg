import { copyFile, mkdir, readdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(packageRoot, '../..');
const source = resolve(packageRoot, 'node_modules/@powersync/web/dist/worker');
const sqliteSource = resolve(packageRoot, 'node_modules/@journeyapps/wa-sqlite/dist');
const publicDirectory = resolve(repositoryRoot, 'apps/web/public');
const publicRoot = resolve(publicDirectory, 'sync-assets');
const versionedTarget = resolve(publicRoot, 'powersync-1.39.1');
const chunkTarget = resolve(publicRoot, 'worker');

if (dirname(publicRoot) !== publicDirectory) throw new Error('invalid sync asset target');
await rm(publicRoot, { recursive: true, force: true });
await mkdir(versionedTarget, { recursive: true });
await mkdir(chunkTarget, { recursive: true });
for (const filename of ['WASQLiteDB.umd.js', 'SharedSyncImplementation.umd.js']) {
  await copyFile(resolve(source, filename), resolve(versionedTarget, filename));
}

for (const filename of await readdir(source)) {
  if (filename.endsWith('.umd.js')) {
    await copyFile(resolve(source, filename), resolve(chunkTarget, filename));
  }
}

const sqliteWasmAssets = {
  'mc-wa-sqlite-async.wasm': '2075a31bb151adbb9767.wasm',
  'mc-wa-sqlite.wasm': '8e97452e297be23b5e50.wasm',
  'wa-sqlite-async.wasm': 'fbc178b70d530e8ce02b.wasm',
  'wa-sqlite.wasm': '3322bc84de986b63c2cd.wasm',
};

for (const [sourceName, targetName] of Object.entries(sqliteWasmAssets)) {
  await copyFile(resolve(sqliteSource, sourceName), resolve(publicRoot, targetName));
}
