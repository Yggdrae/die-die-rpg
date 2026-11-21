import { describe, expect, test } from 'bun:test';
import { forgetDeviceSession, readDeviceSession, rememberDeviceSession } from './device-session.ts';

function memory() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}

describe('device session', () => {
  test('survives a reopen and is gone after forgetting', () => {
    const storage = memory();
    expect(readDeviceSession(storage)).toBeUndefined();
    rememberDeviceSession({ userId: 'user', campaignId: 'campaign' }, storage);
    expect(readDeviceSession(storage)).toEqual({ userId: 'user', campaignId: 'campaign' });
    rememberDeviceSession({ userId: 'other' }, storage);
    expect(readDeviceSession(storage)).toEqual({ userId: 'other' });
    forgetDeviceSession(storage);
    expect(readDeviceSession(storage)).toBeUndefined();
  });

  test('a damaged value reads as no session', () => {
    const storage = memory();
    for (const raw of ['not json', 'null', '7', '{}', '{"userId":""}', '{"userId":3}']) {
      storage.values.set('rpg.device-session', raw);
      expect(readDeviceSession(storage)).toBeUndefined();
    }
    storage.values.set('rpg.device-session', '{"userId":"user","campaignId":9}');
    expect(readDeviceSession(storage)).toEqual({ userId: 'user' });
  });

  test('a store that throws costs the reopen and nothing else', () => {
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('full');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    expect(readDeviceSession(broken)).toBeUndefined();
    expect(() => rememberDeviceSession({ userId: 'user' }, broken)).not.toThrow();
    expect(() => forgetDeviceSession(broken)).not.toThrow();
  });
});
