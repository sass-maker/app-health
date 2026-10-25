import { PaymentCredentials, type PaymentConnection } from '@app-health/contracts';
import { ProviderError } from './payment-provider-model.js';

const encoder = new TextEncoder();
type Scope = Pick<
  PaymentConnection,
  | 'id'
  | 'app_id'
  | 'environment_id'
  | 'provider'
  | 'account_id'
  | 'mode'
  | 'generation'
  | 'selector'
> & { workspace_id: string };
function aad(scope: Scope) {
  return encoder.encode(
    JSON.stringify([
      'app-health/provider-secret/v1',
      scope.workspace_id,
      scope.id,
      scope.app_id,
      scope.environment_id,
      scope.provider,
      scope.account_id,
      scope.mode,
      scope.selector,
      scope.generation,
    ]),
  );
}
async function key(master: string) {
  if (master.length < 32) throw new ProviderError('provider_encryption_master_unavailable', 503);
  const material = await crypto.subtle.importKey('raw', encoder.encode(master), 'HKDF', false, [
    'deriveKey',
  ]);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: encoder.encode('app-health/provider-secrets/v1'),
      info: encoder.encode('AES-256-GCM'),
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}
function base64(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes));
}
export async function sealProviderCredentials(
  master: string,
  scope: Scope,
  credentials: PaymentCredentials,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = encoder.encode(JSON.stringify(PaymentCredentials.parse(credentials)));
  if (plaintext.length > 20000)
    throw new ProviderError('provider_credentials_exceed_encoded_limit');
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad(scope) },
    await key(master),
    plaintext,
  );
  const envelope = JSON.stringify({
    v: 1,
    iv: base64(iv),
    ciphertext: base64(new Uint8Array(encrypted)),
  });
  if (envelope.length > 32768) throw new ProviderError('provider_credentials_exceed_encoded_limit');
  return envelope;
}
export async function openProviderCredentials(
  master: string,
  scope: Scope,
  cipher: string | null,
): Promise<PaymentCredentials> {
  try {
    if (!cipher || cipher.length > 32768) throw new Error();
    const envelope = JSON.parse(cipher);
    if (envelope.v !== 1) throw new Error();
    const iv = Uint8Array.from(atob(envelope.iv), (c) => c.charCodeAt(0));
    const ciphertext = Uint8Array.from(atob(envelope.ciphertext), (c) => c.charCodeAt(0));
    if (iv.length !== 12) throw new Error();
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: aad(scope) },
      await key(master),
      ciphertext,
    );
    return PaymentCredentials.parse(JSON.parse(new TextDecoder().decode(plaintext)));
  } catch {
    throw new ProviderError('provider_credentials_unavailable_replace_them', 503);
  }
}
