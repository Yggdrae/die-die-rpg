import {
  buildPackage,
  concatParts,
  inspectPackage,
  type PackageInput,
} from '@rpg/campaign-portability';

/**
 * Bun helper for `portability.e2e.ts` (Playwright runs under Node; the package code is Bun/web
 * TypeScript). `build <campaignId>` prints a valid `.rpgpack` as base64, standing in for the bytes
 * the online export route streams; `inspect <file>` runs the production inspector over a file the
 * browser downloaded and prints a safe summary. `importable <variant>` prints a package the
 * import accepts (`valid`, `unknown_chunk`) or must reject (`unavailable_system`).
 */

const [command, argument] = process.argv.slice(2);

if (command === 'build') {
  const campaignId = argument ?? '00000000-0000-4000-8000-0000000000a1';
  const input: PackageInput = {
    applicationVersion: 'e2e',
    exportedAt: '2026-10-27T12:00:00.000Z',
    exportedBy: { displayName: 'gm_ana' },
    campaignId,
    systemLock: { systemId: 'fixture-system', version: '0.1.0' },
    modulesLock: { modules: [] },
    chunks: [
      {
        placement: 'campaign',
        moduleId: 'campaign',
        chunkVersion: '1',
        payload: { name: 'Ashen Road', settings: {} },
        records: 1,
      },
      {
        placement: 'attachments-manifest',
        moduleId: 'attachments',
        chunkVersion: '1',
        payload: { campaignId, binaries: 'excluded', entries: [] },
        records: 0,
      },
    ],
  };
  const built = await buildPackage(input);
  process.stdout.write(Buffer.from(concatParts(built.parts)).toString('base64'));
} else if (command === 'importable') {
  const variant = argument ?? 'valid';
  const campaignId = '00000000-0000-4000-8000-0000000000a9';
  const system = {
    systemId: 'fixture-system',
    version: variant === 'unavailable_system' ? '9.9.9' : '0.1.0',
  };
  const input: PackageInput = {
    applicationVersion: 'e2e',
    exportedAt: '2026-10-28T12:00:00.000Z',
    exportedBy: { displayName: 'gm_ana' },
    campaignId,
    systemLock: system,
    modulesLock: { modules: [] },
    chunks: [
      {
        placement: 'campaign',
        moduleId: 'campaign',
        chunkVersion: '1',
        payload: {
          name: 'Packaged Road',
          description: 'From a file.',
          system,
          gameMode: 'standard',
          modulePins: [],
          settings: { system: {} },
        },
      },
      {
        placement: 'attachments-manifest',
        moduleId: 'attachments',
        chunkVersion: '1',
        payload: { campaignId, binaries: 'excluded', entries: [] },
      },
      ...(variant === 'unknown_chunk'
        ? [
            {
              placement: 'entities' as const,
              moduleId: 'future-notes',
              chunkVersion: '4',
              payload: { notes: [{ text: '<img src=x onerror=alert(1)>' }] },
            },
          ]
        : []),
    ],
  };
  const built = await buildPackage(input);
  process.stdout.write(Buffer.from(concatParts(built.parts)).toString('base64'));
} else if (command === 'chunks' && argument !== undefined) {
  const result = await inspectPackage(new Uint8Array(await Bun.file(argument).arrayBuffer()));
  if (!result.ok) throw new Error(result.error.code);
  process.stdout.write(
    JSON.stringify({
      systemLock: result.value.systemLock,
      chunks: Object.fromEntries(
        result.value.chunks.map((chunk) => [chunk.moduleId, chunk.payload]),
      ),
    }),
  );
} else if (command === 'inspect' && argument !== undefined) {
  const bytes = new Uint8Array(await Bun.file(argument).arrayBuffer());
  const result = await inspectPackage(bytes);
  process.stdout.write(
    JSON.stringify(
      result.ok
        ? {
            ok: true,
            exportedBy: result.value.manifest.exportedBy.displayName,
            content: result.value.manifest.content,
            systemLock: result.value.systemLock,
            modules: result.value.chunks.map((chunk) => chunk.moduleId),
          }
        : { ok: false, code: result.error.code },
    ),
  );
} else {
  process.stderr.write('usage: rpgpack.ts build [campaignId] | inspect <file>\n');
  process.exit(2);
}
