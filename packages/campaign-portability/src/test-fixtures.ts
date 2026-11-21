import { utf8 } from './canonical.ts';
import { type BuiltPackage, buildPackage, type PackageInput } from './format.ts';
import { concatParts, crc32 } from './zip.ts';

/** Shared test fixtures for the format, inspector and orchestrator tests. Not exported. */

export const CAMPAIGN_ID = '0b5e7a9e-6a43-4c55-9d0e-3c0b2b0c1a01';

export function validInput(overrides: Partial<PackageInput> = {}): PackageInput {
  return {
    applicationVersion: '0.0.0-test',
    exportedAt: '2026-10-27T12:00:00.000Z',
    exportedBy: { displayName: 'Rowan' },
    campaignId: CAMPAIGN_ID,
    systemLock: { systemId: 'fixture-system', version: '1.0.0' },
    modulesLock: { modules: [{ moduleId: 'fixture-module', version: '1.0.0' }] },
    chunks: [
      {
        placement: 'campaign',
        moduleId: 'campaign',
        chunkVersion: '1',
        payload: { name: 'Ashen Road', description: 'A campaign.' },
        records: 1,
      },
      {
        placement: 'attachments-manifest',
        moduleId: 'attachments',
        chunkVersion: '1',
        payload: { binaries: 'excluded', entries: [] },
        records: 0,
      },
      {
        placement: 'entities',
        moduleId: 'npcs',
        chunkVersion: '2',
        payload: { items: [{ id: 'a', visibility: { mode: 'gm_only' } }] },
        records: 1,
      },
    ],
    preserved: [{ moduleId: 'future-thing', chunkVersion: '7', payload: { opaque: [1, 2, 3] } }],
    ...overrides,
  };
}

export async function validPackage(
  overrides: Partial<PackageInput> = {},
): Promise<{ built: BuiltPackage; bytes: Uint8Array }> {
  const built = await buildPackage(validInput(overrides));
  return { built, bytes: concatParts(built.parts) };
}

export interface RawEntry {
  readonly name: string | Uint8Array;
  readonly data: Uint8Array;
  /** Bytes stored in the archive. Defaults to `data` (stored). */
  readonly stored?: Uint8Array;
  readonly method?: number;
  readonly flags?: number;
  readonly madeBy?: number;
  readonly externalAttributes?: number;
  readonly declaredSize?: number;
  readonly crc?: number;
  /** Local header name, when it should differ from the central one. */
  readonly localName?: string;
}

/**
 * Hand-rolled ZIP with no validation, for hostile fixtures (traversal names, symlinks, lying
 * sizes, bombs). Structure mirrors `writeZip`.
 */
export function rawZip(
  entries: readonly RawEntry[],
  options: { readonly comment?: Uint8Array; readonly prefix?: Uint8Array } = {},
): Uint8Array {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = options.prefix?.length ?? 0;
  if (options.prefix !== undefined) parts.push(options.prefix);
  for (const entry of entries) {
    const name = typeof entry.name === 'string' ? utf8(entry.name) : entry.name;
    const localName = entry.localName === undefined ? name : utf8(entry.localName);
    const body = entry.stored ?? entry.data;
    const crc = entry.crc ?? crc32(entry.data);
    const size = entry.declaredSize ?? entry.data.length;
    const method = entry.method ?? 0;
    const flags = entry.flags ?? 0x0800;
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, flags, true);
    local.setUint16(8, method, true);
    local.setUint16(12, 0x21, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, body.length, true);
    local.setUint32(22, size, true);
    local.setUint16(26, localName.length, true);
    parts.push(new Uint8Array(local.buffer), localName, body);
    const header = new DataView(new ArrayBuffer(46));
    header.setUint32(0, 0x02014b50, true);
    header.setUint16(4, entry.madeBy ?? 20, true);
    header.setUint16(6, 20, true);
    header.setUint16(8, flags, true);
    header.setUint16(10, method, true);
    header.setUint16(14, 0x21, true);
    header.setUint32(16, crc, true);
    header.setUint32(20, body.length, true);
    header.setUint32(24, size, true);
    header.setUint16(28, name.length, true);
    header.setUint32(38, entry.externalAttributes ?? 0, true);
    header.setUint32(42, offset, true);
    central.push(new Uint8Array(header.buffer), name);
    offset += 30 + localName.length + body.length;
  }
  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const comment = options.comment ?? new Uint8Array();
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  end.setUint16(20, comment.length, true);
  return concatParts([...parts, ...central, new Uint8Array(end.buffer), comment]);
}

export async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as Uint8Array<ArrayBuffer>])
    .stream()
    .pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Re-packs an archive's entries (after an edit) with `rawZip`, keeping names and data. */
export function entriesOf(files: Record<string, unknown>): RawEntry[] {
  return Object.entries(files).map(([name, value]) => ({
    name,
    data: value instanceof Uint8Array ? value : utf8(JSON.stringify(value)),
  }));
}
