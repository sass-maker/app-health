import { expect, it } from 'vitest';
import { formatPaymentMinor } from '../src/lib/payment-format.js';

it('uses ISO minor units independently of currency display defaults', () => {
  expect(formatPaymentMinor(12345, 'HUF')).toContain('123.45');
  expect(formatPaymentMinor(12345, 'IDR')).toContain('123.45');
  expect(formatPaymentMinor(12345, 'IQD')).toContain('12.345');
  expect(formatPaymentMinor(12345, 'JPY')).toContain('12,345');
  expect(formatPaymentMinor(12345, 'CLF')).toContain('1.2345');
  expect(formatPaymentMinor(12345, 'UYW')).toContain('1.2345');
  expect(formatPaymentMinor(12345, 'XXX')).toBe('12,345 minor XXX');
  expect(formatPaymentMinor(12345, 'ZZZ')).toBe('12,345 minor ZZZ');
});
