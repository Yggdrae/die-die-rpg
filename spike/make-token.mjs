import { createHmac } from 'node:crypto';

/** Dev JWT for the spike. Secret is in powersync.yaml on purpose; all of this is deleted at the tag. */

const kB64Url = 'c3Bpa2Utc2VjcmV0LWtleS1mb3Itd2F2ZS16ZXJvLW9ubHktMzJieXRlcw';
const secret = Buffer.from(kB64Url, 'base64url');

const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');

const now = Math.floor(Date.now() / 1000);
const header = { alg: 'HS256', typ: 'JWT', kid: 'spike' };
const payload = {
  sub: process.argv[2] ?? 'spike-user',
  aud: 'powersync-spike',
  iat: now,
  exp: now + 60 * 60 * 12,
};

const signingInput = `${b64(header)}.${b64(payload)}`;
const signature = createHmac('sha256', secret).update(signingInput).digest('base64url');

console.log(`${signingInput}.${signature}`);
