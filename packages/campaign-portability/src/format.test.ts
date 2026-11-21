import { describe, expect, test } from 'bun:test';
import {
  CanonicalJsonError,
  canonicalJson,
  parseBoundedJson,
  sha256Hex,
  utf8,
} from './canonical.ts';
import { buildPackage, PackageBuildError } from './format.ts';
import { inspectPackage } from './inspector.ts';
import { entryRole, isSafeEntryPath } from './paths.ts';
import { validInput, validPackage } from './test-fixtures.ts';
import { concatParts, readZipDirectory } from './zip.ts';

/** Feature 07 task 02: deterministic layout and checksums (`_db.md`, Required Container Layout). */

describe('canonical JSON', () => {
  test('sorts keys at every depth, drops undefined members, and is stable', () => {
    const a = canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: undefined }, e: 'é' });
    const b = canonicalJson({ e: 'é', a: { d: [3, { y: 2, z: 1 }] }, b: 1 });
    expect(a).toBe('{"a":{"d":[3,{"y":2,"z":1}]},"b":1,"e":"é"}');
    expect(b).toBe(a);
  });

  test('refuses values JSON cannot round-trip', () => {
    for (const value of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      new Date(0),
      1n,
      () => 1,
      new Map(),
    ]) {
      expect(() => canonicalJson({ value })).toThrow(CanonicalJsonError);
    }
  });

  test('known SHA-256', async () => {
    expect(await sha256Hex(utf8('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  test('bounded parse enforces string, array, key and node limits', () => {
    const limits = {
      maxDepth: 4,
      maxStringLength: 5,
      maxArrayLength: 3,
      maxObjectKeys: 2,
      maxNodes: 10,
    };
    expect(parseBoundedJson(utf8('{"a":[1,2,3]}'), limits)).toEqual({
      ok: true,
      value: { a: [1, 2, 3] },
    });
    for (const text of [
      '"abcdef"',
      '[1,2,3,4]',
      '{"a":1,"b":2,"c":3}',
      '[[[[[1]]]]]',
      '[0,0,0,[0,0,0],[0,0,0]]',
    ]) {
      expect(parseBoundedJson(utf8(text), limits)).toEqual({
        ok: false,
        error: 'json_limits_exceeded',
      });
    }
    // Brackets inside strings do not count toward depth.
    expect(parseBoundedJson(utf8('"[[[["'), limits).ok).toBe(true);
  });
});

describe('entry paths', () => {
  test('the closed layout', () => {
    expect(entryRole('manifest.json')).toEqual({ kind: 'manifest' });
    expect(entryRole('campaign.json')).toEqual({ kind: 'chunk', placement: 'campaign' });
    expect(entryRole('entities/npcs.json')).toEqual({
      kind: 'chunk',
      placement: 'entities',
      moduleId: 'npcs',
    });
    expect(entryRole('documents/handouts.json')).toMatchObject({ placement: 'documents' });
    expect(entryRole('attachments-manifest/attachments.json')).toMatchObject({
      placement: 'attachments-manifest',
      moduleId: 'attachments',
    });
    expect(entryRole('unknown/x/1.2.json')).toEqual({
      kind: 'preserved',
      moduleId: 'x',
      chunkVersion: '1.2',
    });
    for (const path of [
      'campaign/x.json',
      'entities/a/b.json',
      'unknown/x/..json',
      'entities/A.json',
      'readme.txt',
    ]) {
      expect(entryRole(path)).toBeUndefined();
    }
  });

  test('unsafe paths', () => {
    for (const path of [
      '',
      '/a',
      'a\\b',
      'c:/a',
      'a//b',
      'a/./b',
      'a/../b',
      '..',
      'a\u0001',
      'x'.repeat(256),
    ]) {
      expect(isSafeEntryPath(path)).toBe(false);
    }
    expect(isSafeEntryPath('entities/npcs.json')).toBe(true);
  });
});

describe('package writer', () => {
  test('equal logical content gives identical bytes, checksums and manifest', async () => {
    const first = await validPackage();
    const reordered = validInput();
    const second = await validPackage({
      chunks: [...reordered.chunks].reverse(),
      modulesLock: { modules: [...reordered.modulesLock.modules].reverse() },
    });
    expect(second.bytes).toEqual(first.bytes);
    expect(second.built.manifestChecksum).toBe(first.built.manifestChecksum);
  });

  test('entries are sorted, manifest first, and every entry has a manifest checksum', async () => {
    const { bytes, built } = await validPackage();
    const directory = readZipDirectory(bytes);
    if (!directory.ok) throw new Error(directory.error);
    const paths = directory.value.map((entry) => entry.path);
    expect(paths).toEqual([
      'manifest.json',
      'attachments-manifest/attachments.json',
      'campaign.json',
      'entities/npcs.json',
      'modules.lock',
      'system.lock',
      'unknown/future-thing/7.json',
    ]);
    expect(built.manifest.entries.map((entry) => entry.path)).toEqual(paths.slice(1));
    expect(built.manifest.content).toEqual({ attachmentBinaries: 'excluded', audit: 'excluded' });
    expect(built.summary).toEqual([
      expect.objectContaining({ moduleId: 'attachments', records: 0 }),
      expect.objectContaining({ moduleId: 'campaign', records: 1 }),
      expect.objectContaining({ moduleId: 'npcs', records: 1 }),
      expect.objectContaining({ moduleId: 'future-thing', preserved: true }),
    ]);
    expect(built.size).toBe(bytes.length);
  });

  test('a changed payload changes exactly its entry checksum', async () => {
    const base = await validPackage();
    const input = validInput();
    const changed = await validPackage({
      chunks: input.chunks.map((chunk) =>
        chunk.moduleId === 'npcs' ? { ...chunk, payload: { items: [] } } : chunk,
      ),
    });
    const differing = base.built.manifest.entries.filter(
      (entry, index) => changed.built.manifest.entries[index]?.sha256 !== entry.sha256,
    );
    expect(differing.map((entry) => entry.path)).toEqual(['entities/npcs.json']);
  });

  test('deflate output passes the inspector with the same logical checksums', async () => {
    const stored = await validPackage();
    const deflated = await validPackage({ compression: 'deflate' });
    expect(deflated.bytes.length).toBeLessThan(stored.bytes.length);
    const result = await inspectPackage(deflated.bytes);
    expect(result.ok && result.value.manifestChecksum).toBe(stored.built.manifestChecksum);
    // Highly repetitive content stays stored so the package never trips its own ratio limit.
    const input = validInput();
    const repetitive = await buildPackage({
      ...input,
      compression: 'deflate',
      chunks: input.chunks.map((chunk) =>
        chunk.moduleId === 'npcs' ? { ...chunk, payload: 'a'.repeat(200_000) } : chunk,
      ),
    });
    expect((await inspectPackage(concatParts(repetitive.parts))).ok).toBe(true);
  });

  test('refuses an incomplete or ambiguous contribution set', async () => {
    const input = validInput();
    const cases: [Partial<typeof input>, string][] = [
      [
        { chunks: input.chunks.filter((chunk) => chunk.placement !== 'campaign') },
        'missing_campaign_chunk',
      ],
      [
        { chunks: input.chunks.filter((chunk) => chunk.placement !== 'attachments-manifest') },
        'missing_attachment_manifest',
      ],
      [
        { chunks: [...input.chunks, input.chunks[2] as (typeof input.chunks)[number]] },
        'duplicate_module',
      ],
      [
        {
          chunks: [
            ...input.chunks,
            { ...(input.chunks[2] as (typeof input.chunks)[number]), moduleId: '../x' },
          ],
        },
        'invalid_module_id',
      ],
      [
        {
          chunks: [
            ...input.chunks,
            {
              ...(input.chunks[2] as (typeof input.chunks)[number]),
              moduleId: 'y',
              chunkVersion: '..',
            },
          ],
        },
        'invalid_chunk_version',
      ],
      [{ systemLock: { systemId: 'Bad Id', version: '1' } }, 'invalid_lock'],
      [{ exportedBy: { displayName: '' } }, 'invalid_metadata'],
      [
        {
          chunks: [
            ...input.chunks,
            {
              ...(input.chunks[2] as (typeof input.chunks)[number]),
              moduleId: 'z',
              payload: Number.NaN,
            },
          ],
        },
        'unserializable_payload',
      ],
    ];
    for (const [override, code] of cases) {
      try {
        await buildPackage({ ...input, ...override });
        throw new Error(`expected ${code}`);
      } catch (error) {
        expect(error).toBeInstanceOf(PackageBuildError);
        expect((error as PackageBuildError).code).toBe(code as PackageBuildError['code']);
      }
    }
  });
});
