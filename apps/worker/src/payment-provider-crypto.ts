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
function aad(scope: Scope, keyId: string) {
  return encoder.encode(
    JSON.stringify([
      'app-health/provider-secret/v2',
      keyId,
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
type Keyring = { v: 1; active: string; keys: Array<{ id: string; key: string }> };
function validKeyEntry(entry: { id: string; key: string }) {
  return (
    typeof entry.id === 'string' &&
    typeof entry.key === 'string' &&
    /^[a-zA-Z0-9_-]{1,32}$/.test(entry.id) &&
    Object.keys(entry).sort().join(',') === 'id,key' &&
    /^[A-Za-z0-9+/]{43}=$/.test(entry.key) &&
    atob(entry.key).length === 32
  );
}
function parseKeyring(source: string): Keyring {
  try {
    if (!source || source.length > 4096) throw new Error();
    const ring = JSON.parse(source) as Keyring;
    if (
      ring.v !== 1 ||
      !Array.isArray(ring.keys) ||
      !ring.keys.length ||
      ring.keys.length > 3 ||
      Object.keys(ring).sort().join(',') !== 'active,keys,v'
    )
      throw new Error();
    const ids = new Set<string>();
    for (const entry of ring.keys) {
      if (!validKeyEntry(entry) || ids.has(entry.id)) throw new Error();
      ids.add(entry.id);
    }
    if (typeof ring.active !== 'string' || !ids.has(ring.active)) throw new Error();
    return ring;
  } catch {
    throw new ProviderError('provider_encryption_keyring_unavailable', 503);
  }
}
export function validateProviderKeyring(source: string) {
  parseKeyring(source);
}
async function key(ring: Keyring, id: string) {
  const entry = ring.keys.find((entry) => entry.id === id);
  if (!entry) throw new ProviderError('provider_encryption_keyring_unavailable', 503);
  return crypto.subtle.importKey(
    'raw',
    Uint8Array.from(atob(entry.key), (c) => c.charCodeAt(0)),
    'AES-GCM',
    false,
    ['encrypt', 'decrypt'],
  );
}
function base64(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes));
}
export async function sealProviderCredentials(
  keyring: string,
  scope: Scope,
  credentials: PaymentCredentials,
): Promise<string> {
  const ring = parseKeyring(keyring);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = encoder.encode(JSON.stringify(PaymentCredentials.parse(credentials)));
  if (plaintext.length > 20000)
    throw new ProviderError('provider_credentials_exceed_encoded_limit');
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad(scope, ring.active) },
    await key(ring, ring.active),
    plaintext,
  );
  const envelope = JSON.stringify({
    v: 2,
    key_id: ring.active,
    iv: base64(iv),
    ciphertext: base64(new Uint8Array(encrypted)),
  });
  if (envelope.length > 32768) throw new ProviderError('provider_credentials_exceed_encoded_limit');
  return envelope;
}
export async function openProviderCredentials(
  keyring: string,
  scope: Scope,
  cipher: string | null,
): Promise<PaymentCredentials> {
  try {
    if (!cipher || cipher.length > 32768) throw new Error();
    const envelope = JSON.parse(cipher);
    if (envelope.v !== 2 || typeof envelope.key_id !== 'string') throw new Error();
    const ring = parseKeyring(keyring);
    const iv = Uint8Array.from(atob(envelope.iv), (c) => c.charCodeAt(0));
    const ciphertext = Uint8Array.from(atob(envelope.ciphertext), (c) => c.charCodeAt(0));
    if (iv.length !== 12) throw new Error();
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: aad(scope, envelope.key_id) },
      await key(ring, envelope.key_id),
      ciphertext,
    );
    return PaymentCredentials.parse(JSON.parse(new TextDecoder().decode(plaintext)));
  } catch {
    throw new ProviderError('provider_credentials_unavailable_replace_them', 503);
  }
}
