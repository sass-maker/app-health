/**
 * Pure validators only: no provider connection or webhook route is activated.
 * Stripe signs timestamp.raw-body with its UTF-8 endpoint secret.
 * Standard Webhooks signs id.timestamp.raw-body with the decoded secret.
 * Polar secrets created before 2026-09-08 use the full UTF-8 secret instead.
 * Sources: docs.stripe.com/webhooks, standardwebhooks.com,
 * polar.sh/docs/integrate/webhooks/delivery,
 * docs.dodopayments.com/developer-resources/webhooks.
 */
interface SignatureInput {
  body: Uint8Array;
  now: number;
}

interface StripeSignatureInput extends SignatureInput {
  signature: string;
  secrets: readonly string[];
}

interface StandardSignatureInput extends SignatureInput {
  id: string;
  timestamp: string;
  signature: string;
  secrets: readonly { value: string; scheme: 'standard' | 'polar_legacy' }[];
}

const encoder = new TextEncoder();
const MAX_SIGNATURES = 16;
const TOLERANCE_MS = 300_000;

function recentTimestamp(value: string, now: number) {
  if (!/^\d{1,12}$/.test(value) || !Number.isFinite(now)) return false;
  return Math.abs(Number(value) * 1000 - now) <= TOLERANCE_MS;
}

function bounded(input: SignatureInput, header: string, secrets: readonly unknown[]) {
  return (
    input.body.byteLength <= 262144 &&
    header.length <= 8192 &&
    secrets.length > 0 &&
    secrets.length <= 4
  );
}

function signedBytes(prefix: string, body: Uint8Array) {
  const start = encoder.encode(prefix);
  const result = new Uint8Array(start.length + body.length);
  result.set(start);
  result.set(body, start.length);
  return result;
}

function decodeBase64(value: string) {
  if (!/^[a-zA-Z0-9+/]+={0,2}$/.test(value)) return null;
  try {
    return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function decodeHex(value: string) {
  if (!/^[a-fA-F0-9]{64}$/.test(value)) return null;
  return Uint8Array.from(value.match(/../g)!, (pair) => Number.parseInt(pair, 16));
}

async function verifies(keyBytes: Uint8Array, signature: Uint8Array, payload: Uint8Array) {
  if (!keyBytes.length || signature.length !== 32) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  // The platform's HMAC verify performs the signature comparison, rather than
  // a JavaScript string comparison that can leak the matching prefix.
  return crypto.subtle.verify('HMAC', key, signature, payload);
}

async function rotatedSignatures(
  keys: Uint8Array[],
  signatures: Uint8Array[],
  payload: Uint8Array,
) {
  if (signatures.length > MAX_SIGNATURES) return false;
  const results = await Promise.all(
    keys.flatMap((key) => signatures.map((signature) => verifies(key, signature, payload))),
  );
  return results.some(Boolean);
}

export async function verifyStripePaymentSignature(input: StripeSignatureInput): Promise<boolean> {
  if (!bounded(input, input.signature, input.secrets)) return false;
  const pieces = input.signature.split(',').map((piece) => piece.trim().split('='));
  const timestamps = pieces.filter(([key]) => key === 't');
  if (timestamps.length !== 1 || !recentTimestamp(timestamps[0][1] ?? '', input.now)) return false;
  const signatures = pieces
    .filter(([key]) => key === 'v1')
    .map(([, value]) => decodeHex(value ?? ''))
    .filter((value) => value !== null);
  const secrets = input.secrets
    .filter((secret) => secret.length > 0 && secret.length <= 1024)
    .map((secret) => encoder.encode(secret));
  return rotatedSignatures(secrets, signatures, signedBytes(`${timestamps[0][1]}.`, input.body));
}

function standardSecret(secret: StandardSignatureInput['secrets'][number]) {
  if (!secret.value.length || secret.value.length > 1024) return null;
  if (secret.scheme === 'polar_legacy') return encoder.encode(secret.value);
  return decodeBase64(secret.value.replace(/^whsec_/, ''));
}

export async function verifyStandardPaymentSignature(
  input: StandardSignatureInput,
): Promise<boolean> {
  if (!bounded(input, input.signature, input.secrets) || !/^[a-zA-Z0-9_.:-]{1,200}$/.test(input.id))
    return false;
  if (!recentTimestamp(input.timestamp, input.now)) return false;
  const signatures = input.signature
    .split(/\s+/)
    .filter((piece) => piece.startsWith('v1,'))
    .map((piece) => decodeBase64(piece.slice(3)))
    .filter((value) => value !== null);
  const secrets = input.secrets.map(standardSecret).filter((value) => value !== null);
  return rotatedSignatures(
    secrets,
    signatures,
    signedBytes(`${input.id}.${input.timestamp}.`, input.body),
  );
}
