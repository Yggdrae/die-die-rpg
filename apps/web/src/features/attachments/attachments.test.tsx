import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { AttachmentListView, AttachmentPreview } from './Attachments.tsx';
import { isSeparateOriginUrl, readOutcomeOf, viewerKindOf } from './attachment-model.ts';
import { type FetchLike, requestRead, uploadAttachment } from './attachments-api.ts';

const APP = 'http://127.0.0.1:4173';
const STORAGE = 'http://localhost:9000/rpg-attachments/campaigns/a/b/c?X-Amz-Signature=x';
const CAMPAIGN = '00000000-0000-4000-8000-0000000000a1';
const ID = '00000000-0000-4000-8000-000000009001';
const OWNER = { resourceClass: 'fixture_note', resourceId: '00000000-0000-4000-8000-000000001001' };

const grant = {
  attachmentId: ID,
  method: 'GET',
  url: STORAGE,
  expiresAt: '2026-10-27T12:05:00.000Z',
  mime: 'image/png',
  disposition: 'inline',
};

describe('read outcome (FR-007, FR-008)', () => {
  test('only a 200 with an HTTP(S) URL on another origin is usable', () => {
    expect(readOutcomeOf(200, grant, APP)).toEqual({
      kind: 'granted',
      url: STORAGE,
      expiresAt: grant.expiresAt,
    });
    for (const url of [
      `${APP}/campaigns/x`,
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'blob:http://127.0.0.1:4173/x',
      'not a url',
    ]) {
      expect({ url, outcome: readOutcomeOf(200, { ...grant, url }, APP) }).toEqual({
        url,
        outcome: { kind: 'unavailable' },
      });
    }
    for (const status of [401, 404, 503]) {
      expect(readOutcomeOf(status, grant, APP)).toEqual({ kind: 'unavailable' });
    }
    expect(readOutcomeOf(200, null, APP)).toEqual({ kind: 'unavailable' });
    expect(isSeparateOriginUrl(STORAGE, APP)).toBe(true);
  });

  test('viewer kinds follow the allowlist', () => {
    expect(
      [
        'image/png',
        'image/jpeg',
        'image/webp',
        'application/pdf',
        'image/svg+xml',
        'text/html',
      ].map(viewerKindOf),
    ).toEqual(['image', 'image', 'image', 'document', 'unsupported', 'unsupported']);
  });

  test('a network failure or malformed body reads as unavailable', async () => {
    const failing: FetchLike = async () => {
      throw new TypeError('offline');
    };
    expect(await requestRead(CAMPAIGN, ID, 'inline', failing, APP)).toEqual({
      kind: 'unavailable',
    });
    const html: FetchLike = async () => new Response('<html>', { status: 200 });
    expect(await requestRead(CAMPAIGN, ID, 'inline', html, APP)).toEqual({ kind: 'unavailable' });
  });
});

describe('viewers render nothing executable', () => {
  const resolve = async () => ({ kind: 'unavailable' as const });

  test('an image starts loading and never inlines content; a PDF is never embedded', () => {
    const image = renderToStaticMarkup(
      <AttachmentPreview
        attachment={{
          attachmentId: ID,
          filename: '<img src=x onerror=alert(1)>.png',
          mime: 'image/png',
          size: 2048,
          visibility: { mode: 'everyone' },
        }}
        resolveRead={resolve}
      />,
    );
    expect(image).toContain('Loading preview');
    expect(image).toContain('&lt;img src=x onerror=alert(1)&gt;.png');
    const pdf = renderToStaticMarkup(
      <AttachmentPreview
        attachment={{
          attachmentId: ID,
          filename: 'letter.pdf',
          mime: 'application/pdf',
          size: 2048,
          visibility: { mode: 'everyone' },
        }}
        resolveRead={resolve}
      />,
    );
    expect(pdf).toContain('Open letter.pdf');
    expect(pdf).toContain('Download');
    for (const markup of [image, pdf]) {
      expect(markup).not.toMatch(/<(iframe|embed|object|script)\b/);
      expect(markup).not.toContain('srcdoc');
      expect(markup).not.toContain('dangerouslySetInnerHTML');
    }
  });

  test('list states are explicit; nothing is blank', () => {
    expect(
      renderToStaticMarkup(
        <AttachmentListView state={{ kind: 'unavailable' }} resolveRead={resolve} />,
      ),
    ).toContain('Attachments are unavailable right now.');
    expect(
      renderToStaticMarkup(
        <AttachmentListView state={{ kind: 'ready', items: [] }} resolveRead={resolve} />,
      ),
    ).toContain('No attachments.');
  });
});

describe('upload client (FR-003)', () => {
  function recorder(responses: Response[]) {
    const calls: { input: string; init: RequestInit }[] = [];
    const fetchImpl: FetchLike = async (input, init) => {
      calls.push({ input, init });
      const next = responses.shift();
      if (next === undefined) throw new Error('unexpected request');
      return next;
    };
    return { calls, fetchImpl };
  }

  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

  test('API requests carry metadata only; the bytes go to the granted URL without cookies', async () => {
    const metadata = { attachmentId: ID, status: 'ready' };
    const { calls, fetchImpl } = recorder([
      Response.json(
        {
          attachment: {
            attachmentId: ID,
            status: 'pending',
            expiresAt: '2026-10-28T12:00:00.000Z',
          },
          upload: {
            method: 'PUT',
            url: STORAGE,
            headers: { 'content-type': 'image/png' },
            expiresAt: 'x',
          },
        },
        { status: 201 },
      ),
      new Response(null, { status: 200 }),
      Response.json({ attachment: metadata }),
    ]);
    const file = new File([png], 'map.png', { type: 'image/png' });
    const outcome = await uploadAttachment(
      { campaignId: CAMPAIGN, owner: OWNER, file, visibility: { mode: 'everyone' } },
      fetchImpl,
    );
    expect(outcome).toEqual({ kind: 'attached', attachment: metadata as never });
    expect(calls.map((call) => [call.init.method, call.input])).toEqual([
      ['POST', `/campaigns/${CAMPAIGN}/attachments/uploads`],
      ['PUT', STORAGE],
      ['POST', `/campaigns/${CAMPAIGN}/attachments/${ID}/finalize`],
    ]);
    const permission = JSON.parse(String(calls[0]?.init.body));
    expect(permission).toEqual({
      owner: OWNER,
      visibility: { mode: 'everyone' },
      filename: 'map.png',
      mime: 'image/png',
      size: png.byteLength,
      checksum: new Bun.CryptoHasher('sha256').update(png).digest('hex'),
    });
    expect(calls[1]?.init.credentials).toBe('omit');
    expect(calls[1]?.init.referrerPolicy).toBe('no-referrer');
    expect(calls[1]?.init.headers).toEqual({ 'content-type': 'image/png' });
    expect(new Uint8Array(calls[1]?.init.body as ArrayBuffer)).toEqual(png);
    expect(JSON.parse(String(calls[2]?.init.body))).toEqual({
      size: png.byteLength,
      checksum: permission.checksum,
    });
  });

  test('an unsupported or oversized file is stopped before any request', async () => {
    const { calls, fetchImpl } = recorder([]);
    const svg = new File(['<svg/>'], 'x.svg', { type: 'image/svg+xml' });
    expect(
      await uploadAttachment(
        { campaignId: CAMPAIGN, owner: OWNER, file: svg, visibility: { mode: 'everyone' } },
        fetchImpl,
      ),
    ).toEqual({
      kind: 'rejected',
      reason: 'unsupported_file_type',
    });
    expect(calls).toHaveLength(0);
  });

  test('server rejections surface their reason; a denial is a plain failure', async () => {
    const tooLarge = recorder([
      Response.json(
        { code: 'file_too_large', message: 'Files are limited to 25 MB.' },
        { status: 413 },
      ),
    ]);
    const file = new File([png], 'map.png', { type: 'image/png' });
    const input = {
      campaignId: CAMPAIGN,
      owner: OWNER,
      file,
      visibility: { mode: 'everyone' as const },
    };
    expect(await uploadAttachment(input, tooLarge.fetchImpl)).toEqual({
      kind: 'rejected',
      reason: 'file_too_large',
    });
    const denied = recorder([
      Response.json({ code: 'not_found_or_forbidden', message: 'Not found.' }, { status: 404 }),
    ]);
    expect(await uploadAttachment(input, denied.fetchImpl)).toEqual({
      kind: 'failed',
      stage: 'permission',
    });
  });
});
