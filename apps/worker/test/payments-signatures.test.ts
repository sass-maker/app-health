import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  verifyStandardPaymentSignature,
  verifyStripePaymentSignature,
} from '../src/payments-signatures.js';

const now = 1_800_000_000_000;
const timestamp = String(now / 1000);
const body = new TextEncoder().encode('{ "kind": "payment" }');
const stripeSecret = 'whsec_endpoint_secret';
const keyBytes = Buffer.from('standard-signing-key');
const standardSecret = `whsec_${keyBytes.toString('base64')}`;

function stripeSignature(secret = stripeSecret, data = body, time = timestamp) {
  const digest = createHmac('sha256', secret).update(`${time}.`).update(data).digest('hex');
  return `t=${time},v1=${digest}`;
}
function standardSignature(key = keyBytes, data = body, id = 'msg-1', time = timestamp) {
  return 'v1,' + createHmac('sha256', key).update(`${id}.${time}.`).update(data).digest('base64');
}
const stripe = { now, body, signature: stripeSignature(), secrets: [stripeSecret] };
const standard = {
  now,
  body,
  id: 'msg-1',
  timestamp,
  signature: standardSignature(),
  secrets: [{ value: standardSecret, scheme: 'standard' as const }],
};

describe('Stripe payment signature validation', () => {
  it('verifies exact raw bytes and rotated secrets/signatures through platform constant-time HMAC comparison', async () => {
    expect(await verifyStripePaymentSignature(stripe)).toBe(true);
    const verify = vi.spyOn(crypto.subtle, 'verify');
    try {
      const other = stripeSignature('old').split(',')[1];
      expect(
        await verifyStripePaymentSignature({
          ...stripe,
          signature: `${stripe.signature},${other}`,
          secrets: [stripeSecret, 'old'],
        }),
      ).toBe(true);
      expect(verify).toHaveBeenCalledTimes(4); // all key/signature combinations, no prefix comparison or early match exit
    } finally {
      verify.mockRestore();
    }
    const binary = Uint8Array.from([0, 255, 192, 128]);
    expect(
      await verifyStripePaymentSignature({
        ...stripe,
        body: binary,
        signature: stripeSignature(stripeSecret, binary),
      }),
    ).toBe(true);
  });
  it('rejects altered bytes, incorrect digests, missing/duplicate/malformed timestamps and stale/future deliveries', async () => {
    for (const patch of [
      { body: new TextEncoder().encode('{}') },
      { signature: stripe.signature.replace('v1=', 'v0=') },
      { signature: 'v1=' + '0'.repeat(64) },
      { signature: `t=${timestamp},v1=bad` },
      { signature: stripe.signature + `,t=${timestamp}` },
      { signature: 't=no,v1=' + '0'.repeat(64) },
      { now: now + 300001 },
      { now: now - 300001 },
      { now: NaN },
    ])
      expect(await verifyStripePaymentSignature({ ...stripe, ...patch })).toBe(false);
    expect(await verifyStripePaymentSignature({ ...stripe, now: now + 300000 })).toBe(true);
  });
  it('bounds raw body, headers, secret rotation and signature count', async () => {
    for (const patch of [
      { body: new Uint8Array(262145) },
      { signature: 'x'.repeat(8193) },
      { secrets: [] },
      { secrets: Array(5).fill(stripeSecret) },
      { secrets: [''] },
      { secrets: ['x'.repeat(1025)] },
      { signature: `t=${timestamp},` + Array(17).fill(stripe.signature.split(',')[1]).join(',') },
    ])
      expect(await verifyStripePaymentSignature({ ...stripe, ...patch })).toBe(false);
  });
});

describe('Dodo and Polar Standard Webhooks signature validation', () => {
  it('accepts current Standard Webhooks, bare base64 keys, secret rotation and explicit legacy Polar keys', async () => {
    expect(await verifyStandardPaymentSignature(standard)).toBe(true);
    expect(
      await verifyStandardPaymentSignature({
        ...standard,
        secrets: [{ value: keyBytes.toString('base64'), scheme: 'standard' }],
      }),
    ).toBe(true);
    expect(
      await verifyStandardPaymentSignature({
        ...standard,
        signature: 'v1,' + 'A'.repeat(44) + ' ' + standard.signature,
        secrets: [
          { value: 'whsec_' + Buffer.from('old').toString('base64'), scheme: 'standard' },
          ...standard.secrets,
        ],
      }),
    ).toBe(true);
    const legacy = 'whsec_polar_legacy_full_utf8_secret';
    const signature = standardSignature(Buffer.from(legacy));
    expect(
      await verifyStandardPaymentSignature({
        ...standard,
        signature,
        secrets: [{ value: legacy, scheme: 'polar_legacy' }],
      }),
    ).toBe(true);
    expect(
      await verifyStandardPaymentSignature({
        ...standard,
        signature,
        secrets: [{ value: legacy, scheme: 'standard' }],
      }),
    ).toBe(false);
  });
  it('rejects replay, changed IDs/timestamps/raw bytes, malformed keys and signatures', async () => {
    for (const patch of [
      { id: 'different' },
      { id: '' },
      { timestamp: 'bad' },
      { timestamp: timestamp + '9' },
      { now: now + 300001 },
      { now: now - 300001 },
      { body: new TextEncoder().encode('{}') },
      { signature: 'v0,' + standard.signature.slice(3) },
      { signature: 'v1,?' },
      { signature: 'v1,A' },
      { signature: 'v1,AAA=' },
      { secrets: [{ value: '', scheme: 'standard' as const }] },
      { secrets: [{ value: 'whsec_?', scheme: 'standard' as const }] },
      { secrets: [{ value: 'x'.repeat(1025), scheme: 'polar_legacy' as const }] },
      { secrets: [{ value: 'whsec_A', scheme: 'standard' as const }] },
      { secrets: [{ value: 'whsec_AA==', scheme: 'standard' as const }] },
    ])
      expect(await verifyStandardPaymentSignature({ ...standard, ...patch })).toBe(false);
    expect(
      await verifyStandardPaymentSignature({ ...standard, body: new Uint8Array(262145) }),
    ).toBe(false);
    expect(
      await verifyStandardPaymentSignature({
        ...standard,
        signature: Array(17).fill(standard.signature).join(' '),
      }),
    ).toBe(false);
  });
});
