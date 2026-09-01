const OPAQUE_CREDENTIAL_BYTES = 32;

export function generateOpaqueCredential(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(OPAQUE_CREDENTIAL_BYTES))).toString(
    'base64url',
  );
}

export async function digestOpaqueCredential(credential: string): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(credential)),
  );
}
