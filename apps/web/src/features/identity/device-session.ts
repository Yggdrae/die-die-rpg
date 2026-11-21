/**
 * Which account this device last signed in with, and the campaign it last opened. The reopened app
 * has no other way to find its local replica while offline (the session cookie is not readable and
 * the API is unreachable). Holds identifiers only, never a credential: the API still decides every
 * request, and a rejected session (`unauthenticated`) sends the user back to the login form.
 */
export interface DeviceSession {
  readonly userId: string;
  readonly campaignId?: string;
}

type SessionStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const KEY = 'rpg.device-session';

function browserStorage(): SessionStorage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export function readDeviceSession(storage = browserStorage()): DeviceSession | undefined {
  try {
    const value: unknown = JSON.parse(storage?.getItem(KEY) ?? 'null');
    if (typeof value !== 'object' || value === null) return undefined;
    const { userId, campaignId } = value as Record<string, unknown>;
    if (typeof userId !== 'string' || userId === '') return undefined;
    return typeof campaignId === 'string' && campaignId !== ''
      ? { userId, campaignId }
      : { userId };
  } catch {
    return undefined;
  }
}

/** Private browsing or a full store only costs the offline reopen; signing in still works. */
export function rememberDeviceSession(session: DeviceSession, storage = browserStorage()): void {
  try {
    storage?.setItem(KEY, JSON.stringify(session));
  } catch {
    return;
  }
}

export function forgetDeviceSession(storage = browserStorage()): void {
  try {
    storage?.removeItem(KEY);
  } catch {
    return;
  }
}
