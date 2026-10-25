import { currencyMinorUnits } from '@app-health/contracts';
/** Format integer minor units without losing cents at the safe-integer boundary. */
export function formatPaymentMinor(amount: number, currency: string): string {
  if (!Number.isSafeInteger(amount)) return '—';
  if (!Object.hasOwn(currencyMinorUnits, currency))
    return `${amount.toLocaleString('en-US')} minor ${currency}`;
  const digits = currencyMinorUnits[currency];
  const formatter = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  const scale = 10n ** BigInt(digits);
  const absolute = BigInt(amount < 0 ? -amount : amount);
  const whole = absolute / scale;
  const fraction = (absolute % scale).toString().padStart(digits, '0');
  const signed = amount < 0 ? (whole === 0n ? -0 : -whole) : whole;
  return formatter
    .formatToParts(signed)
    .map((part) => (part.type === 'fraction' ? fraction : part.value))
    .join('');
}

export function averagePayment(gross: number, payments: number, currency: string): string {
  if (!payments) return '—';
  // Nearest minor unit, calculated in integers before formatting.
  const rounded = (BigInt(gross) + BigInt(payments) / 2n) / BigInt(payments);
  return formatPaymentMinor(Number(rounded), currency);
}
