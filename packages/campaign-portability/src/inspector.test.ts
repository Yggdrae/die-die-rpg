import { describe, expect, test } from 'bun:test';
import { canonicalBytes, sha256Hex, utf8 } from './canonical.ts';
import { type InspectionCode, inspectPackage } from './inspector.ts';
import { PACKAGE_LIMITS } from './limits.ts';
import { deflate, type RawEntry, rawZip, validPackage } from './test-fixtures.ts';
import { concatParts, extractEntry, readZipDirectory } from './zip.ts';

/**
 * Feature 07 task 02 — `_bdd.md` "Invalid package input changes nothing". The inspector is a pure
 * function of the bytes (no write port exists to call), so every rejection below is also proof
 * that nothing was written: it returns a safe code before any caller could reach a domain write.
 */

async function filesOf(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  const directory = readZipDirectory(bytes);
  if (!directory.ok) throw new Error(directory.error);
  const files = new Map<string, Uint8Array>();
  for (const entry of directory.value) {
    const data = await extractEntry(bytes, entry);
    if (!data.ok) throw new Error(data.error);
    files.set(entry.path, data.value);
  }
  return files;
}

function zipOf(files: Map<string, Uint8Array>, extra: Partial<RawEntry> = {}): Uint8Array {
  return rawZip([...files].map(([name, data]) => ({ name, data, ...extra })));
}

function parse(bytes: Uint8Array): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
}

async function expectCode(bytes: Uint8Array, code: InspectionCode) {
  const result = await inspectPackage(bytes);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.code).toBe(code);
  return result;
}

/** Replaces one entry and fixes the manifest checksums, so only the intended defect remains. */
async function withEntry(path: string, data: Uint8Array): Promise<Uint8Array> {
  const { bytes } = await validPackage();
  const files = await filesOf(bytes);
  files.set(path, data);
  const manifest = parse(files.get('manifest.json') as Uint8Array) as {
    entries: { path: string; sha256: string; size: number }[];
    contributors: { path: string; checksum: string }[];
    preserved: { path: string; checksum: string }[];
  };
  const sha256 = await sha256Hex(data);
  for (const entry of manifest.entries) {
    if (entry.path === path) Object.assign(entry, { sha256, size: data.length });
  }
  for (const record of [...manifest.contributors, ...manifest.preserved]) {
    if (record.path === path) record.checksum = sha256;
  }
  files.set('manifest.json', canonicalBytes(manifest));
  return zipOf(files);
}

describe('a valid package', () => {
  test('round-trips through the inspector with every member and checksum', async () => {
    const { built, bytes } = await validPackage();
    const result = await inspectPackage(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.manifestChecksum).toBe(built.manifestChecksum);
    expect(result.value.systemLock).toEqual({ systemId: 'fixture-system', version: '1.0.0' });
    expect(
      result.value.chunks.map((chunk) => [chunk.moduleId, chunk.placement, chunk.path]),
    ).toEqual([
      ['attachments', 'attachments-manifest', 'attachments-manifest/attachments.json'],
      ['campaign', 'campaign', 'campaign.json'],
      ['npcs', 'entities', 'entities/npcs.json'],
    ]);
    expect(result.value.preserved).toEqual([
      expect.objectContaining({
        moduleId: 'future-thing',
        chunkVersion: '7',
        path: 'unknown/future-thing/7.json',
        payload: { opaque: [1, 2, 3] },
      }),
    ]);
  });

  test('a deflated package written by another tool is accepted', async () => {
    const files = await filesOf((await validPackage()).bytes);
    const entries: RawEntry[] = [];
    for (const [name, data] of files) {
      entries.push({ name, data, stored: await deflate(data), method: 8 });
    }
    expect((await inspectPackage(rawZip(entries))).ok).toBe(true);
  });

  test('the default limits are the _db.md limits', () => {
    expect(PACKAGE_LIMITS).toEqual({
      maxPackageBytes: 250 * 1024 * 1024,
      maxTotalUncompressedBytes: 500 * 1024 * 1024,
      maxEntries: 10_000,
      maxEntryBytes: 50 * 1024 * 1024,
      maxCompressionRatio: 100,
    });
  });
});

describe('Scenario Outline: Invalid package input changes nothing', () => {
  test('malformed container', async () => {
    await expectCode(utf8('not a zip at all, just text'), 'malformed_container');
    await expectCode(new Uint8Array(), 'malformed_container');
    const { bytes } = await validPackage();
    await expectCode(bytes.subarray(0, bytes.length - 5), 'malformed_container');
    await expectCode(bytes.subarray(10), 'malformed_container');
    // Trailing bytes, a comment, or prepended data (self-extractor) are refused.
    await expectCode(concatParts([bytes, utf8('x')]), 'malformed_container');
    const files = await filesOf(bytes);
    const entries = [...files].map(([name, data]) => ({ name, data }));
    await expectCode(rawZip(entries, { comment: utf8('hi') }), 'malformed_container');
    await expectCode(rawZip(entries, { prefix: utf8('MZ') }), 'malformed_container');
    // A local header whose name differs from the central record.
    await expectCode(
      rawZip(
        entries.map((entry, index) => (index === 0 ? { ...entry, localName: 'x.json' } : entry)),
      ),
      'malformed_container',
    );
  });

  test('missing required manifest member', async () => {
    for (const missing of [
      'manifest.json',
      'campaign.json',
      'system.lock',
      'modules.lock',
      'attachments-manifest/attachments.json',
    ]) {
      const files = await filesOf((await validPackage()).bytes);
      files.delete(missing);
      await expectCode(zipOf(files), 'missing_required_member');
    }
  });

  test('manifest failing its TypeBox schema', async () => {
    const partial = await filesOf((await validPackage()).bytes);
    partial.set('manifest.json', utf8('{"format":"rpgpack","formatVersion":1}'));
    await expectCode(zipOf(partial), 'manifest_invalid');
    const files = await filesOf((await validPackage()).bytes);
    const manifest = parse(files.get('manifest.json') as Uint8Array);
    for (const defect of [
      { ...manifest, exportedBy: { displayName: 'R', email: 'r@example.com' } },
      { ...manifest, source: { campaignId: '../../etc/passwd' } },
      { ...manifest, content: { attachmentBinaries: 'included', audit: 'excluded' } },
      { ...manifest, exportedAt: '2026-10-27T12:00:00+02:00' },
      { ...manifest, extra: true },
    ]) {
      files.set('manifest.json', canonicalBytes(defect));
      await expectCode(zipOf(files), 'manifest_invalid');
    }
    files.set('manifest.json', canonicalBytes({ ...manifest, formatVersion: 99 }));
    await expectCode(zipOf(files), 'unsupported_format_version');
  });

  test('duplicate module identifier', async () => {
    const files = await filesOf((await validPackage()).bytes);
    const manifest = parse(files.get('manifest.json') as Uint8Array) as {
      contributors: { moduleId: string; path: string }[];
    };
    const npcs = manifest.contributors.find((record) => record.moduleId === 'npcs');
    manifest.contributors.push({
      ...(npcs as { moduleId: string; path: string }),
      moduleId: 'npcs',
    });
    files.set('manifest.json', canonicalBytes(manifest));
    await expectCode(zipOf(files), 'duplicate_module');

    // The same entry twice in the archive (also case-folded) is a duplicate entry.
    const twice = await filesOf((await validPackage()).bytes);
    const entries = [...twice].map(([name, data]) => ({ name, data }));
    await expectCode(rawZip([...entries, entries[1] as RawEntry]), 'duplicate_entry');
    await expectCode(
      rawZip([...entries, { name: 'CAMPAIGN.json', data: utf8('{}') }]),
      'duplicate_entry',
    );
  });

  test('checksum mismatch', async () => {
    const files = await filesOf((await validPackage()).bytes);
    files.set(
      'campaign.json',
      canonicalBytes({ moduleId: 'campaign', chunkVersion: '1', payload: {} }),
    );
    const result = await expectCode(zipOf(files), 'checksum_mismatch');
    if (!result.ok) expect(result.error.path).toBe('campaign.json');

    // Contributor checksum substituted while the entry checksum is consistent.
    const swapped = await filesOf((await validPackage()).bytes);
    const manifest = parse(swapped.get('manifest.json') as Uint8Array) as {
      contributors: { checksum: string }[];
    };
    (manifest.contributors[0] as { checksum: string }).checksum = '0'.repeat(64);
    swapped.set('manifest.json', canonicalBytes(manifest));
    await expectCode(zipOf(swapped), 'checksum_mismatch');

    // A CRC that disagrees with the bytes.
    const crcFiles = await filesOf((await validPackage()).bytes);
    await expectCode(
      rawZip([...crcFiles].map(([name, data]) => ({ name, data, crc: 12345 }))),
      'crc_mismatch',
    );
  });

  test('path traversal entry', async () => {
    const files = await filesOf((await validPackage()).bytes);
    for (const name of [
      '../evil.json',
      'entities/../../evil.json',
      '/etc/passwd',
      'entities\\npcs.json',
      'C:/windows/evil.json',
      'c:evil.json',
      'entities//npcs.json',
      './campaign.json',
      'entities/npcs.json\u0000.png',
    ]) {
      const result = await expectCode(
        rawZip([...[...files].map(([n, data]) => ({ name: n, data })), { name, data: utf8('{}') }]),
        'path_traversal',
      );
      // The rejected name is never echoed back.
      if (!result.ok) expect(result.error.path).toBeUndefined();
    }
  });

  test('symlink and other non-file entries', async () => {
    const files = [...(await filesOf((await validPackage()).bytes))].map(([name, data]) => ({
      name,
      data,
    }));
    const unix = (3 << 8) | 20;
    await expectCode(
      rawZip([
        ...files,
        {
          name: 'entities/link.json',
          data: utf8('/etc/passwd'),
          madeBy: unix,
          externalAttributes: (0o120777 << 16) >>> 0,
        },
      ]),
      'symlink_entry',
    );
    await expectCode(
      rawZip([...files, { name: 'entities/', data: new Uint8Array(), externalAttributes: 0x10 }]),
      'unsupported_entry',
    );
    await expectCode(
      rawZip([...files, { name: 'evil.exe', data: utf8('MZ') }]),
      'unsupported_entry',
    );
    await expectCode(
      rawZip([...files, { name: 'entities/Bad.json', data: utf8('{}') }]),
      'unsupported_entry',
    );
    await expectCode(
      rawZip(files.map((file) => ({ ...file, flags: 0x0801 }))),
      'unsupported_entry',
    );
    await expectCode(rawZip(files.map((file) => ({ ...file, method: 12 }))), 'unsupported_entry');
    // Undeclared but well-placed entries are refused too.
    const extra = new Map((await filesOf((await validPackage()).bytes)).entries());
    extra.set('documents/handouts.json', utf8('{}'));
    await expectCode(zipOf(extra), 'undeclared_entry');
  });

  test('entry exceeding a declared limit', async () => {
    const files = [...(await filesOf((await validPackage()).bytes))].map(([name, data]) => ({
      name,
      data,
    }));
    const small = { ...PACKAGE_LIMITS, maxEntryBytes: 64 };
    const big = await inspectPackage(rawZip(files), { limits: small });
    expect(big.ok ? undefined : big.error.code).toBe('entry_too_large');

    const fewEntries = await inspectPackage(rawZip(files), {
      limits: { ...PACKAGE_LIMITS, maxEntries: files.length - 1 },
    });
    expect(fewEntries.ok ? undefined : fewEntries.error.code).toBe('too_many_entries');

    const total = await inspectPackage(rawZip(files), {
      limits: { ...PACKAGE_LIMITS, maxTotalUncompressedBytes: 200 },
    });
    expect(total.ok ? undefined : total.error.code).toBe('total_size_exceeded');

    const bytes = rawZip(files);
    const whole = await inspectPackage(bytes, {
      limits: { ...PACKAGE_LIMITS, maxPackageBytes: bytes.length - 1 },
    });
    expect(whole.ok ? undefined : whole.error.code).toBe('package_too_large');
    // Exactly at the limit is accepted.
    expect(
      (
        await inspectPackage(bytes, {
          limits: { ...PACKAGE_LIMITS, maxPackageBytes: bytes.length },
        })
      ).ok,
    ).toBe(true);
  });

  test('a zip bomb is refused from the directory, and a lying size during decompression', async () => {
    const zeros = new Uint8Array(1024 * 1024);
    const compressed = await deflate(zeros);
    expect(zeros.length / compressed.length).toBeGreaterThan(100);
    const files = [...(await filesOf((await validPackage()).bytes))].map(([name, data]) => ({
      name,
      data,
    }));
    await expectCode(
      rawZip([
        ...files,
        { name: 'documents/bomb.json', data: zeros, stored: compressed, method: 8 },
      ]),
      'compression_ratio_exceeded',
    );
    // Declared size smaller than the real output: decompression stops at the declared size.
    const json = utf8(
      JSON.stringify({ moduleId: 'campaign', chunkVersion: '1', payload: 'x'.repeat(5000) }),
    );
    const stored = await deflate(json);
    const lying = files.map((file) =>
      file.name === 'campaign.json'
        ? { name: file.name, data: json, stored, method: 8, declaredSize: 40 }
        : file,
    );
    await expectCode(rawZip(lying), 'entry_size_mismatch');
  });

  test('deeply nested or oversized JSON is refused before it is parsed', async () => {
    const deep = utf8(`{"a":${'['.repeat(10_000)}${']'.repeat(10_000)}}`);
    await expectCode(await withEntry('campaign.json', deep), 'json_limits_exceeded');
    await expectCode(await withEntry('campaign.json', utf8('{"moduleId":')), 'malformed_json');
    await expectCode(
      await withEntry('campaign.json', new Uint8Array([0xff, 0xfe, 0x7b])),
      'malformed_json',
    );
    await expectCode(
      await withEntry(
        'campaign.json',
        utf8('{"moduleId":"campaign","chunkVersion":"1","payload":{"__proto__":{"admin":true}}}'),
      ),
      'json_limits_exceeded',
    );
  });

  test('a chunk whose envelope disagrees with its manifest record', async () => {
    await expectCode(
      await withEntry(
        'entities/npcs.json',
        canonicalBytes({ moduleId: 'other', chunkVersion: '2', payload: {} }),
      ),
      'chunk_invalid',
    );
    await expectCode(
      await withEntry(
        'entities/npcs.json',
        canonicalBytes({ moduleId: 'npcs', chunkVersion: '2' }),
      ),
      'chunk_invalid',
    );
  });

  test('invalid lock files', async () => {
    await expectCode(
      await withEntry('system.lock', canonicalBytes({ systemId: 'Fixture System', version: '1' })),
      'lock_invalid',
    );
    await expectCode(
      await withEntry(
        'modules.lock',
        canonicalBytes({
          modules: [
            { moduleId: 'a', version: '1' },
            { moduleId: 'a', version: '2' },
          ],
        }),
      ),
      'lock_invalid',
    );
  });
});

describe('fuzzing: hostile bytes never throw and never pass as a different package', () => {
  test('random single-byte and truncation mutations of a valid package', async () => {
    const { bytes, built } = await validPackage();
    let seed = 0x1234_5678;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) >>> 0;
      return seed;
    };
    for (let round = 0; round < 400; round += 1) {
      const mutated = bytes.slice();
      const flips = 1 + (random() % 4);
      for (let flip = 0; flip < flips; flip += 1) {
        mutated[random() % mutated.length] = random() & 0xff;
      }
      const cut = round % 5 === 0 ? mutated.subarray(0, random() % mutated.length) : mutated;
      const result = await inspectPackage(cut);
      if (result.ok) {
        // A mutation that survives must have hit nothing that matters (e.g. a time field).
        expect(result.value.manifestChecksum).toBe(built.manifestChecksum);
      } else {
        expect(typeof result.error.code).toBe('string');
      }
    }
  });

  test('random garbage', async () => {
    let seed = 99;
    for (let round = 0; round < 200; round += 1) {
      const length = (round * 37) % 600;
      const garbage = new Uint8Array(length);
      for (let index = 0; index < length; index += 1) {
        seed = (seed * 1_103_515_245 + 12_345) >>> 0;
        garbage[index] = seed & 0xff;
      }
      const result = await inspectPackage(garbage);
      expect(result.ok).toBe(false);
    }
  });
});
