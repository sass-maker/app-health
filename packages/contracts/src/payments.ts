import { z } from 'zod';

const scopeId = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const factId = z.string().regex(/^[a-zA-Z0-9_.:-]{1,128}$/);
const timestamp = z.number().int().min(0).max(8_640_000_000_000_000);
const amount = z.number().int().min(0).max(1_000_000_000_000);
const safeCount = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const safeAmount = z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
const tag = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-zA-Z0-9 _.,:+/-]*$/);

export const PaymentScopeV1 = z.object({ app_id: scopeId, environment_id: scopeId }).strict();
export type PaymentScopeV1 = z.infer<typeof PaymentScopeV1>;

export const PaymentNamespaceV1 = z
  .object({
    provider: z.enum(['custom', 'stripe', 'polar', 'dodo']),
    account_id: factId,
    mode: z.enum(['live', 'test']),
  })
  .strict();
export type PaymentNamespaceV1 = z.infer<typeof PaymentNamespaceV1>;

/** Explicit financial attribution facts, never request data or customer identity. */
export const PaymentAttributionV1 = z
  .object({
    source: tag.optional(),
    page: z
      .string()
      .startsWith('/')
      .max(256)
      .regex(/^[^?#@\\\s]*$/)
      .optional(),
    country: z
      .string()
      .regex(/^[A-Z]{2}$/)
      .optional(),
    campaign: tag.optional(),
  })
  .strict();

const factFields = {
  transaction_id: factId,
  occurred_at: timestamp,
  amount_minor: amount,
  currency: z.string().regex(/^[A-Z]{3}$/),
};
export const PaymentFactV1 = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('payment'),
      ...factFields,
      attribution: PaymentAttributionV1.default({}),
    })
    .strict(),
  z
    .object({
      kind: z.literal('refund'),
      ...factFields,
      amount_minor: amount.min(1),
      refund_id: factId,
    })
    .strict(),
]);
export type PaymentFactV1 = z.infer<typeof PaymentFactV1>;

export const PaymentIngestV1 = PaymentScopeV1.extend({
  schema_version: z.literal(1),
  namespace: PaymentNamespaceV1,
  delivery_id: factId,
  fact: PaymentFactV1,
}).strict();
export type PaymentIngestV1 = z.infer<typeof PaymentIngestV1>;

export const PaymentReceiptV1 = z
  .object({ schema_version: z.literal(1), recorded: z.boolean(), duplicate: z.boolean() })
  .strict();

export const RevenueQueryV1 = PaymentScopeV1.extend({
  from: z.coerce.number().int().nonnegative().max(8_640_000_000_000_000),
  to: z.coerce.number().int().nonnegative().max(8_640_000_000_000_000),
  mode: z.enum(['live', 'test']).optional(),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .optional(),
  provider: PaymentNamespaceV1.shape.provider.optional(),
  account_id: factId.optional(),
  breakdown: z.enum(['source', 'page', 'country', 'campaign']).default('source'),
})
  .strict()
  .refine((query) => query.to > query.from && query.to - query.from <= 366 * 86_400_000, {
    message: 'Choose a nonempty period of at most 366 days.',
  });
export type RevenueQueryV1 = z.infer<typeof RevenueQueryV1>;

export const RevenueTotalV1 = PaymentNamespaceV1.extend({
  currency: z.string().regex(/^[A-Z]{3}$/),
  gross_minor: safeCount,
  refunds_minor: safeCount,
  net_minor: safeAmount,
  payments: safeCount,
  refunds: safeCount,
  attributed_payments: safeCount,
  pending_refunds: safeCount,
  pending_refunds_minor: safeCount,
}).strict();
export type RevenueTotalV1 = z.infer<typeof RevenueTotalV1>;

export const RevenueReportV1 = z
  .object({
    schema_version: z.literal(1),
    from: timestamp,
    to: timestamp,
    source: z.enum(['local', 'd1']),
    basis: z.literal('recorded_cashflows'),
    coverage_note: z.string().max(600),
    breakdown: z.enum(['source', 'page', 'country', 'campaign']),
    totals: z.array(RevenueTotalV1).max(200),
    dimensions: z.array(RevenueTotalV1.extend({ value: z.string().max(256).nullable() })).max(500),
  })
  .strict();
export type RevenueReportV1 = z.infer<typeof RevenueReportV1>;
