import { describe, expect, test } from 'bun:test';
import { Type } from '@sinclair/typebox';
import { AuditRendererRegistry, GENERIC_RENDERER_VERSION } from './renderers.ts';

const event = {
  action: 'resource.changed',
  targetType: 'character_resource',
  targetId: '0198f702-4be0-7000-8000-000000000001',
  before: { value: 6, secret: 'hidden-gm-note' },
  after: { value: 2, secret: 'hidden-gm-note' },
  at: '2026-10-24T12:00:00.000Z',
};

describe('audit renderer registry', () => {
  test('renders through the registered (action, version) declaration', () => {
    const registry = new AuditRendererRegistry();
    registry.register({
      action: 'resource.changed',
      version: 1,
      render: (input) => ({
        text: `Resource went from ${input.before?.value} to ${input.after?.value}.`,
      }),
    });
    expect(registry.currentVersion('resource.changed')).toBe(1);
    expect(registry.render({ ...event, rendererVersion: 1 })).toEqual({
      kind: 'registered',
      text: 'Resource went from 6 to 2.',
    });
  });

  test('keeps old versions renderable and writes new events with the latest', () => {
    const registry = new AuditRendererRegistry();
    registry.register({ action: 'resource.changed', version: 1, render: () => ({ text: 'v1' }) });
    registry.register({ action: 'resource.changed', version: 2, render: () => ({ text: 'v2' }) });
    expect(registry.currentVersion('resource.changed')).toBe(2);
    expect(registry.render({ ...event, rendererVersion: 1 }).text).toBe('v1');
    expect(registry.render({ ...event, rendererVersion: 2 }).text).toBe('v2');
  });

  test('rejects duplicate or malformed declarations', () => {
    const registry = new AuditRendererRegistry();
    const declaration = { action: 'resource.changed', version: 1, render: () => ({ text: 'x' }) };
    registry.register(declaration);
    expect(() => registry.register(declaration)).toThrow('duplicate_audit_declaration');
    expect(() => registry.register({ ...declaration, version: 0 })).toThrow(
      'invalid_audit_declaration',
    );
    expect(() => registry.register({ ...declaration, action: 'Bad Action' })).toThrow(
      'invalid_audit_declaration',
    );
  });

  test('missing, throwing, or invalid renderers fall back without raw values', () => {
    const registry = new AuditRendererRegistry();
    registry.register({
      action: 'resource.changed',
      version: 1,
      render: () => {
        throw new Error('hidden-gm-note');
      },
    });
    registry.register({
      action: 'resource.changed',
      version: 2,
      render: () => ({ text: 'ok', leaked: event.before }) as unknown as { text: string },
    });

    const unregistered = registry.render({ ...event, action: 'unknown.event', rendererVersion: 0 });
    const throwing = registry.render({ ...event, rendererVersion: 1 });
    const invalid = registry.render({ ...event, rendererVersion: 2 });
    const unsafe = registry.render({
      ...event,
      action: '{"secret":"hidden-gm-note"}',
      rendererVersion: GENERIC_RENDERER_VERSION,
    });

    expect(unregistered).toEqual({
      kind: 'generic',
      text: 'Recorded unknown.event on character_resource.',
    });
    expect(throwing.kind).toBe('generic');
    expect(invalid.kind).toBe('generic');
    expect(unsafe).toEqual({ kind: 'generic', text: 'Recorded a change.' });
    for (const rendering of [unregistered, throwing, invalid, unsafe]) {
      expect(JSON.stringify(rendering)).not.toContain('hidden-gm-note');
    }
  });

  test('validates payloads and supplies declared default visibility', () => {
    const registry = new AuditRendererRegistry();
    registry.register({
      action: 'resource.changed',
      version: 1,
      payload: Type.Object({ value: Type.Integer() }, { additionalProperties: false }),
      targetVisibility: { mode: 'everyone' },
      render: () => ({ text: 'changed' }),
    });
    expect(registry.acceptsPayload('resource.changed', { before: { value: 1 } })).toBe(true);
    expect(registry.acceptsPayload('resource.changed', { after: { value: 'x' } })).toBe(false);
    expect(registry.acceptsPayload('unregistered', { after: { anything: true } })).toBe(true);
    expect(registry.defaultVisibility('resource.changed')).toEqual({
      visibility: { mode: 'everyone' },
    });
    expect(registry.defaultVisibility('unregistered')).toBeUndefined();
  });
});
