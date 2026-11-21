/**
 * Forbidden-data scanner (`_db.md`, Privacy and Authorization; `_techspec.md`, Security). A second
 * line of defense behind each contributor's own projection: a chunk naming a credential, account
 * email, object-storage key, signed URL, audit store, sync internal or local cache path fails the
 * export before a package exists.
 *
 * Keys are compared after lower-casing and removing `_`/`-`. The list is deliberately specific:
 * game content legitimately uses words such as `secret`, `token` (map tokens) and `session` (game
 * sessions), so only unambiguous credential and infrastructure names are refused.
 */

const FORBIDDEN_KEYS = new Set([
  'password',
  'passwordhash',
  'passwordcredential',
  'passwordcredentials',
  'credential',
  'credentials',
  'credentialdigest',
  'tokendigest',
  'accesstoken',
  'refreshtoken',
  'recoverytoken',
  'invitationtoken',
  'sessiontoken',
  'sessioncredential',
  'bearertoken',
  'authtoken',
  'csrftoken',
  'apikey',
  'clientsecret',
  'privatekey',
  'email',
  'emailaddress',
  'objectkey',
  'storagekey',
  'signedurl',
  'presignedurl',
  'uploadurl',
  'downloadurl',
  'pendingmutations',
  'syncqueue',
  'mutationqueue',
  'lastservercursor',
  'localpath',
  'cachepath',
  'opfspath',
]);

const FORBIDDEN_KEY_PREFIXES = ['audit'];

const FORBIDDEN_VALUE_PATTERNS: readonly RegExp[] = [
  /X-Amz-(?:Signature|Credential|Security-Token)/i,
  /[?&](?:Signature|sig|X-Goog-Signature)=/,
  /^s3:\/\//i,
  /^\$argon2(?:id|i|d)\$/,
  /^\$2[aby]\$\d\d\$/,
];

export interface ForbiddenFinding {
  /** JSON pointer into the payload (contributor-owned key names only). */
  readonly pointer: string;
  readonly rule: 'forbidden_key' | 'forbidden_value';
}

function normalizedKey(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, '');
}

export function isForbiddenKey(key: string): boolean {
  const normalized = normalizedKey(key);
  return (
    FORBIDDEN_KEYS.has(normalized) ||
    FORBIDDEN_KEY_PREFIXES.some((prefix) => normalized.startsWith(prefix))
  );
}

/** First finding, or `undefined` when the payload is clean. Iterative: no recursion limit. */
export function scanForbiddenData(payload: unknown): ForbiddenFinding | undefined {
  const stack: { value: unknown; pointer: string }[] = [{ value: payload, pointer: '' }];
  while (stack.length > 0) {
    const { value, pointer } = stack.pop() as { value: unknown; pointer: string };
    if (typeof value === 'string') {
      if (FORBIDDEN_VALUE_PATTERNS.some((pattern) => pattern.test(value))) {
        return { pointer, rule: 'forbidden_value' };
      }
    } else if (Array.isArray(value)) {
      value.forEach((item, index) => {
        stack.push({ value: item, pointer: `${pointer}/${index}` });
      });
    } else if (value !== null && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        const childPointer = `${pointer}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`;
        if (isForbiddenKey(key)) return { pointer: childPointer, rule: 'forbidden_key' };
        stack.push({ value: child, pointer: childPointer });
      }
    }
  }
  return undefined;
}
